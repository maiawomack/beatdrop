import type { HandId, Point2 } from '../perception';

/** A draggable holographic object positioned in view space. */
export interface HoloObject {
  id: string;
  label: string;
  /** Center, view space [0, 1]. */
  position: Point2;
  /** Radius as a fraction of view height. */
  radius: number;
  color: string;
  grabbedBy: HandId | null;
  /**
   * Visual-only displacement from `position` (view space), driven by nearby
   * hand motion. Rendering uses position + drift; hit tests and audio use
   * `position` only.
   */
  drift: Point2;
}

export function createHoloObject(init: Omit<HoloObject, 'grabbedBy' | 'drift'>): HoloObject {
  return { ...init, position: { ...init.position }, grabbedBy: null, drift: { x: 0, y: 0 } };
}
