/**
 * Gesture calibration stage (spatial screen): personalizes BeatDrop's gestures, using
 * Perceptron AI (DubHacks Perception track) to check each demonstration.
 *
 * For each gesture the user demonstrates for a few seconds. MediaPipe records the hand
 * measurements locally; Perceptron's Mk1.5 model finds *when* in the demonstration the
 * gesture was actually performed (video event finding, cross-checked per frame). Only
 * MediaPipe data from inside those moments is used:
 *   - OPEN + FIST -> the personal grab model (existing k-NN classifier)
 *   - LIFT        -> a personal threshold for the build/drop lift pose
 * A demo Perceptron rejects gets feedback and a retry. Perceptron never sets thresholds,
 * and the stage is optional: skip it, or calibrate locally without uploading anything.
 */

import { DEFAULT_GESTURE_CONFIG } from '../perception/gestures';
import type { GrabClassifier, GrabLabel } from '../perception/grabClassifier';
import type { HandState, PerceptionFrame } from '../perception/types';
import {
  ClipRecorder,
  findSegments,
  inRanges,
  perceptronAvailable,
  rangesSeconds,
  type CalibrationGesture,
  type Range,
} from './perceptronCalibration';

interface StepDef {
  key: CalibrationGesture;
  title: string;
  /** What Perceptron should have seen, for feedback ("saw a fist for 2.6 s"). */
  noun: string;
  /** Bare form for "saw no fist" / "saw only 0.8 s of lift pose". */
  bare: string;
  instruction: string;
  /** Grab-model label for MediaPipe samples recorded during this step. */
  label: GrabLabel | null;
}

export const STEPS: StepDef[] = [
  { key: 'open', title: 'OPEN HAND', noun: 'an open hand', bare: 'open hand', label: 0,
    instruction: 'Show your hand open and relaxed. Move it around a little.' },
  { key: 'fist', title: 'FIST', noun: 'a fist', bare: 'fist', label: 1,
    instruction: 'Close your hand into a fist and hold it. Move it around a little.' },
  { key: 'lift', title: 'LIFT (build / drop)', noun: 'the lift pose', bare: 'lift pose', label: null,
    instruction: 'Turn your hand over and bunch your fingertips together, pointing down,\nlike holding something up by a string.' },
];

const HAND_STEADY_MS = 600;
const COUNTDOWN_MS = 2400;
const RECORD_MS = 4000;
/** A demo needs at least this much confirmed gesture time. */
const MIN_CONFIRMED_SEC = 1.2;
const RESULT_MS = 1600;
const SUMMARY_MS = 10_000;
/** Lift ratio fed when the hand isn't pointing down (see gestures.ts NOT_LIFT = 1.5). */
const LIFT_POINTING_DOWN_BELOW = 1.4;
/** Enough confirmed lift frames to set a personal threshold. */
const MIN_LIFT_FRAMES = 8;

type Phase =
  | { kind: 'closed' }
  | { kind: 'offer'; perceptron: boolean }
  | { kind: 'ready'; handSince: number | null }
  | { kind: 'countdown'; since: number }
  | { kind: 'recording'; since: number }
  | { kind: 'checking' }
  | { kind: 'result'; since: number; ok: boolean; text: string }
  | { kind: 'summary'; since: number; lines: string[] };

/** Per-frame measurements of the main hand while recording (MediaPipe, local). */
export interface FrameStat {
  step: CalibrationGesture;
  t: number;
  /** Fist measure (lower = more closed); the default rule engages below grip.on. */
  grip: number;
  /** Lift measure (lower = more bunched); >= 1.4 when not pointing down. */
  lift: number;
}

export interface StageDeps {
  video: HTMLVideoElement;
  gestures: {
    collect(label: GrabLabel | null): void;
    finishCalibration(keep?: (s: { label: GrabLabel; t: number }) => boolean): GrabClassifier;
    setLiftThresholds(t: { on: number; off: number }): void;
  };
  /** Persist a trained grab model. */
  saveGrab(c: GrabClassifier): void;
  /** Persist personal lift thresholds. */
  saveLift(t: { on: number; off: number }): void;
  /** Called when the stage closes (finished, skipped or cancelled). */
  onClose?(): void;
  /** Frame recorder (tests inject a fake one). */
  recorder?: Pick<ClipRecorder, 'begin' | 'capture' | 'take'>;
}

