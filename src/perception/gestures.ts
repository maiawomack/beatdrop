import { aspectDistance } from './coords';
import { FINGERTIPS, LM, PALM_POINTS } from './landmarks';
import { GrabClassifier, handFeatures, type GrabLabel } from './grabClassifier';
import { OneEuroFilter } from './oneEuroFilter';
import type { GesturePhase, GestureState, HandId, HandState, Landmark, Point2, RawHand } from './types';

export interface ThresholdConfig {
  /** Gesture engages when ratio drops below this... */
  on: number;
  /** ...and releases only when it rises above this (hysteresis). */
  off: number;
  /** Typical ratio of a relaxed open hand; used only for the strength readout. */
  open: number;
  /**
   * ...or once it opens this much past its tightest point during the grab.
   * Releasing then only needs a small opening, wherever the grab started.
   */
  release: number;
}

export interface GestureConfig {
  pinch: ThresholdConfig;
  grip: ThresholdConfig;
  /** Lift pose: ratio = fingertip bunch (thumb/index/middle spread / palm length) while pointing down. */
  lift: ThresholdConfig;
  /** Open palm: ratio = 2 - grip ratio, so a wide-open hand is low (engaged) and a fist is high. */
  palm: ThresholdConfig;
  /** Two fingers up: ratio = 0.5 + how far the pose is from the V shape (below 0.5 = clearly a V). */
  twoUp: ThresholdConfig;
  /** If true, a pinch also counts as a grab (otherwise only a closed-hand grip does). */
  grabIncludesPinch: boolean;
  /** Consecutive frames below `on` required to engage. */
  startFrames: number;
  /** Keep a lost, idle hand alive this long (ms). */
  lostGraceMs: number;
  /** Keep a lost hand that is mid-grab alive longer, so dropouts don't drop objects (ms). */
  heldGraceMs: number;
  /** EMA weight for ratios (1 = no smoothing). */
  ratioAlpha: number;
  pointMinCutoff: number;
  pointBeta: number;
  /** Anchor is smoothed a bit more: it drives held objects, where steadiness matters. */
  anchorMinCutoff: number;
  anchorBeta: number;
}

export const DEFAULT_GESTURE_CONFIG: GestureConfig = {
  pinch: { on: 0.3, off: 0.45, open: 0.9, release: 0.1 },
  grip: { on: 0.55, off: 0.65, open: 1.0, release: 0.1 },
  lift: { on: 0.55, off: 0.8, open: 1.2, release: 0.3 },
  // Open hand ~1.3 grip ratio (0.7 here), fingers together ~1.15, relaxed ~1.0, fist ~0.45:
  // engage above 1.0, let go below 0.85. No relative release: moving the hand shouldn't drop it.
  palm: { on: 1.0, off: 1.15, open: 1.5, release: 1 },
  twoUp: { on: 0.5, off: 0.68, open: 1.2, release: 1 },
  grabIncludesPinch: false,
  startFrames: 2,
  lostGraceMs: 150,
  heldGraceMs: 400,
  ratioAlpha: 0.6,
  pointMinCutoff: 1.0,
  pointBeta: 5.0,
  anchorMinCutoff: 0.7,
  anchorBeta: 4.0,
};

/** Hands labeled differently from a recent track this close (view-height units) are the same hand. */
const RELABEL_DISTANCE = 0.15;
/** A track counts as recent for relabeling within this window (ms). */
const RELABEL_WINDOW_MS = 300;
/**
 * Lift pose direction: how much the wrist -> fingertips vector points down
 * the image (1 = straight down). Engage above LIFT_DOWN_ON; once engaged it
 * stays until below LIFT_DOWN_OFF, so the hand can tilt while lifting.
 */
const LIFT_DOWN_ON = 0.5;
const LIFT_DOWN_OFF = 0.2;
/** Ratio fed to the lift detector when the hand isn't pointing down. */
const NOT_LIFT = 1.5;
/** Fingertips bunched for the lift pose. */
const LIFT_TIPS = [LM.THUMB_TIP, LM.INDEX_TIP, LM.MIDDLE_TIP] as const;
/** Palm-down flatness (|vertical component of the palm normal|): engage above ON, stay until below OFF. */
const FLAT_ON = 0.7;
const FLAT_OFF = 0.5;
/** Palm facing the camera (|camera-axis component of the palm normal|; 3D depth is noisy, so be lenient). */
const FACING_ON = 0.45;
const FACING_OFF = 0.3;

