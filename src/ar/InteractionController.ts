import type { HandId, PerceptionFrame, Point2 } from '../perception';
import type { HoloObject } from './HoloObject';

/** Grab area is a bit larger than the drawn object to make pinching forgiving. */
const HIT_SCALE = 1.4;

export type InteractionEvent =
  | { type: 'grab'; object: HoloObject; hand: HandId }
  | { type: 'move'; object: HoloObject; hand: HandId }
  | { type: 'release'; object: HoloObject; hand: HandId };

interface Grab {
  object: HoloObject;
  /** Object center minus pinch point at grab time, so it doesn't snap. */
  offset: Point2;
}

/**
 * Consumes perception frames and lets each hand independently grab, drag and
 * release one object. Knows nothing about audio or drawing.
 */
export class InteractionController {
  private grabs = new Map<HandId, Grab>();

  /** @param aspect video width / height, for round hit areas */
  constructor(
    readonly objects: HoloObject[],
    private aspect: number,
    private onEvent: (e: InteractionEvent) => void = () => {},
  ) {}

  setAspect(aspect: number): void {
    this.aspect = aspect;
  }

  update(frame: PerceptionFrame): void {
    for (const hand of frame.hands) {
      const { phase, point } = hand.pinch;

      if (phase === 'start') {
        const target = this.pick(point);
        if (target) {
          target.grabbedBy = hand.id;
          this.grabs.set(hand.id, {
            object: target,
            offset: { x: target.position.x - point.x, y: target.position.y - point.y },
          });
          this.onEvent({ type: 'grab', object: target, hand: hand.id });
        }
      } else if (phase === 'held') {
        const grab = this.grabs.get(hand.id);
        if (grab) {
          grab.object.position = {
            x: clamp01(point.x + grab.offset.x),
            y: clamp01(point.y + grab.offset.y),
          };
          this.onEvent({ type: 'move', object: grab.object, hand: hand.id });
        }
      } else if (phase === 'end') {
        this.release(hand.id);
      }
    }

    // Safety net: release grabs whose hand vanished without an 'end'.
    for (const id of this.grabs.keys()) {
      if (!frame.hands.some((h) => h.id === id)) this.release(id);
    }
  }

  private release(hand: HandId): void {
    const grab = this.grabs.get(hand);
    if (!grab) return;
    this.grabs.delete(hand);
    grab.object.grabbedBy = null;
    this.onEvent({ type: 'release', object: grab.object, hand });
  }

  /** Nearest free object whose hit area contains the point. */
  private pick(point: Point2): HoloObject | null {
    let best: HoloObject | null = null;
    let bestDist = Infinity;
    for (const obj of this.objects) {
      if (obj.grabbedBy) continue;
      // Distances in units of view height (x scaled by aspect).
      const d = Math.hypot((point.x - obj.position.x) * this.aspect, point.y - obj.position.y);
      if (d <= obj.radius * HIT_SCALE && d < bestDist) {
        best = obj;
        bestDist = d;
      }
    }
    return best;
  }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
