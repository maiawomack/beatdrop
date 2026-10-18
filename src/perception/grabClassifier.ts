import type { Landmark } from './types';

/**
 * Learned "is this hand grabbing?" classifier, trained from a few seconds of
 * the user's own open and grab poses (see calibration in main.ts).
 *
 * Fixed thresholds on one measurement (thumb-index gap, fingertip curl) kept
 * misfiring: a relaxed hand can look like a pinch, and a "wrap around the
 * bar" grab is neither a pinch nor a fist. This follows the approach of
 * kinivi/hand-gesture-recognition-mediapipe: learn from labeled landmark
 * samples instead. Features are pairwise 3D distances between key joints,
 * normalized by palm length, so they ignore hand position, rotation, size and
 * left/right mirroring. Classification is distance-weighted k-nearest-neighbours.
 */

/** Joints whose pairwise distances describe the hand shape. */
const KEY_JOINTS = [0, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14, 16, 17, 18, 20] as const;
const K = 7;
/** Per-class cap, so long calibrations stay fast to classify. */
const MAX_PER_CLASS = 300;

export type GrabLabel = 0 | 1;

export interface GrabModel {
  version: 1;
  open: number[][];
  grab: number[][];
}

/** Shape features for one hand, or null if world landmarks are missing. */
export function handFeatures(world: Landmark[]): number[] | null {
  if (world.length < 21) return null;
  const palm = dist(world[0], world[9]);
  if (palm < 1e-6) return null;
  const f: number[] = [];
  for (let i = 0; i < KEY_JOINTS.length; i++) {
    for (let j = i + 1; j < KEY_JOINTS.length; j++) {
      f.push(dist(world[KEY_JOINTS[i]], world[KEY_JOINTS[j]]) / palm);
    }
  }
  return f;
}

export class GrabClassifier {
  private open: number[][] = [];
  private grab: number[][] = [];

  static fromModel(model: GrabModel): GrabClassifier {
    const c = new GrabClassifier();
    c.open = model.open;
    c.grab = model.grab;
    return c;
  }

  /** Train from labeled samples (replaces any previous training). */
  static train(samples: { features: number[]; label: GrabLabel }[]): GrabClassifier {
    const c = new GrabClassifier();
    c.open = subsample(samples.filter((s) => s.label === 0).map((s) => s.features), MAX_PER_CLASS);
    c.grab = subsample(samples.filter((s) => s.label === 1).map((s) => s.features), MAX_PER_CLASS);
    return c;
  }

  get ready(): boolean {
    return this.open.length >= K && this.grab.length >= K;
  }

  get counts(): { open: number; grab: number } {
    return { open: this.open.length, grab: this.grab.length };
  }

  toModel(): GrabModel {
    return { version: 1, open: this.open, grab: this.grab };
  }

  /** Probability-like score in [0, 1] that the features are a grab. */
  score(features: number[]): number {
    const nearest: { d: number; label: GrabLabel }[] = [];
    const consider = (list: number[][], label: GrabLabel) => {
      for (const s of list) {
        const d = sqDist(s, features);
        if (nearest.length < K) {
          nearest.push({ d, label });
          nearest.sort((a, b) => a.d - b.d);
        } else if (d < nearest[K - 1].d) {
          nearest[K - 1] = { d, label };
          nearest.sort((a, b) => a.d - b.d);
        }
      }
    };
    consider(this.open, 0);
    consider(this.grab, 1);
    let wGrab = 0;
    let wAll = 0;
    for (const n of nearest) {
      const w = 1 / (Math.sqrt(n.d) + 1e-3);
      wAll += w;
      if (n.label === 1) wGrab += w;
    }
    return wAll > 0 ? wGrab / wAll : 0;
  }
}

function dist(a: Landmark, b: Landmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function sqDist(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
}

/** Evenly spaced subsample, keeping variety across the whole capture. */
function subsample<T>(list: T[], max: number): T[] {
  if (list.length <= max) return list;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(list[Math.floor((i * list.length) / max)]);
  return out;
}