/** EMA weight for the roll direction. */
const ROLL_ALPHA = 0.5;
/** Knuckles used for the drag anchor. */
const ANCHOR_POINTS = [2, LM.INDEX_MCP, LM.MIDDLE_MCP] as const;

class Filter2 {
  private fx: OneEuroFilter;
  private fy: OneEuroFilter;
  value: Point2 = { x: 0, y: 0 };

  constructor(minCutoff: number, beta: number) {
    this.fx = new OneEuroFilter(minCutoff, beta);
    this.fy = new OneEuroFilter(minCutoff, beta);
  }

  update(p: Point2, t: number): Point2 {
    this.value = { x: this.fx.filter(p.x, t), y: this.fy.filter(p.y, t) };
    return this.value;
  }
}

/** Debounced on/off detector with a smoothed anchor point. */
const RELEASE_FRAMES = 2;
/**
 * Thumb-index tip gap above this many index-finger lengths always reads as
 * open. Pincers, fists and wrap-around grabs all sit well below 1; a hand
 * that has clearly let go sits above it.
 */
const SPREAD_RELEASE = 1.1;

class GestureDetector {
  ratio = 1;
  active = false;
  private below = 0;
  /** Lowest ratio seen during the current engagement. */
  private tightest = 1;
  /** Consecutive frames the hand has looked like it is opening. */
  private opening = 0;
  private filter: Filter2;

  constructor(private thresholds: ThresholdConfig, private cfg: GestureConfig) {
    this.filter = new Filter2(cfg.pointMinCutoff, cfg.pointBeta);
  }

  get point(): Point2 {
    return this.filter.value;
  }

  update(rawRatio: number, rawPoint: Point2, t: number): GesturePhase {
    this.ratio += (rawRatio - this.ratio) * this.cfg.ratioAlpha;
    this.filter.update(rawPoint, t);

    if (!this.active) {
      this.below = this.ratio < this.thresholds.on ? this.below + 1 : 0;
      if (this.below < this.cfg.startFrames) return 'idle';
      this.active = true;
      this.tightest = this.ratio;
      this.opening = 0;
      return 'start';
    }
    this.tightest = Math.min(this.tightest, this.ratio);
    const opened = this.ratio > this.thresholds.off || this.ratio > this.tightest + this.thresholds.release;
    // Two frames of opening, so one noisy frame doesn't drop the object.
    this.opening = opened ? this.opening + 1 : 0;
    if (this.opening >= RELEASE_FRAMES) {
      this.active = false;
      this.below = 0;
      return 'end';
    }
    return 'held';
  }

  state(phase: GesturePhase): GestureState {
    const { on, open } = this.thresholds;
    const active = phase === 'start' || phase === 'held';
    return {
      phase,
      active,
      point: { ...this.point },
      ratio: this.ratio,
      strength: active ? 1 : clamp01((open - this.ratio) / (open - on)),
    };
  }

  /** Phase to report while the hand is briefly lost. */
  heldPhase(): GesturePhase {
    return this.active ? 'held' : 'idle';
  }
}

interface Track {
  id: HandId;
  landmarks: Landmark[];
  confidence: number;
  lastSeen: number;
  pinch: GestureDetector;
  grip: GestureDetector;
  anchor: Filter2;
  /** Whether the combined pinch-or-grip was engaged last frame. */
  grabActive: boolean;
  /** Which gesture started the current grab. Only that gesture ending releases it. */
  grabBy: 'pinch' | 'grip' | null;
  /** Learned grab detector (ratio = 1 - classifier score). Used once calibrated. */
  learned: GestureDetector;
  lift: GestureDetector;
  palm: GestureDetector;
  twoUp: GestureDetector;
  /** Palm lying flat (palm down), with hysteresis. */
  flat: boolean;
  /** Palm facing the camera, with hysteresis, and the raw amount. */
  facing: boolean;
  facingAmount: number;
  fingersDown: boolean;
  /** Smoothed apparent palm size (view-height units). */
  scale: number | null;
  /** Smoothed unit vector wrist -> middle knuckle, for roll. */
  rollVec: Point2 | null;
}

