import { aspectDistance } from './coords';
import { FINGERTIPS, LM, PALM_POINTS } from './landmarks';
import { OneEuroFilter } from './oneEuroFilter';
import type { GesturePhase, GestureState, HandId, HandState, Landmark, Point2, RawHand } from './types';

export interface ThresholdConfig {
  /** Gesture engages when ratio drops below this... */
  on: number;
  /** ...and releases only when it rises above this (hysteresis). */
  off: number;
  /** Typical ratio of a relaxed open hand; used only for the strength readout. */
  open: number;
}

export interface GestureConfig {
  pinch: ThresholdConfig;
  grip: ThresholdConfig;
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
  pinch: { on: 0.3, off: 0.45, open: 0.9 },
  grip: { on: 0.55, off: 0.7, open: 1.0 },
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
class GestureDetector {
  ratio = 1;
  active = false;
  private below = 0;
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
      return 'start';
    }
    if (this.ratio > this.thresholds.off) {
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
}

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

  /** @param aspect video width / height, used for distance correction */
  constructor(private aspect: number, config: Partial<GestureConfig> = {}) {
    this.cfg = { ...DEFAULT_GESTURE_CONFIG, ...config };
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
      const engaged = track.pinch.active || track.grip.active;
      const grace = engaged ? this.cfg.heldGraceMs : this.cfg.lostGraceMs;
      if (t - track.lastSeen <= grace) {
        // Briefly lost: hold last state so a dropped frame doesn't drop a grab.
        out.push(this.snapshot(track, false, track.pinch.heldPhase(), track.grip.heldPhase()));
      } else {
        if (engaged) {
          const end = (d: GestureDetector): GesturePhase => (d.active ? 'end' : 'idle');
          out.push(this.snapshot(track, false, end(track.pinch), end(track.grip)));
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
    const pinchPhase = track.pinch.update(this.pinchRatio(lms, world), pinchPoint, t);

    // Grip is anchored at the palm center in view space.
    const gripPhase = track.grip.update(gripRatio(world), mean(lms, PALM_POINTS), t);

    track.anchor.update(mean(lms, ANCHOR_POINTS), t);

    return this.snapshot(track, true, pinchPhase, gripPhase);
  }

  /** Thumb-index gap / palm length. 3D world landmarks when available, else 2D. */
  private pinchRatio(lms: Landmark[], world: Landmark[]): number {
    if (world.length >= 21) {
      const palm = dist3(world[LM.WRIST], world[LM.MIDDLE_MCP]);
      if (palm > 1e-6) return dist3(world[LM.THUMB_TIP], world[LM.INDEX_TIP]) / palm;
    }
    const palm = aspectDistance(lms[LM.WRIST], lms[LM.MIDDLE_MCP], this.aspect);
    return palm > 1e-6 ? aspectDistance(lms[LM.THUMB_TIP], lms[LM.INDEX_TIP], this.aspect) / palm : 1;
  }

  private snapshot(track: Track, tracked: boolean, pinch: GesturePhase, grip: GesturePhase): HandState {
    const p = track.pinch.state(pinch);
    const g = track.grip.state(grip);

    const active = p.active || g.active;
    const was = track.grabActive;
    track.grabActive = active;
    const grab: GestureState = {
      phase: active ? (was ? 'held' : 'start') : was ? 'end' : 'idle',
      active,
      point: p.point,
      ratio: Math.min(p.ratio / this.cfg.pinch.on, g.ratio / this.cfg.grip.on),
      strength: Math.max(p.strength, g.strength),
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
    };
  }
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
