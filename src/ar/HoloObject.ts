import type { HandId, Point2 } from '../perception';

/** Set while an object is held by two hands and stretched between them. */
export interface StretchState {
  /** The two hand anchor points, view space. */
  ends: [Point2, Point2];
  /** 0 = hands together, 1 = fully stretched. */
  amount: number;
}

/** A draggable holographic object positioned in view space. */
export interface HoloObject {
  id: string;
  label: string;
  /** Center, view space [0, 1]. */
  position: Point2;
  /**
   * Half width / half height of the visual body, in view-HEIGHT units
   * (so x is not stretched by aspect). The hitbox is larger; see
   * InteractionController.
   */
  halfSize: Point2;
  color: string;
  /** Hands currently holding this object (0, 1 or 2). */
  holders: HandId[];
  /** Grab point of each holder (parallel to `holders`), view space. */
  holdPoints: Point2[];
  stretch: StretchState | null;
  /** 0..1 proximity of the nearest free hand (1 = targeted by a hand). */
  hover: number;
  /** 0..1 how far the targeting hand has closed toward a grab. For anticipation visuals. */
  intent: number;
  /**
   * Visual-only displacement from `position` (view space), driven by nearby
   * hand motion. Rendering uses position + drift; hit tests and audio use
   * `position` only.
   */
  drift: Point2;
}

export type HoloObjectInit = Pick<HoloObject, 'id' | 'label' | 'position' | 'halfSize' | 'color'>;

export function createHoloObject(init: HoloObjectInit): HoloObject {
  return {
    ...init,
    position: { ...init.position },
    halfSize: { ...init.halfSize },
    holders: [],
    holdPoints: [],
    stretch: null,
    hover: 0,
    intent: 0,
    drift: { x: 0, y: 0 },
  };
}
