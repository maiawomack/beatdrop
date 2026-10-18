import { describe, expect, it } from 'vitest';
import { GrabClassifier, handFeatures } from './grabClassifier';
import type { Landmark } from './types';

/** Crude synthetic hand: fingers extended (curl 0) or curled into the palm (curl 1). */
function hand(curl: number, jitter: () => number): Landmark[] {
  const lm: Landmark[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  const bases = [-0.3, -0.1, 0.1, 0.3];
  // thumb 1-4
  for (let j = 1; j <= 4; j++) lm[j] = { x: -0.4 - j * 0.1 * (1 - curl * 0.5), y: 0.3 + j * 0.08, z: curl * j * 0.05 };
  bases.forEach((bx, f) => {
    const mcp = 5 + f * 4;
    lm[mcp] = { x: bx, y: 1, z: 0 };
    for (let j = 1; j <= 3; j++) {
      const ext = j * 0.35;
      lm[mcp + j] = { x: bx, y: 1 + ext * (1 - curl), z: ext * curl };
    }
  });
  return lm.map((p) => ({ x: p.x + jitter(), y: p.y + jitter(), z: p.z + jitter() }));
}

describe('GrabClassifier', () => {
  it('learns open vs grab from labeled samples', () => {
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.04;
    const samples = [
      ...Array.from({ length: 60 }, () => ({ features: handFeatures(hand(Math.abs(rand()) * 5, rand))!, label: 0 as const })),
      ...Array.from({ length: 60 }, () => ({ features: handFeatures(hand(1 - Math.abs(rand()) * 5, rand))!, label: 1 as const })),
    ];
    const c = GrabClassifier.train(samples);
    expect(c.ready).toBe(true);
    expect(c.score(handFeatures(hand(0.05, rand))!)).toBeLessThan(0.3);
    expect(c.score(handFeatures(hand(0.95, rand))!)).toBeGreaterThan(0.7);
    const round = GrabClassifier.fromModel(JSON.parse(JSON.stringify(c.toModel())));
    expect(round.score(handFeatures(hand(0.95, rand))!)).toBeGreaterThan(0.7);
  });
});