/** Learned score: engage above 0.6; release below 0.45 or 0.25 under its peak. */
const LEARNED_THRESHOLDS: ThresholdConfig = { on: 0.4, off: 0.55, open: 1, release: 0.25 };

/**
 * Turns per-frame raw detections into stable per-hand state: smoothed points,
 * debounced pinch/grip on/off, and start/held/end phases.
 *
 * Robustness measures (drawn from Meta Interaction SDK grab specs and common
 * hand-tracking practice):
 *  - hysteresis + multi-frame debounce on every gesture
 *  - pinch and grip measured on metric 3D world landmarks, so hand rotation
 *    doesn't fake a pinch
 *  - longer tracking-loss grace while a gesture is engaged
 *  - hand identity follows position, so a MediaPipe Left/Right label flip
 *    mid-grab doesn't drop the object
 */
export class GestureProcessor {
  private tracks = new Map<HandId, Track>();
  private cfg: GestureConfig;
  /** When set (and ready), the learned classifier decides grabs. */
  classifier: GrabClassifier | null = null;
  /** While calibrating: every tracked hand's features are recorded with this label. */
  private collecting: GrabLabel | null = null;
  /** Calibration samples; `t` is the frame timestamp, so they can be matched to webcam snapshots. */
  private samples: { features: number[]; label: GrabLabel; t: number }[] = [];

  /** Start recording calibration samples for one label (null stops). */
  collect(label: GrabLabel | null): void {
    this.collecting = label;
  }

  /** Samples recorded so far, per label. */
  get sampleCounts(): { open: number; grab: number } {
    let open = 0;
    for (const s of this.samples) if (s.label === 0) open++;
    return { open, grab: this.samples.length - open };
  }

  /**
   * Train the classifier from the recorded samples and clear them. `keep` can drop
   * samples first, e.g. ones taken while the hand wasn't actually in the requested pose.
   */
  finishCalibration(keep?: (sample: { label: GrabLabel; t: number }) => boolean): GrabClassifier {
    const c = GrabClassifier.train(keep ? this.samples.filter(keep) : this.samples);
    this.samples = [];
    this.collecting = null;
    if (c.ready) this.classifier = c;
    return c;
  }

  /** Current lift (build/drop) engage/release thresholds. */
  get liftThresholds(): { on: number; off: number } {
    return { on: this.cfg.lift.on, off: this.cfg.lift.off };
  }

  /**
   * Personal lift thresholds from gesture calibration. Live detectors share this
   * config object, so the change applies to hands already being tracked.
   */
  setLiftThresholds({ on, off }: { on: number; off: number }): void {
    this.cfg.lift.on = on;
    this.cfg.lift.off = off;
  }

  clearCalibration(): void {
    this.classifier = null;
    this.samples = [];
    this.collecting = null;
  }

  /** @param aspect video width / height, used for distance correction */
  constructor(private aspect: number, config: Partial<GestureConfig> = {}) {
    this.cfg = { ...DEFAULT_GESTURE_CONFIG, ...config };
    // Own copy, so a personal lift threshold (setLiftThresholds) never edits the shared default.
    this.cfg.lift = { ...this.cfg.lift };
  }

  setAspect(aspect: number): void {
    this.aspect = aspect;
  }

  update(raw: RawHand[], t: number): HandState[] {
    this.stabilizeIds(raw, t);

    const out: HandState[] = [];
    const seen = new Set<HandId>();

    for (const hand of raw) {
      seen.add(hand.id);
      const track = this.tracks.get(hand.id) ?? this.createTrack(hand.id);
      out.push(this.step(track, hand, t));
    }

    for (const [id, track] of this.tracks) {
      if (seen.has(id)) continue;
      const engaged = track.pinch.active || track.grip.active || track.learned.active || track.lift.active || track.palm.active || track.twoUp.active;
      const grace = engaged ? this.cfg.heldGraceMs : this.cfg.lostGraceMs;
      if (t - track.lastSeen <= grace) {
        // Briefly lost: hold last state so a dropped frame doesn't drop a grab.
        out.push(this.snapshot(track, false, track.pinch.heldPhase(), track.grip.heldPhase(), track.learned.heldPhase(), track.lift.heldPhase(), track.palm.heldPhase(), track.twoUp.heldPhase()));
      } else {
        if (engaged) {
          const end = (d: GestureDetector): GesturePhase => (d.active ? 'end' : 'idle');
          out.push(this.snapshot(track, false, end(track.pinch), end(track.grip), end(track.learned), end(track.lift), end(track.palm), end(track.twoUp)));
        }
        this.tracks.delete(id);
      }
    }

    return out;
  }