export class CalibrationStage {
  phase: Phase = { kind: 'closed' };
  private step = 0;
  private usePerceptron = false;
  private readonly recorder: Pick<ClipRecorder, 'begin' | 'capture' | 'take'>;
  private stats: FrameStat[] = [];
  private confirmed: Partial<Record<CalibrationGesture, { ranges: Range[]; checked: boolean }>> = {};
  /** Notes about checks that couldn't run, for the summary. */
  private fallbacks = 0;
  /** Latest frame time; the stage runs on the frame clock. */
  private now = 0;
  /** Bumped on every begin/close, so a late Perceptron answer can't revive a closed stage. */
  private run = 0;

  constructor(private readonly deps: StageDeps) {
    this.recorder = deps.recorder ?? new ClipRecorder(deps.video);
  }

  get active(): boolean {
    return this.phase.kind !== 'closed';
  }

  /** Show the offer screen (asks for consent before anything is uploaded). */
  async open(): Promise<void> {
    if (this.active) return;
    this.phase = { kind: 'offer', perceptron: false };
    const ok = await perceptronAvailable();
    if (this.phase.kind === 'offer') this.phase = { kind: 'offer', perceptron: ok };
  }

  /** Returns true if the stage used the key. */
  handleKey(key: string, now: number): boolean {
    const p = this.phase;
    if (p.kind === 'closed') return false;
    if (key === 'escape') {
      this.close();
      return true;
    }
    if (p.kind === 'offer') {
      if (key === 'y' && p.perceptron) this.begin(true);
      else if (key === 'l' || (key === 'y' && !p.perceptron)) this.begin(false);
      else if (key === 'n') this.close();
      return true;
    }
    if (p.kind === 'result' && !p.ok) {
      if (key === 'r') this.enterReady();
      else if (key === 's') this.next(now);
      return true;
    }
    if (p.kind === 'summary') {
      this.close();
      return true;
    }
    return true; // swallow other keys while calibrating
  }

  /** Drive the stage from each perception frame. */
  update(frame: PerceptionFrame): void {
    const p = this.phase;
    const now = (this.now = frame.timestamp);
    const hand = mainHand(frame.hands);
    switch (p.kind) {
      case 'ready':
        if (!hand) p.handSince = null;
        else if (p.handSince === null) p.handSince = now;
        else if (now - p.handSince >= HAND_STEADY_MS) this.phase = { kind: 'countdown', since: now };
        break;
      case 'countdown':
        if (now - p.since >= COUNTDOWN_MS) {
          this.recorder.begin(now);
          this.deps.gestures.collect(STEPS[this.step]!.label);
          this.phase = { kind: 'recording', since: now };
        }
        break;
      case 'recording':
        this.recorder.capture(now);
        if (hand) this.stats.push({ step: STEPS[this.step]!.key, t: now, grip: hand.grip.ratio, lift: hand.lift?.ratio ?? 2 });
        if (now - p.since >= RECORD_MS) {
          this.deps.gestures.collect(null);
          void this.check(now);
        }
        break;
      case 'result':
        if (p.ok && now - p.since >= RESULT_MS) this.next(now);
        break;
      case 'summary':
        if (now - p.since >= SUMMARY_MS) this.close();
        break;
    }
  }

