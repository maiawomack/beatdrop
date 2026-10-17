import type { HoloObjectInit } from './HoloObject';

export interface StemSpec {
  id: string;
  label: string;
  color: string;
  /** Where it sits by default. */
  slot: 'left' | 'top' | 'right';
}

export const DEFAULT_STEMS: StemSpec[] = [
  { id: 'drums', label: 'Drums', color: '#ff5e62', slot: 'left' },
  { id: 'vocals', label: 'Vocals', color: '#b47cff', slot: 'top' },
  { id: 'bass', label: 'Bass', color: '#2ee6ff', slot: 'right' },
];

/** Gap between waveforms and the frame edge, view-height units. */
const EDGE_MARGIN = 0.05;

/**
 * Places stems around the edges of the frame so the center (where your face
 * usually is) stays clear: one on each side at chest/shoulder height, one
 * above the head. Sizes are in view-height units, so they scale with the
 * window; width is capped for narrow/portrait aspect ratios.
 *
 * At 720p display height a waveform is ~290 x 86 px.
 */
export function defaultStemLayout(aspect: number, stems: StemSpec[] = DEFAULT_STEMS): HoloObjectInit[] {
  const halfW = Math.min(0.2, 0.15 * aspect);
  const halfH = 0.06;
  // Convert horizontal height-units to view x.
  const sideX = (EDGE_MARGIN + halfW) / aspect;

  const slots = {
    left: { x: sideX, y: 0.45 },
    right: { x: 1 - sideX, y: 0.45 },
    top: { x: 0.5, y: EDGE_MARGIN + halfH + 0.02 },
  };

  return stems.map((s) => ({
    id: s.id,
    label: s.label,
    color: s.color,
    position: { ...slots[s.slot] },
    halfSize: { x: halfW, y: halfH },
  }));
}