  reset(): void {
    this.tracks.clear();
  }

  /**
   * MediaPipe sometimes flips handedness labels between frames. Re-assign
   * labels so each detection continues the nearest recent track.
   */
  private stabilizeIds(raw: RawHand[], t: number): void {
    const recent = (id: HandId) => {
      const tr = this.tracks.get(id);
      return tr && tr.landmarks.length && t - tr.lastSeen < RELABEL_WINDOW_MS ? tr : undefined;
    };
    const dist = (h: RawHand, tr: Track) => aspectDistance(h.landmarks[LM.WRIST], tr.landmarks[LM.WRIST], this.aspect);

    if (raw.length === 2) {
      const left = recent('Left');
      const right = recent('Right');
      if (!left || !right) return;
      const [a, b] = raw;
      const trackOf = (id: HandId) => (id === 'Left' ? left : right);
      const asIs = dist(a, trackOf(a.id)) + dist(b, trackOf(b.id));
      const swapped = dist(a, trackOf(b.id)) + dist(b, trackOf(a.id));
      if (swapped + 0.03 < asIs) {
        const tmp = a.id;
        a.id = b.id;
        b.id = tmp;
      }
    } else if (raw.length === 1) {
      const h = raw[0];
      const other: HandId = h.id === 'Left' ? 'Right' : 'Left';
      const otherTrack = recent(other);
      if (otherTrack && !recent(h.id) && dist(h, otherTrack) < RELABEL_DISTANCE) h.id = other;
    }
  }

  private createTrack(id: HandId): Track {
    const track: Track = {
      id,
      landmarks: [],
      confidence: 0,
      lastSeen: 0,
      pinch: new GestureDetector(this.cfg.pinch, this.cfg),
      grip: new GestureDetector(this.cfg.grip, this.cfg),
      anchor: new Filter2(this.cfg.anchorMinCutoff, this.cfg.anchorBeta),
      grabActive: false,
      grabBy: null,
      learned: new GestureDetector(LEARNED_THRESHOLDS, this.cfg),
      lift: new GestureDetector(this.cfg.lift, this.cfg),
      palm: new GestureDetector(this.cfg.palm, this.cfg),
      twoUp: new GestureDetector(this.cfg.twoUp, this.cfg),
      flat: false,
      facing: false,
      facingAmount: 0,
      fingersDown: false,
      scale: null,
      rollVec: null,
    };
    this.tracks.set(id, track);
    return track;
  }

