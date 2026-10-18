import { describe, expect, it } from 'vitest';
import { endedNaturally } from './useQueue';

describe('endedNaturally', () => {
  const at = (positionSec: number, playing = false) => ({ playing, positionSec, durationSec: 200 });

  it('is true when a playing song stops at its end', () => {
    expect(endedNaturally(true, at(200))).toBe(true);
    expect(endedNaturally(true, at(199.97))).toBe(true);
  });

  it('ignores pause, stop and decks that were not playing', () => {
    expect(endedNaturally(true, at(120))).toBe(false); // paused mid-song
    expect(endedNaturally(true, at(0))).toBe(false); // stopped (rewound)
    expect(endedNaturally(false, at(200))).toBe(false); // already stopped at the end
    expect(endedNaturally(true, at(200, true))).toBe(false); // still playing
    expect(endedNaturally(true, { playing: false, positionSec: 0, durationSec: 0 })).toBe(false); // empty deck
  });
});