  /** What the big banner should show right now. */
  banner(now: number): { title: string; detail: string } | null {
    const p = this.phase;
    const s = STEPS[this.step]!;
    const progress = `Step ${this.step + 1} of ${STEPS.length}`;
    switch (p.kind) {
      case 'closed':
        return null;
      case 'offer':
        return p.perceptron
          ? { title: 'Calibrate your gestures?', detail:
              'About 30 s: show an open hand, a fist and the lift pose. Perceptron AI checks each demo\n' +
              'so BeatDrop learns from good examples only (short webcam clips, used once, never stored).\n' +
              'Y = calibrate with Perceptron   ·   L = calibrate locally (no upload)   ·   N = skip' }
          : { title: 'Calibrate your gestures?', detail:
              'About 30 s: show an open hand, a fist and the lift pose.\n' +
              '(Perceptron check offline: calibrating on this computer only.)\nY = calibrate   ·   N = skip' };
      case 'ready':
        return { title: s.title, detail: `${progress}  ·  ${s.instruction}\n${p.handSince === null ? 'Show your hand to the camera…' : 'Hold it…'}` };
      case 'countdown':
        return { title: `${s.title}  ${Math.ceil((COUNTDOWN_MS - (now - p.since)) / 800)}`, detail: `${progress}  ·  ${s.instruction}\nGet ready…` };
      case 'recording':
        return { title: `● ${s.title}`, detail: `${progress}  ·  ${s.instruction}\nRecording ${((RECORD_MS - (now - p.since)) / 1000).toFixed(1)}s` };
      case 'checking':
        return { title: 'Checking…', detail: `Perceptron AI is finding when you showed ${s.noun}` };
      case 'result':
        return { title: p.ok ? '✓' : '✗', detail: p.text };
      case 'summary':
        return { title: 'Gestures calibrated', detail: `${p.lines.join('\n')}\nAny key to continue` };
    }
  }

  // ---------------------------------------------------------------------------

  private begin(perceptron: boolean): void {
    this.usePerceptron = perceptron;
    this.run++;
    this.step = 0;
    this.stats = [];
    this.confirmed = {};
    this.fallbacks = 0;
    this.deps.gestures.collect(null);
    this.enterReady();
  }

  private enterReady(): void {
    this.phase = { kind: 'ready', handSince: null };
  }

  private async check(now: number): Promise<void> {
    const s = STEPS[this.step]!;
    const clip = this.recorder.take();
    const whole: Range[] = clip.frames.length ? [[clip.origin, clip.origin + clip.frames.at(-1)!.t]] : [];
    if (!this.usePerceptron) {
      this.accept(s.key, whole, false, now, `Recorded ${s.noun} (not checked: local calibration)`);
      return;
    }
    this.phase = { kind: 'checking' };
    const run = this.run;
    const result = await findSegments(s.key, clip);
    if (run !== this.run || this.phase.kind !== 'checking') return; // closed meanwhile
    const t = this.now;
    if (!result.ok) {
      // Perceptron unavailable: fall back to the whole demo, as calibration did before.
      console.warn('[calibration] Perceptron check failed:', result.error);
      this.fallbacks++;
      this.accept(s.key, whole, false, t, `Recorded ${s.noun} (Perceptron unavailable, not checked)`);
      return;
    }
    console.info(`[calibration] ${s.key}: Perceptron confirmed`, result.ranges.map(([a, b]) => `${((a - clip.origin) / 1000).toFixed(1)}–${((b - clip.origin) / 1000).toFixed(1)}s`), 'poses:', result.poses.join(' '));
    const held = rangesSeconds(result.ranges);
    if (held >= MIN_CONFIRMED_SEC) {
      this.accept(s.key, result.ranges, true, t, `Perceptron saw ${s.noun} for ${held.toFixed(1)} s of ${(RECORD_MS / 1000).toFixed(0)} s`);
    } else {
      const seen = held > 0 ? `only ${held.toFixed(1)} s of` : 'no';
      this.phase = { kind: 'result', since: t, ok: false, text:
        `Perceptron saw ${seen} ${s.bare} in that demo.\n${s.instruction}\nR = try again   ·   S = skip this gesture` };
    }
  }

  private accept(key: CalibrationGesture, ranges: Range[], checked: boolean, now: number, text: string): void {
    this.confirmed[key] = { ranges, checked };
    this.phase = { kind: 'result', since: now, ok: true, text };
  }

  private next(now: number): void {
    this.step++;
    if (this.step < STEPS.length) this.enterReady();
    else this.finish(now);
  }