  private step(track: Track, hand: RawHand, t: number): HandState {
    const lms = hand.landmarks;
    const world = hand.worldLandmarks;
    track.landmarks = lms;
    track.confidence = hand.confidence;
    track.lastSeen = t;

    const thumb = lms[LM.THUMB_TIP];
    const index = lms[LM.INDEX_TIP];
    const pinchPoint = { x: (thumb.x + index.x) / 2, y: (thumb.y + index.y) / 2 };
    // Thumb and index tips visibly wide apart = not grabbing, whatever the
    // rest of the hand looks like. Measured against the index finger's own
    // length, so it still works when the palm/wrist are off-screen or the
    // hand is right in front of the camera.
    const spreadOpen = this.tipSpread(lms) > SPREAD_RELEASE;
    const pinchPhase = track.pinch.update(spreadOpen ? 1 : this.pinchRatio(lms, world), pinchPoint, t);

    // Grip is anchored at the palm center in view space.
    const gripPhase = track.grip.update(spreadOpen ? 1.2 : gripRatio(world), mean(lms, PALM_POINTS), t);

    track.anchor.update(mean(lms, ANCHOR_POINTS), t);

    const features = handFeatures(world);
    if (features && this.collecting !== null) this.samples.push({ features, label: this.collecting, t });
    const learnedScore = features && this.classifier?.ready ? this.classifier.score(features) : 0;
    const learnedPhase = track.learned.update(spreadOpen ? 1 : 1 - learnedScore, pinchPoint, t);

    const w = lms[LM.WRIST];
    const m = lms[LM.MIDDLE_MCP];
    const vx = (m.x - w.x) * this.aspect;
    const vy = m.y - w.y;
    const vl = Math.hypot(vx, vy);
    if (vl > 1e-6) {
      const v = { x: vx / vl, y: vy / vl };
      const r = track.rollVec;
      track.rollVec = r ? { x: r.x + (v.x - r.x) * ROLL_ALPHA, y: r.y + (v.y - r.y) * ROLL_ALPHA } : v;
    }

    const liftPhase = track.lift.update(this.liftRatio(lms, world, track.lift.active), mean(lms, LIFT_TIPS), t);
    // An open palm is never a lift (bunched fingertips) or a grab.
    const palmRatio = track.lift.active ? 2 : 2 - gripRatio(world);
    const palmPhase = track.palm.update(palmRatio, mean(lms, PALM_POINTS), t);
    const twoUpPhase = track.twoUp.update(this.twoUpRatio(lms, world), { ...lms[LM.INDEX_TIP] }, t);
    const n = palmNormal(world);
    track.flat = Math.abs(n.y) > (track.flat ? FLAT_OFF : FLAT_ON);
    // Facing the camera: normal along the camera axis, and fingers not hanging down the image.
    const knuckles = lms[LM.MIDDLE_MCP];
    const wrist = lms[LM.WRIST];
    const fingersDown = knuckles.y - wrist.y > 0.3 * Math.hypot((knuckles.x - wrist.x) * this.aspect, knuckles.y - wrist.y);
    track.facingAmount = Math.abs(n.z);
    track.fingersDown = fingersDown;
    track.facing = !fingersDown && track.facingAmount > (track.facing ? FACING_OFF : FACING_ON);
    // Palm size in the image: knuckle span and wrist-to-middle-knuckle, whichever is larger
    // (one of them foreshortens as the hand turns).
    const size = Math.max(
      aspectDistance(lms[LM.INDEX_MCP], lms[LM.PINKY_MCP], this.aspect),
      aspectDistance(lms[LM.WRIST], lms[LM.MIDDLE_MCP], this.aspect),
    );
    track.scale = track.scale === null ? size : track.scale + (size - track.scale) * 0.5;

    return this.snapshot(track, true, pinchPhase, gripPhase, learnedPhase, liftPhase, palmPhase, twoUpPhase);
  }

  /**
   * Lift pose ratio: spread of the thumb/index/middle tips over palm length
   * (3D, so it doesn't depend on how the hand faces the camera), but only
   * while the fingers point down the image; otherwise NOT_LIFT.
   */
  private liftRatio(lms: Landmark[], world: Landmark[], active: boolean): number {
    const tips = mean(lms, LIFT_TIPS);
    const wrist = lms[LM.WRIST];
    const dx = (tips.x - wrist.x) * this.aspect;
    const dy = tips.y - wrist.y;
    const len = Math.hypot(dx, dy);
    const down = len > 1e-6 ? dy / len : 0;
    if (down < (active ? LIFT_DOWN_OFF : LIFT_DOWN_ON)) return NOT_LIFT;
    const pts = world.length >= 21 ? world : lms;
    const palm = dist3(pts[LM.WRIST], pts[LM.MIDDLE_MCP]);
    if (palm < 1e-6) return NOT_LIFT;
    let spread = 0;
    for (let i = 0; i < LIFT_TIPS.length; i++) {
      for (let j = i + 1; j < LIFT_TIPS.length; j++) spread = Math.max(spread, dist3(pts[LIFT_TIPS[i]], pts[LIFT_TIPS[j]]));
    }
    return spread / palm;
  }

