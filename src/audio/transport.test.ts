import { describe, expect, it } from 'vitest';
import { loopRegion, nextBoundary, segmentPosition, songPosition, type Grid } from './transport';

// 120 BPM, 16 s song (8 bars), started at context time 10.
const g: Grid = { startAt: 10, duration: 16, beatSec: 0.5, firstBeat: 0 };

describe('transport grid', () => {
  it('finds the next beat and bar boundary', () => {
    expect(nextBoundary(g, 10.1, 1)).toBeCloseTo(10.5);
    expect(nextBoundary(g, 10.1, 4)).toBeCloseTo(12);
    expect(nextBoundary(g, 12, 4)).toBeCloseTo(12); // exactly on the bar
    expect(nextBoundary(g, 11.98, 4, 0.05)).toBeCloseTo(14); // too close: next bar
  });

  it('wraps to the next pass of a looping song', () => {
    expect(nextBoundary(g, 25.9, 4)).toBeCloseTo(26); // 10 + 16
    const odd: Grid = { startAt: 0, duration: 15.2, beatSec: 0.5, firstBeat: 0.1 };
    // Last beat of the pass is at 15.1; after that, the next pass's first beat.
    expect(nextBoundary(odd, 15.15, 1)).toBeCloseTo(15.3);
  });

  it('snaps loop regions to beats and keeps them inside the song', () => {
    expect(loopRegion(g, 3.02, 4)).toEqual({ start: 3, end: 5 });
    const r = loopRegion(g, 15.5, 8);
    expect(r.end).toBeCloseTo(16);
    expect(r.start).toBeCloseTo(12);
  });

  it('tracks positions through a loop segment', () => {
    const s = { ctxStart: 20, offset: 3, loopStart: 3, loopEnd: 5 };
    expect(segmentPosition(s, 20)).toBeCloseTo(3);
    expect(segmentPosition(s, 21.5)).toBeCloseTo(4.5);
    expect(segmentPosition(s, 22.5)).toBeCloseTo(3.5);
    expect(songPosition(g, 27)).toBeCloseTo(1);
  });
});