  private finish(now: number): void {
    const lines: string[] = [];
    const { open, fist, lift } = this.confirmed;

    // Grab: train only on MediaPipe samples inside the confirmed moments.
    if (open && fist) {
      const c = this.deps.gestures.finishCalibration((s) => inRanges(s.label === 0 ? open.ranges : fist.ranges, s.t));
      if (c.ready) {
        this.deps.saveGrab(c);
        lines.push(`Grab ✓  personal model from ${c.counts.grab} fist + ${c.counts.open} open samples.${gripReport(this.stats, open.ranges, fist.ranges)}`);
      } else {
        lines.push('Grab ✗  not enough hand samples; kept your previous setting');
      }
    } else {
      this.deps.gestures.finishCalibration(() => false); // discard; keeps the previous model
      lines.push('Grab skipped  (kept your previous setting)');
    }

    // Lift: personal threshold from the bunching measured in the confirmed moments.
    const liftLine = lift ? this.calibrateLift(lift.ranges) : null;
    lines.push(liftLine ?? 'Build/drop skipped  (kept the default lift threshold)');

    const checked = Object.values(this.confirmed).filter((c) => c?.checked).length;
    if (this.usePerceptron) {
      lines.push(this.fallbacks
        ? `Perceptron checked ${checked} of ${Object.keys(this.confirmed).length} demos (${this.fallbacks} unavailable, used as recorded)`
        : `Perceptron AI checked every demo: only confirmed moments were used`);
    }
    this.phase = { kind: 'summary', since: now, lines };
  }

  private calibrateLift(ranges: Range[]): string | null {
    const values = this.stats
      .filter((s) => s.step === 'lift' && inRanges(ranges, s.t) && s.lift < LIFT_POINTING_DOWN_BELOW)
      .map((s) => s.lift);
    if (values.length < MIN_LIFT_FRAMES) return 'Build/drop ✗  hand wasn\'t pointing down long enough; kept the default';
    const t = liftThresholds(values);
    this.deps.gestures.setLiftThresholds(t);
    this.deps.saveLift(t);
    const before = share(values, (v) => v < DEFAULT_GESTURE_CONFIG.lift.on);
    const after = share(values, (v) => v < t.on);
    return `Build/drop ✓  lift threshold ${DEFAULT_GESTURE_CONFIG.lift.on.toFixed(2)} → ${t.on.toFixed(2)}: ` +
      `the default caught ${pct(before)} of your lift frames, yours catches ${pct(after)}`;
  }

  private close(): void {
    const wasActive = this.active;
    this.run++;
    this.deps.gestures.collect(null);
    this.phase = { kind: 'closed' };
    if (wasActive) this.deps.onClose?.();
  }
}

// --------------------------------------------------------------------------- helpers

/** The hand to measure: the most confident tracked one. */
function mainHand(hands: HandState[]): HandState | null {
  let best: HandState | null = null;
  for (const h of hands) if (h.tracked && (!best || h.confidence > best.confidence)) best = h;
  return best;
}

/**
 * Personal lift thresholds from confirmed lift-pose measurements: engage a little above
 * the user's 90th-percentile bunch (so nearly all of their real lifts engage), release
 * 0.25 higher, as the default does. Bounded so it stays a deliberate pose.
 */
export function liftThresholds(values: number[]): { on: number; off: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]!;
  const on = Math.min(0.95, Math.max(0.35, p90 + 0.05));
  return { on: round2(on), off: round2(Math.min(1.3, on + 0.25)) };
}

/** How the default fist rule did on the confirmed demo frames (before calibration). */
function gripReport(stats: FrameStat[], open: Range[], fist: Range[]): string {
  const on = DEFAULT_GESTURE_CONFIG.grip.on;
  const fists = stats.filter((s) => s.step === 'fist' && inRanges(fist, s.t)).map((s) => s.grip);
  const opens = stats.filter((s) => s.step === 'open' && inRanges(open, s.t)).map((s) => s.grip);
  if (!fists.length || !opens.length) return '';
  return `\n      The default fist rule caught ${pct(share(fists, (g) => g < on))} of your fist frames ` +
    `and misfired on ${pct(share(opens, (g) => g < on))} of your open-hand frames`;
}

function share(values: number[], test: (v: number) => boolean): number {
  return values.length ? values.filter(test).length / values.length : 0;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const round2 = (x: number) => Math.round(x * 100) / 100;