  /**
   * How far the hand is from "fingers up" (one or two: ☝ or ✌), forgivingly:
   * 0.5 + the worst of
   *  - index not extended enough (tip-to-wrist vs knuckle-to-wrist, 3D)
   *  - ring / pinky not mostly curled
   *  - the index not pointing roughly up the image
   * The middle finger can be up or down. A clear pose is below 0.5; any
   * broken condition pushes it above.
   */
  private twoUpRatio(lms: Landmark[], world: Landmark[]): number {
    const pts = world.length >= 21 ? world : lms;
    const ext = (tip: number, mcp: number) => {
      const d = dist3(pts[mcp], pts[LM.WRIST]);
      return d > 1e-6 ? dist3(pts[tip], pts[LM.WRIST]) / d : 1;
    };
    const index = ext(LM.INDEX_TIP, LM.INDEX_MCP);
    const ring = ext(LM.RING_TIP, LM.RING_MCP);
    const pinky = ext(LM.PINKY_TIP, LM.PINKY_MCP);
    // Pointing up: index knuckle -> fingertip direction in the image (y down).
    const base = lms[LM.INDEX_MCP];
    const tip = lms[LM.INDEX_TIP];
    const dx = (tip.x - base.x) * this.aspect;
    const dy = tip.y - base.y;
    const len = Math.hypot(dx, dy);
    const up = len > 1e-6 ? -dy / len : 0; // 1 = straight up
    // Ring and pinky: the more curled of the two only has to be clearly curled, the other mostly.
    const curl = Math.max(Math.min(ring, pinky) - 1.35, Math.max(ring, pinky) - 1.55);
    const worst = Math.max(1.45 - index, curl, 0.25 - up);
    return 0.5 + worst;
  }

  /** Thumb-index tip gap / index finger length, in the 2D image. */
  private tipSpread(lms: Landmark[]): number {
    const d = (a: number, b: number) => aspectDistance(lms[a], lms[b], this.aspect);
    const finger = d(5, 6) + d(6, 7) + d(7, 8);
    return finger > 1e-6 ? d(LM.THUMB_TIP, LM.INDEX_TIP) / finger : 0;
  }

  /**
   * Thumb-index gap / palm length, taking the WORSE (larger) of the 3D world
   * estimate and the 2D image measurement. The 3D depth guess is often wrong
   * when a finger points at the camera (a relaxed hand then reads as a pinch),
   * so the fingers must also look close in the image itself.
   */
  private pinchRatio(lms: Landmark[], world: Landmark[]): number {
    const palm2d = aspectDistance(lms[LM.WRIST], lms[LM.MIDDLE_MCP], this.aspect);
    const r2d = palm2d > 1e-6 ? aspectDistance(lms[LM.THUMB_TIP], lms[LM.INDEX_TIP], this.aspect) / palm2d : 1;
    if (world.length >= 21) {
      const palm = dist3(world[LM.WRIST], world[LM.MIDDLE_MCP]);
      if (palm > 1e-6) return Math.max(r2d, dist3(world[LM.THUMB_TIP], world[LM.INDEX_TIP]) / palm);
    }
    return r2d;
  }

