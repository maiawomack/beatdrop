import type { GrabGesture, HandId, HandState, PerceptionFrame, Point2 } from '../perception';
import type { HoloObject } from './HoloObject';

/**
 * Invisible hitbox padding around the visual body, in view-height units.
 * Waveforms are thin, so the vertical padding is especially generous.
 */
const HIT_PAD = { x: 0.05, y: 0.08 };
/** A targeted object stays targeted until the hand is this far outside its hitbox (hover hysteresis). */
const TARGET_EXIT = 0.06;
/** Hover glow ramps up over this distance outside the hitbox. */
const HOVER_FALLOFF = 0.1;
/** Hand span (view-height units, beyond the object's width) for full stretch. */
const FULL_STRETCH_SPAN = 0.7;
/**
 * Closing your fingers moves the aim point ("Heisenberg effect"). Aim with
 * where the hand was this long before the grab registered, and on release put
 * the object back where it was this long before the fingers opened.
 */
const AIM_LOOKBACK_MS = 80;
const RELEASE_LOOKBACK_MS = 90;
const HISTORY_MS = 250;

export type InteractionEvent =
  /** Object went from free to held. */
  | { type: 'grab'; object: HoloObject; hand: HandId }
  /** Object went from held to free. */
  | { type: 'release'; object: HoloObject; hand: HandId }
  /** Second hand joined: object is now stretched between two hands. */
  | { type: 'stretchStart'; object: HoloObject; hand: HandId }
  /** One of two hands let go: back to single-hand drag. */
  | { type: 'stretchEnd'; object: HoloObject; hand: HandId }
  /** Held object moved or was re-stretched this frame. */
  | { type: 'move'; object: HoloObject };

interface Sample {
  t: number;
  p: Point2;
}

/**
 * Consumes perception frames and lets each hand independently grab, drag and
 * release objects. Grabbing an object that the other hand already holds
 * stretches it between both hands. Knows nothing about audio or drawing.
 *
 * Two points per hand:
 *  - aim  (gesture point, e.g. between fingertips): what you target with
 *  - drag (hand anchor at the knuckles): what held objects follow, because
 *    it barely moves while fingers open and close
 */
export class InteractionController {
  /** Which object each hand is holding. */
  private held = new Map<HandId, HoloObject>();
  /** Object position minus its drag anchor, so grabs never snap. */
  private offsets = new Map<string, Point2>();
  /** Sticky hover target per free hand. */
  private targets = new Map<HandId, HoloObject>();
  private aimHistory = new Map<HandId, Sample[]>();
  private positionHistory = new Map<string, Sample[]>();

  /**
   * @param aspect  video width / height, for undistorted hitboxes
   * @param gesture which hand gesture grabs objects
   */
  constructor(
    readonly objects: HoloObject[],
    private aspect: number,
    private onEvent: (e: InteractionEvent) => void = () => {},
    private gesture: GrabGesture = 'grab',
  ) {}

  setAspect(aspect: number): void {
    this.aspect = aspect;
  }

  update(frame: PerceptionFrame): void {
    const t = frame.timestamp;
    const aims = new Map<HandId, Point2>();
    const drags = new Map<HandId, Point2>();
    for (const hand of frame.hands) {
      aims.set(hand.id, hand[this.gesture].point);
      drags.set(hand.id, hand.anchor);
      if (hand.tracked) record(this.aimHistory, hand.id, t, hand[this.gesture].point);
    }

    // Releases first, so a hand can let go and re-grab in the same frame.
    for (const hand of frame.hands) {
      if (hand[this.gesture].phase === 'end') this.release(hand.id, drags, aims, t);
    }
    // Safety net: release hands that vanished without an 'end'.
    for (const id of [...this.held.keys()]) {
      if (!drags.has(id)) this.release(id, drags, aims, t);
    }

    this.updateTargets(frame);

    for (const hand of frame.hands) {
      if (hand[this.gesture].phase === 'start') this.grab(hand, drags, aims, t);
    }

    for (const obj of this.objects) {
      if (obj.holders.length === 0) continue;
      this.follow(obj, drags, aims);
      record(this.positionHistory, obj.id, t, obj.position);
      this.onEvent({ type: 'move', object: obj });
    }

    this.updateHover(frame);
    for (const id of [...this.aimHistory.keys()]) if (!aims.has(id)) this.aimHistory.delete(id);
  }

  private grab(hand: HandState, drags: Map<HandId, Point2>, aims: Map<HandId, Point2>, t: number): void {
    if (this.held.has(hand.id)) return;

    // Prefer the sticky target; otherwise aim with the pre-pinch position.
    const sticky = this.targets.get(hand.id);
    const pastAim = sampleAt(this.aimHistory.get(hand.id), t - AIM_LOOKBACK_MS);
    const target =
      (sticky && sticky.holders.length < 2 ? sticky : null) ??
      (pastAim ? this.pick(pastAim) : null) ??
      this.pick(aims.get(hand.id)!);
    if (!target) return;

    target.holders.push(hand.id);
    this.held.set(hand.id, target);
    this.targets.delete(hand.id);
    this.rebaseOffset(target, drags);
    target.holdPoints = target.holders.map((h) => ({ ...aims.get(h)! }));
    this.onEvent({ type: target.holders.length === 1 ? 'grab' : 'stretchStart', object: target, hand: hand.id });
  }

