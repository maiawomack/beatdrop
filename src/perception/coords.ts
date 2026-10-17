import type { Landmark, Point2 } from './types';

/** Convert a raw (unmirrored) MediaPipe landmark to mirrored view space. */
export function toViewSpace(lm: { x: number; y: number; z: number }): Landmark {
  return { x: 1 - lm.x, y: lm.y, z: lm.z };
}

/** Map a view-space point to pixels on a surface of the given size. */
export function viewToPixels(p: Point2, width: number, height: number): Point2 {
  return { x: p.x * width, y: p.y * height };
}

/**
 * Distance between two view-space points, corrected for aspect ratio so a
 * horizontal and a vertical gap of the same physical size compare equally.
 */
export function aspectDistance(a: Point2, b: Point2, aspect: number): number {
  const dx = (a.x - b.x) * aspect;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}
