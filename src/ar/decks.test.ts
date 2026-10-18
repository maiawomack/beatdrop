import { describe, expect, it } from 'vitest';
import { crossfadeZone, deckPlatter, deckSlot } from './decks';

describe('deck layout fits any frame shape', () => {
  for (const [name, aspect] of [
    ['portrait 3:4', 0.75],
    ['4:3', 4 / 3],
    ['16:9', 16 / 9],
  ] as const) {
    it(`${name}: bars sit near the middle, mirrored and clear of the edges; records stay on screen`, () => {
      const edges = (deck: 'A' | 'B') =>
        [0, 1, 2, 3].map((i) => {
          const s = deckSlot(aspect, deck, i, 4);
          const hw = s.halfSize.x / aspect;
          return [s.position.x - hw, s.position.x + hw] as const;
        });
      const a = edges('A');
      const b = edges('B');
      for (const [l, r] of [...a, ...b]) {
        expect(l).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(1);
      }
      const aRight = Math.max(...a.map((e) => e[1]));
      const bLeft = Math.min(...b.map((e) => e[0]));
      expect(aRight).toBeLessThan(bLeft);
      expect(aRight).toBeLessThan(0.5);
      expect(bLeft).toBeGreaterThan(0.5);
      expect(aRight + bLeft).toBeCloseTo(1, 5); // symmetric about the middle
      // Clear of the tempo lines at the edges.
      expect(Math.min(...a.map((e) => e[0]))).toBeGreaterThan(0.07);
      const zone = crossfadeZone(aspect);
      expect(zone.x0).toBeLessThan(zone.x1);
      for (const deck of ['A', 'B'] as const) {
        const p = deckPlatter(aspect, deck, 4);
        expect(p.position.x - p.radius / aspect).toBeGreaterThanOrEqual(0);
        expect(p.position.x + p.radius / aspect).toBeLessThanOrEqual(1);
      }
    });
  }
});
