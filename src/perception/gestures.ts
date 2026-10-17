import { aspectDistance } from './coords';
import { LM } from './landmarks';
import { OneEuroFilter } from './oneEuroFilter';
import type { HandId, HandState, Landmark, PinchPhase, Point2, RawHand } from './types';

export interface GestureConfig {
  /** Pinch engages when ratio drops below this... */
  pinchOn: number;
  /** ...and releases only when it rises above this (hysteresis). */
  pinchOff: number;
  /** Consecutive frames below pinchOn required to engage. */
  startFrames: number;
  /** Keep a lost hand alive this long before releasing it (ms). */
  lostGraceMs: number;
  /** EMA weight for the pinch ratio (1 = no smoothing). */
  ratioAlpha: number;
  pointMinCutoff: number;
  pointBeta: number;
}

export const DEFAULT_GESTURE_CONFIG: GestureConfig = {
  pinchOn: 0.3,
  pinchOff: 0.45,
  startFrames: 2,
  lostGraceMs: 150,
  ratioAlpha: 0.6,
  pointMinCutoff: 1.0,
  pointBeta: 5.0,
};

interface Track {
  id: HandId;
  landmarks: Landmark[];
  confidence: number;
  lastSeen: number;
  ratio: number;
  active: boolean;
  belowCount: number;
  point: Point2;
  fx: OneEuroFilter;
  fy: OneEuroFilter;
}

/**
 * Turns per-frame raw detections into stable per-hand state: smoothed pinch
 * point, debounced pinch on/off, and start/held/end phases.
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
    const out: HandState[] = [];
    const seen = new Set<HandId>();

    for (const hand of raw) {
      seen.add(hand.id);
      const track = this.tracks.get(hand.id) ?? this.createTrack(hand.id);
      out.push(this.step(track, hand, t));
    }

    for (const [id, track] of this.tracks) {
      if (seen.has(id)) continue;
      if (t - track.lastSeen <= this.cfg.lostGraceMs) {
        // Briefly lost: hold last state so a dropped frame doesn't drop a grab.
        out.push(this.snapshot(track, false, track.active ? 'held' : 'idle'));
      } else {
        if (track.active) out.push(this.snapshot(track, false, 'end'));
        this.tracks.delete(id);
      }
    }

    return out;
  }

  reset(): void {
    this.tracks.clear();
  }

  private createTrack(id: HandId): Track {
    const { pointMinCutoff: mc, pointBeta: b } = this.cfg;
    const track: Track = {
      id,
      landmarks: [],
      confidence: 0,
      lastSeen: 0,
      ratio: 1,
      active: false,
      belowCount: 0,
      point: { x: 0, y: 0 },
      fx: new OneEuroFilter(mc, b),
      fy: new OneEuroFilter(mc, b),
    };
    this.tracks.set(id, track);
    return track;
  }

  private step(track: Track, hand: RawHand, t: number): HandState {
    const lms = hand.landmarks;
    track.landmarks = lms;
    track.confidence = hand.confidence;
    track.lastSeen = t;

    // Pinch ratio normalized by palm size so it's independent of hand distance.
    const thumb = lms[LM.THUMB_TIP];
    const index = lms[LM.INDEX_TIP];
    const palm = aspectDistance(lms[LM.WRIST], lms[LM.MIDDLE_MCP], this.aspect);
    const rawRatio = palm > 1e-6 ? aspectDistance(thumb, index, this.aspect) / palm : 1;
    track.ratio += (rawRatio - track.ratio) * this.cfg.ratioAlpha;

    const mid = { x: (thumb.x + index.x) / 2, y: (thumb.y + index.y) / 2 };
    track.point = { x: track.fx.filter(mid.x, t), y: track.fy.filter(mid.y, t) };

    let phase: PinchPhase;
    if (!track.active) {
      track.belowCount = track.ratio < this.cfg.pinchOn ? track.belowCount + 1 : 0;
      if (track.belowCount >= this.cfg.startFrames) {
        track.active = true;
        phase = 'start';
      } else {
        phase = 'idle';
      }
    } else if (track.ratio > this.cfg.pinchOff) {
      track.active = false;
      track.belowCount = 0;
      phase = 'end';
    } else {
      phase = 'held';
    }

    return this.snapshot(track, true, phase);
  }

  private snapshot(track: Track, tracked: boolean, phase: PinchPhase): HandState {
    return {
      id: track.id,
      tracked,
      confidence: track.confidence,
      landmarks: track.landmarks,
      pinch: {
        phase,
        active: phase === 'start' || phase === 'held',
        point: { ...track.point },
        ratio: track.ratio,
      },
    };
  }
}
