/**
 * Perceptron check for grab calibration (press C).
 *
 * Calibration labels MediaPipe samples by the on-screen prompt, so frames where the
 * hand was still closing, half-open or out of view get the wrong label. While the
 * user calibrates we take small webcam snapshots (~2 per second); afterwards
 * Perceptron (via the local Python service, which holds the API key) names the pose
 * in each one, and samples recorded near a snapshot that doesn't show the requested
 * pose are dropped before training. Thresholds still come from MediaPipe landmarks.
 *
 * Opt-in: nothing is uploaded until the user agrees once, and snapshots are kept in
 * memory only until the check finishes. If the service, key or API is unavailable,
 * calibration trains on every sample exactly as before. Live performance never
 * calls Perceptron.
 */

import type { GrabLabel } from '../perception/grabClassifier';

const SERVICE = 'http://127.0.0.1:8765';
const CONSENT_KEY = 'beatdrop.perceptronConsent.v1';
/** One snapshot every this many ms during a calibration step. */
const SNAPSHOT_EVERY_MS = 500;
/** A sample is judged by the nearest snapshot of its step within this window. */
const MATCH_WINDOW_MS = SNAPSHOT_EVERY_MS * 0.7;
const SNAPSHOT_WIDTH = 384;
const REQUEST_TIMEOUT_MS = 30_000;

const STEP_NAME: Record<GrabLabel, 'open' | 'fist'> = { 0: 'open', 1: 'fist' };

export interface Snapshot {
  label: GrabLabel;
  t: number;
  /** JPEG data URL. */
  jpeg: string;
}

export interface Verdict {
  pose: string;
  keep: boolean;
}

// --------------------------------------------------------------------------- consent

/** true = allowed, false = declined, null = not asked yet. */
export function perceptronConsent(): boolean | null {
  try {
    const v = localStorage.getItem(CONSENT_KEY);
    return v === null ? null : v === 'yes';
  } catch {
    return null;
  }
}

export function setPerceptronConsent(value: boolean | null): void {
  try {
    if (value === null) localStorage.removeItem(CONSENT_KEY);
    else localStorage.setItem(CONSENT_KEY, value ? 'yes' : 'no');
  } catch {
    /* storage unavailable: ask again next time */
  }
}

/** Whether the local service is running with a Perceptron key. */
export async function perceptronAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${SERVICE}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok && (await res.json()).perceptron === true;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------- snapshots

/** Small JPEG snapshots of the webcam during calibration, held in memory only. */
export class CalibrationSnapshots {
  private snaps: Snapshot[] = [];
  private last = -Infinity;
  private canvas = document.createElement('canvas');

  constructor(private readonly video: HTMLVideoElement) {}

  /** Call every frame during a labeled step; takes a snapshot every SNAPSHOT_EVERY_MS. */
  capture(label: GrabLabel, t: number): void {
    if (t - this.last < SNAPSHOT_EVERY_MS || !this.video.videoWidth) return;
    this.last = t;
    const scale = SNAPSHOT_WIDTH / this.video.videoWidth;
    this.canvas.width = SNAPSHOT_WIDTH;
    this.canvas.height = Math.round(this.video.videoHeight * scale);
    this.canvas.getContext('2d')?.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
    this.snaps.push({ label, t, jpeg: this.canvas.toDataURL('image/jpeg', 0.7) });
  }

  /** Hand over the snapshots and forget them here. */
  take(): Snapshot[] {
    const out = this.snaps;
    this.snaps = [];
    this.last = -Infinity;
    return out;
  }
}

// --------------------------------------------------------------------------- check

export type CheckResult =
  | { ok: true; keep: (sample: { label: GrabLabel; t: number }) => boolean; dropped: number; total: number; poses: string[] }
  | { ok: false; error: string };

/** Ask Perceptron about every snapshot (one request per calibration step). */
export async function checkSnapshots(snaps: Snapshot[]): Promise<CheckResult> {
  const verdicts = new Map<Snapshot, Verdict>();
  try {
    for (const label of [0, 1] as GrabLabel[]) {
      const group = snaps.filter((s) => s.label === label);
      if (group.length === 0) continue;
      const res = await fetch(`${SERVICE}/gesture/assess`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: STEP_NAME[label], frames: group.map((s) => s.jpeg) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: body.error ?? `service error ${res.status}` };
      const results = body.results as Verdict[] | undefined;
      if (!Array.isArray(results) || results.length !== group.length) return { ok: false, error: 'unexpected answer' };
      group.forEach((s, i) => verdicts.set(s, results[i]!));
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const rejected = snaps.filter((s) => verdicts.get(s)?.keep === false);
  const keep = (sample: { label: GrabLabel; t: number }): boolean => {
    let nearest: Snapshot | null = null;
    for (const s of snaps) {
      if (s.label !== sample.label || Math.abs(s.t - sample.t) > MATCH_WINDOW_MS) continue;
      if (!nearest || Math.abs(s.t - sample.t) < Math.abs(nearest.t - sample.t)) nearest = s;
    }
    // No snapshot close enough: keep it (the check only removes what it actually saw).
    return nearest ? verdicts.get(nearest)?.keep !== false : true;
  };
  return { ok: true, keep, dropped: rejected.length, total: snaps.length, poses: snaps.map((s) => verdicts.get(s)?.pose ?? '?') };
}
