import type { DeckId, StemId } from '../shared/types';

// Colors from the design sketch. Keep in sync with the CSS variables in theme.css.
export const TEAL = '#4fd9d2';
export const LILAC = '#c47be8';
export const ORANGE = '#f27a2c';
export const YELLOW = '#ffe200';

// Stems own the color system so a stem looks the same on both monitors (share these
// with the spatial AR holograms).
export const STEM_COLORS: Record<StemId, string> = {
  vocals: '#4a6bf0',
  drums: TEAL,
  bass: LILAC,
  instrumental: '#8b3fc0',
};

export const STEM_LABELS: Record<StemId, string> = {
  vocals: 'Vocals',
  drums: 'Drums',
  bass: 'Bass',
  instrumental: 'Inst',
};

export const DECK_COLORS: Record<DeckId, string> = {
  A: TEAL,
  B: LILAC,
};

/** Background color for each side when the loaded track has no cover art. */
export const DEFAULT_SIDE_COLORS: Record<DeckId, string> = {
  A: '#3567b0',
  B: '#8c46a6',
};
