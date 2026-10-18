import type { Point2 } from '../perception';
import { CAP_ROOM, type HoloObjectInit } from './HoloObject';

export interface StemSpec {
  id: string;
  label: string;
  color: string;
  /** Where it sits by default. */
  slot: 'upperLeft' | 'lowerLeft' | 'upperRight';
}

export const DEFAULT_STEMS: StemSpec[] = [
  { id: 'drums', label: 'Drums', color: '#ff5e62', slot: 'upperLeft' },
  { id: 'vocals', label: 'Vocals', color: '#b47cff', slot: 'lowerLeft' },
  { id: 'bass', label: 'Bass', color: '#2ee6ff', slot: 'upperRight' },
];

/** Gap between a stem's footprint (body + end caps) and the frame edge, view-height units. */
const EDGE_MARGIN = 0.04;
const UPPER_Y = 0.3;
const LOWER_Y = 0.7;

/**
 * Performance layout: two columns at the sides, so the center (your face and
 * the space in front of your chest) stays clear for performing.
 *
 *   drums  ·  upper left        bass  ·  upper right
 *   vocals ·  lower left        (open space: build / drop with a fist)
 *
 * Heights are easy to reach with a raised forearm. Sizes are in view-height
 * units, so the layout scales with the window; width is capped for narrow
 * aspect ratios. Positions are layout only: they don't affect any audio.
 */
export function defaultStemLayout(aspect: number, stems: StemSpec[] = DEFAULT_STEMS): HoloObjectInit[] {
  const halfW = Math.min(0.2, 0.13 * aspect);
  const halfH = 0.06;
  const sideX = (EDGE_MARGIN + halfW + CAP_ROOM) / aspect;

  const slots: Record<StemSpec['slot'], Point2> = {
    upperLeft: { x: sideX, y: UPPER_Y },
    lowerLeft: { x: sideX, y: LOWER_Y },
    upperRight: { x: 1 - sideX, y: UPPER_Y },
  };

  return stems.map((s) => ({
    id: s.id,
    label: s.label,
    color: s.color,
    position: { ...slots[s.slot] },
    halfSize: { x: halfW, y: halfH },
  }));
}

/** Default positions by stem id, for "reset layout". */
export function defaultPositions(aspect: number, stems: StemSpec[] = DEFAULT_STEMS): Map<string, Point2> {
  return new Map(defaultStemLayout(aspect, stems).map((s) => [s.id, s.position]));
}
