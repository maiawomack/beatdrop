import type { GrabGesture, HandId, PerceptionFrame, Point2 } from '../perception';
import type { HoloObject } from './HoloObject';

export interface DriftConfig {
  /** How strongly hand velocity pushes objects. */
  gain: number;
  /** Hands within (half width * this) of the center are able to push. */
  influenceScale: number;
  /** Spring pulling drift back to zero (higher = snappier return). */
  stiffness: number;
  /** 1 = no wobble, < 1 = a little float/overshoot. */
  dampingRatio: number;
  /** Max drift as a multiple of the object's half height (kept small so it stays easy to grab). */
  maxDriftScale: number;
}

export const DEFAULT_DRIFT_CONFIG: DriftConfig = {
  gain: 5,
  influenceScale: 1.6,
  stiffness: 40,
  dampingRatio: 0.55,
  maxDriftScale: 0.5,
};

/**
 * Makes free objects drift with nearby hand movement, like they're floating
 * in air the hand disturbs, then spring back. Push scales with hand speed, so
 * a slow reach to grab barely moves the object while a swipe nudges it.
 *
 * Internally works in "height units" (x scaled by aspect) so motion is round.
 */
export class DriftField {
  private cfg: DriftConfig;
  private velocity = new Map<string, Point2>();
  private lastHand = new Map<HandId, { p: Point2; t: number }>();
  private lastT: number | null = null;

  /** @param gesture the grab gesture; its anchor point is used as the hand position */
  constructor(
    private aspect: number,
    private gesture: GrabGesture = 'grab',
    config: Partial<DriftConfig> = {},
  ) {
    this.cfg = { ...DEFAULT_DRIFT_CONFIG, ...config };
  }

  setAspect(aspect: number): void {
    this.aspect = aspect;
  }

  step(objects: HoloObject[], frame: PerceptionFrame): void {
    const t = frame.timestamp;
    const dt = this.lastT === null ? 0 : Math.min((t - this.lastT) / 1000, 0.05);
    this.lastT = t;

    const hands = this.handMotion(frame, t);
    if (dt === 0) return;

    const { gain, influenceScale, stiffness, dampingRatio, maxDriftScale } = this.cfg;
    const damping = 2 * Math.sqrt(stiffness) * dampingRatio;

    for (const obj of objects) {
      const v = this.velocity.get(obj.id) ?? { x: 0, y: 0 };
      // Current drift in height units.
      const d = { x: obj.drift.x * this.aspect, y: obj.drift.y };
      let ax = -stiffness * d.x - damping * v.x;
      let ay = -stiffness * d.y - damping * v.y;

      if (obj.holders.length === 0) {
        const cx = (obj.position.x + obj.drift.x) * this.aspect;
        const cy = obj.position.y + obj.drift.y;
        const reach = obj.halfSize.x * influenceScale;
        for (const h of hands) {
          const dist = Math.hypot(h.p.x - cx, h.p.y - cy);
          if (dist >= reach) continue;
          const falloff = (1 - dist / reach) ** 2;
          ax += gain * h.v.x * falloff;
          ay += gain * h.v.y * falloff;
        }
      }

      v.x += ax * dt;
      v.y += ay * dt;
      d.x += v.x * dt;
      d.y += v.y * dt;

      const max = obj.halfSize.y * maxDriftScale;
      const mag = Math.hypot(d.x, d.y);
      if (mag > max) {
        d.x *= max / mag;
        d.y *= max / mag;
      }

      this.velocity.set(obj.id, v);
      obj.drift = { x: d.x / this.aspect, y: d.y };
    }
  }

  /** Position and velocity (height units, per second) of each tracked, open hand. */
  private handMotion(frame: PerceptionFrame, t: number): { p: Point2; v: Point2 }[] {
    const out: { p: Point2; v: Point2 }[] = [];
    const seen = new Set<HandId>();

    for (const hand of frame.hands) {
      if (!hand.tracked) continue;
      seen.add(hand.id);
      const { point, active } = hand[this.gesture];
      const p = { x: point.x * this.aspect, y: point.y };
      const prev = this.lastHand.get(hand.id);
      this.lastHand.set(hand.id, { p, t });
      // A grabbing hand isn't disturbing the air.
      if (!prev || active) continue;
      const dt = (t - prev.t) / 1000;
      if (dt <= 0 || dt > 0.2) continue;
      out.push({ p, v: { x: (p.x - prev.p.x) / dt, y: (p.y - prev.p.y) / dt } });
    }

    for (const id of this.lastHand.keys()) if (!seen.has(id)) this.lastHand.delete(id);
    return out;
  }
}