  private release(hand: HandId, drags: Map<HandId, Point2>, aims: Map<HandId, Point2>, t: number): void {
    const obj = this.held.get(hand);
    if (!obj) return;
    this.held.delete(hand);
    obj.holders = obj.holders.filter((h) => h !== hand);
    obj.holdPoints = obj.holders.map((h) => ({ ...aims.get(h)! }));
    obj.stretch = null;

    if (obj.holders.length === 0) {
      // Undo the drift caused by the fingers opening.
      const before = sampleAt(this.positionHistory.get(obj.id), t - RELEASE_LOOKBACK_MS);
      if (before) {
        obj.position = { ...before };
        this.onEvent({ type: 'move', object: obj });
      }
      this.offsets.delete(obj.id);
      this.positionHistory.delete(obj.id);
      this.onEvent({ type: 'release', object: obj, hand });
    } else {
      this.rebaseOffset(obj, drags);
      this.onEvent({ type: 'stretchEnd', object: obj, hand });
    }
  }

  /** One hand: follow it. Two hands: follow their midpoint and stretch between them. */
  private follow(obj: HoloObject, drags: Map<HandId, Point2>, aims: Map<HandId, Point2>): void {
    const anchor = this.anchor(obj, drags);
    const offset = this.offsets.get(obj.id) ?? { x: 0, y: 0 };
    obj.position = { x: clamp01(anchor.x + offset.x), y: clamp01(anchor.y + offset.y) };
    obj.holdPoints = obj.holders.map((h) => ({ ...aims.get(h)! }));

    if (obj.holders.length === 2) {
      const [a, b] = obj.holdPoints;
      const [da, db] = obj.holders.map((h) => drags.get(h)!);
      const span = Math.hypot((da.x - db.x) * this.aspect, da.y - db.y);
      const amount = clamp01((span - obj.halfSize.x * 2) / FULL_STRETCH_SPAN);
      obj.stretch = { ends: [a, b], amount };
    }
  }

  private anchor(obj: HoloObject, drags: Map<HandId, Point2>): Point2 {
    const ps = obj.holders.map((h) => drags.get(h)!);
    return {
      x: ps.reduce((s, p) => s + p.x, 0) / ps.length,
      y: ps.reduce((s, p) => s + p.y, 0) / ps.length,
    };
  }

  private rebaseOffset(obj: HoloObject, drags: Map<HandId, Point2>): void {
    const anchor = this.anchor(obj, drags);
    this.offsets.set(obj.id, { x: obj.position.x - anchor.x, y: obj.position.y - anchor.y });
  }

  /**
   * How far the point is outside the object's hitbox, in view-height units
   * (0 when inside), plus a normalized "how central" score for tie-breaking.
   */
  private hitMetrics(point: Point2, obj: HoloObject): { outside: number; centrality: number } {
    const dx = Math.abs(point.x - obj.position.x) * this.aspect;
    const dy = Math.abs(point.y - obj.position.y);
    const hx = obj.halfSize.x + HIT_PAD.x;
    const hy = obj.halfSize.y + HIT_PAD.y;
    const outside = Math.hypot(Math.max(0, dx - hx), Math.max(0, dy - hy));
    return { outside, centrality: Math.max(dx / hx, dy / hy) };
  }

  /** Best object with a free slot whose hitbox contains the point. */
  private pick(point: Point2): HoloObject | null {
    let best: HoloObject | null = null;
    let bestScore = Infinity;
    for (const obj of this.objects) {
      if (obj.holders.length >= 2) continue;
      const { outside, centrality } = this.hitMetrics(point, obj);
      if (outside === 0 && centrality < bestScore) {
        best = obj;
        bestScore = centrality;
      }
    }
    return best;
  }

  /** Sticky targeting: enter on hitbox entry, exit only once clearly outside. */
  private updateTargets(frame: PerceptionFrame): void {
    for (const hand of frame.hands) {
      if (this.held.has(hand.id) || !hand.tracked) continue;
      const aim = hand[this.gesture].point;
      const current = this.targets.get(hand.id);
      if (current && current.holders.length < 2 && this.hitMetrics(aim, current).outside <= TARGET_EXIT) continue;
      const next = this.pick(aim);
      if (next) this.targets.set(hand.id, next);
      else this.targets.delete(hand.id);
    }
    for (const id of [...this.targets.keys()]) {
      if (this.held.has(id) || !frame.hands.some((h) => h.id === id)) this.targets.delete(id);
    }
  }

  /** Proximity glow from free hands; full glow + grab intent on the sticky target. */
  private updateHover(frame: PerceptionFrame): void {
    for (const obj of this.objects) {
      obj.hover = 0;
      obj.intent = 0;
    }
    for (const hand of frame.hands) {
      if (!hand.tracked || this.held.has(hand.id)) continue;
      const g = hand[this.gesture];
      const target = this.targets.get(hand.id);
      if (target) {
        target.hover = 1;
        target.intent = Math.max(target.intent, g.strength);
      }
      for (const obj of this.objects) {
        if (obj === target || obj.holders.length >= 2) continue;
        const { outside } = this.hitMetrics(g.point, obj);
        obj.hover = Math.max(obj.hover, 0.6 * (1 - Math.min(1, outside / HOVER_FALLOFF)));
      }
    }
  }
}

function record(history: Map<string, Sample[]>, key: string, t: number, p: Point2): void {
  const list = history.get(key) ?? [];
  list.push({ t, p: { ...p } });
  while (list.length > 1 && t - list[0].t > HISTORY_MS) list.shift();
  history.set(key, list);
}

/** Latest sample at or before time t (oldest available if none that old). */
function sampleAt(list: Sample[] | undefined, t: number): Point2 | null {
  if (!list || list.length === 0) return null;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].t <= t) return list[i].p;
  return list[0].p;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
