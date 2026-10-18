/**
 * Beat-grid math for the audio engine, kept free of Web Audio so it can be
 * unit tested. All times are seconds.
 *
 * The song plays on a looping "master timeline": song position
 * pos(t) = (t - startAt) mod duration, with beats at firstBeat + k * beatSec.
 */

export interface Grid {
  /** AudioContext time at which song position 0 played. */
  startAt: number;
  duration: number;
  beatSec: number;
  /** Song position of a beat (preferably a bar downbeat). */
  firstBeat: number;
}

export function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** Master-timeline song position at context time t. */
export function songPosition(g: Grid, t: number): number {
  return mod(t - g.startAt, g.duration);
}

/**
 * Earliest context time >= t + minLead that falls on the grid every
 * `quantumBeats` beats (counted from firstBeat, so quantum 4 = bar downbeats
 * when firstBeat is a downbeat). Wraps to the next pass of the song.
 */
export function nextBoundary(g: Grid, t: number, quantumBeats: number, minLead = 0): number {
  const from = t + minLead;
  const pass = Math.floor((from - g.startAt) / g.duration);
  const step = quantumBeats * g.beatSec;
  for (let p = pass; p <= pass + 1; p++) {
    const passStart = g.startAt + p * g.duration;
    const k = Math.ceil((from - passStart - g.firstBeat) / step - 1e-9);
    const candidate = passStart + g.firstBeat + Math.max(0, k) * step;
    // Beats past the end of this pass belong to the next pass.
    if (candidate - passStart < g.duration - 1e-6 && candidate >= from - 1e-9) return candidate;
  }
  return g.startAt + (pass + 1) * g.duration + g.firstBeat;
}

/**
 * Loop region of `beats` beats starting at song position `pos` (snapped to
 * the nearest beat), shifted back by whole beats if it would run past the end.
 */
export function loopRegion(g: Grid, pos: number, beats: number): { start: number; end: number } {
  const len = beats * g.beatSec;
  let start = g.firstBeat + Math.round((pos - g.firstBeat) / g.beatSec) * g.beatSec;
  while (start + len > g.duration + 1e-6 && start - g.beatSec >= -1e-6) start -= g.beatSec;
  start = Math.max(0, start);
  return { start, end: Math.min(g.duration, start + len) };
}

/** A scheduled playback segment of one stem: from ctxStart, play from offset, looping [loopStart, loopEnd). */
export interface Segment {
  ctxStart: number;
  offset: number;
  loopStart: number;
  loopEnd: number;
}

/** Buffer position of a segment at context time t (t >= ctxStart). */
export function segmentPosition(s: Segment, t: number): number {
  const elapsed = Math.max(0, t - s.ctxStart);
  const len = s.loopEnd - s.loopStart;
  const p = s.offset + elapsed;
  if (p < s.loopEnd) return p;
  return s.loopStart + mod(p - s.loopStart, len);
}