  private snapshot(
    track: Track,
    tracked: boolean,
    pinch: GesturePhase,
    grip: GesturePhase,
    learnedPhase: GesturePhase,
    liftPhase: GesturePhase,
    palmPhase: GesturePhase,
    twoUpPhase: GesturePhase,
  ): HandState {
    const p = track.pinch.state(pinch);
    const g = track.grip.state(grip);
    const lift = track.lift.state(liftPhase);
    const palm = track.palm.state(palmPhase);
    const twoUp = track.twoUp.state(twoUpPhase);

    // Calibrated: the learned classifier alone decides the grab (aimed from
    // the fingertips, like before).
    if (this.classifier?.ready) {
      const l = track.learned.state(learnedPhase);
      const was = track.grabActive;
      track.grabActive = l.active;
      const grab: GestureState = {
        phase: l.active ? (was ? 'held' : 'start') : was ? 'end' : 'idle',
        active: l.active,
        point: p.point,
        ratio: l.ratio,
        strength: l.active ? 1 : clamp01((1 - l.ratio) / (1 - LEARNED_THRESHOLDS.on)),
      };
      return { id: track.id, tracked, confidence: track.confidence, landmarks: track.landmarks, anchor: { ...track.anchor.value }, pinch: p, grip: g, grab, lift, palm, twoUp, flat: track.flat, facing: track.facing, facingAmount: track.facingAmount, fingersDown: track.fingersDown, scale: track.scale ?? undefined, roll: rollOf(track) };
    }

    // Only a closed fist grabs by default (pincers were confusing to use);
    // set grabIncludesPinch to allow pinches too. Either way the grab aims
    // from the fingertips (pinch midpoint), not the palm.
    // Release follows the gesture that started the grab. Opening a fist passes
    // through a pinch-like pose (thumb near index), so "pinch OR grip" would
    // keep holding while the user is clearly letting go.
    if (!track.grabActive) {
      track.grabBy = g.active ? 'grip' : this.cfg.grabIncludesPinch && p.active ? 'pinch' : null;
    } else if (track.grabBy === 'grip' && !g.active) {
      track.grabBy = null;
    } else if (track.grabBy === 'pinch' && !p.active) {
      // A pinch that tightens into a fist hands over to the grip.
      track.grabBy = g.active ? 'grip' : null;
    }
    const active = track.grabBy !== null;
    const was = track.grabActive;
    track.grabActive = active;
    const grab: GestureState = {
      phase: active ? (was ? 'held' : 'start') : was ? 'end' : 'idle',
      active,
      point: p.point,
      ratio: this.cfg.grabIncludesPinch ? Math.min(p.ratio / this.cfg.pinch.on, g.ratio / this.cfg.grip.on) : g.ratio / this.cfg.grip.on,
      strength: this.cfg.grabIncludesPinch ? Math.max(p.strength, g.strength) : g.strength,
    };

    return {
      id: track.id,
      tracked,
      confidence: track.confidence,
      landmarks: track.landmarks,
      anchor: { ...track.anchor.value },
      pinch: p,
      grip: g,
      grab,
      lift,
      palm,
      twoUp,
      flat: track.flat,
      facing: track.facing,
      facingAmount: track.facingAmount,
      fingersDown: track.fingersDown,
      scale: track.scale ?? undefined,
      roll: rollOf(track),
    };
  }
}

/**
 * Unit palm normal from metric 3D landmarks (x right, y down, z depth):
 * |y| ~1 = hand lying flat, |z| ~1 = palm (or back of the hand) facing the camera.
 */
function palmNormal(world: Landmark[]): { x: number; y: number; z: number } {
  if (world.length < 21) return { x: 0, y: 0, z: 0 };
  const w = world[LM.WRIST];
  const a = world[LM.INDEX_MCP];
  const b = world[LM.PINKY_MCP];
  const u = { x: a.x - w.x, y: a.y - w.y, z: a.z - w.z };
  const v = { x: b.x - w.x, y: b.y - w.y, z: b.z - w.z };
  const n = { x: u.y * v.z - u.z * v.y, y: u.z * v.x - u.x * v.z, z: u.x * v.y - u.y * v.x };
  const len = Math.hypot(n.x, n.y, n.z);
  return len > 1e-9 ? { x: n.x / len, y: n.y / len, z: n.z / len } : { x: 0, y: 0, z: 0 };
}

function rollOf(track: Track): number | undefined {
  return track.rollVec ? Math.atan2(track.rollVec.y, track.rollVec.x) : undefined;
}

/** Mean fingertip distance to the palm center, divided by palm length. */
function gripRatio(world: Landmark[]): number {
  if (world.length < 21) return 1;
  const center = mean(world, PALM_POINTS);
  const palm = dist3(world[LM.WRIST], world[LM.MIDDLE_MCP]);
  if (palm < 1e-6) return 1;
  let sum = 0;
  for (const i of FINGERTIPS) sum += dist3(world[i], center);
  return sum / FINGERTIPS.length / palm;
}

function mean(points: Landmark[], indices: readonly number[]): Landmark {
  let x = 0, y = 0, z = 0;
  for (const i of indices) {
    x += points[i].x;
    y += points[i].y;
    z += points[i].z;
  }
  const n = indices.length;
  return { x: x / n, y: y / n, z: z / n };
}

function dist3(a: Landmark, b: Landmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
