import { describe, expect, it } from 'vitest';
import { SCRATCH_SOURCE, SCRATCH_TUNING } from './scratchVoice';

const SR = 48_000;
const HAND_MS = 33; // gesture updates arrive at camera rate

interface Voice {
  pos: number;
  vel: number;
  port: { onmessage: (e: { data: unknown }) => void; posted: { type: string }[] };
  process(inputs: unknown, outputs: Float32Array[][]): boolean;
}

/** Runs the real worklet source against a stub AudioWorklet scope. */
function voice(seconds = 12) {
  let Processor: new () => Voice = null!;
  class Base {
    port = { onmessage: null as unknown, posted: [] as unknown[], postMessage(m: unknown) { this.posted.push(m); } };
  }
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', SCRATCH_SOURCE)(
    Base,
    (_: string, cls: new () => Voice) => (Processor = cls),
    SR,
  );
  const p = new Processor();
  // A 220 Hz tone, so clicks and jumps show up as large sample-to-sample steps.
  const n = seconds * SR;
  const left = new Float32Array(n);
  for (let i = 0; i < n; i++) left[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR);
  const mid = n / 2;
  const send = (data: unknown) => p.port.onmessage({ data });
  let maxStep = 0;
  let last = 0;
  let peak = 0;
  /** Render `ms` of audio, giving the hand's record position (s from the start) every HAND_MS. */
  const run = (ms: number, hand?: (tMs: number) => number) => {
    peak = 0;
    for (let t = 0; t < ms; t += HAND_MS) {
      if (hand) send({ type: 'target', pos: mid + hand(t) * SR });
      for (let f = 0; f < (HAND_MS / 1000) * SR; f += 128) {
        const L = new Float32Array(128);
        const R = new Float32Array(128);
        p.process([], [[L, R]]);
        for (const v of L) {
          maxStep = Math.max(maxStep, Math.abs(v - last));
          peak = Math.max(peak, Math.abs(v));
          last = v;
        }
      }
    }
  };
  send({ type: 'load', left, right: left, pos: mid, srcRate: 1, spin: 0 });
  return {
    p,
    send,
    run,
    load: (spin: number) => send({ type: 'load', left, right: left, pos: mid, srcRate: 1, spin }),
    /** Record position relative to where the scratch started (s). */
    offset: () => (p.pos - mid) / SR,
    maxStep: () => maxStep,
    peak: () => peak,
  };
}

describe('scratch voice', () => {
  it('pulling the record back plays it backwards (continuous reverse, no jump)', () => {
    const v = voice();
    v.run(300, (t) => -t / 1000); // hand pulls back at normal speed
    expect(v.p.vel).toBeLessThan(-0.6);
    expect(v.p.vel).toBeGreaterThan(-1.2);
    expect(v.offset()).toBeLessThan(-0.15); // it actually travelled back, through the audio
    expect(v.maxStep()).toBeLessThan(0.12); // a 220 Hz tone at <= 3x moves < 0.07 per sample: no clicks
  });

  it('pushing it forward plays forward; small movements stay subtle', () => {
    const v = voice();
    v.run(300, (t) => (0.2 * t) / 1000); // slow nudge, 0.2x
    expect(v.p.vel).toBeGreaterThan(0);
    expect(v.p.vel).toBeLessThan(0.2); // the curve keeps a gentle push gentle
  });

  it('caps extreme speeds', () => {
    const v = voice();
    v.run(200, (t) => (-25 * t) / 1000); // flick at 25x
    expect(Math.abs(v.p.vel)).toBeLessThanOrEqual(SCRATCH_TUNING.MAX_SPEED + 1e-9);
    expect(v.maxStep()).toBeLessThan(0.12);
  });

  it('a hand held still (with tracking jitter) leaves the record still and silent', () => {
    const v = voice();
    v.run(600, (t) => ((t / HAND_MS) % 2 ? 0.0015 : -0.0015)); // +-1.5 ms of jitter
    expect(Math.abs(v.p.vel)).toBeLessThan(0.05);
    expect(v.peak()).toBeLessThan(0.05);
  });

  it('grabbing a playing record brakes it; letting go spins up, fades and hands back', () => {
    const v = voice();
    v.load(1);
    v.run(HAND_MS);
    expect(v.p.vel).toBeGreaterThan(0.1); // still braking after 33 ms, not an instant stop
    v.run(250);
    expect(Math.abs(v.p.vel)).toBeLessThan(0.05);
    v.send({ type: 'release', spin: 1 });
    v.run(66);
    expect(v.p.vel).toBeGreaterThan(0.5); // motor spinning it back up
    v.run(600);
    expect(v.p.port.posted.some((m) => m.type === 'done')).toBe(true);
    v.run(HAND_MS);
    expect(v.peak()).toBe(0); // silent once done
    expect(v.maxStep()).toBeLessThan(0.12);
  });
});
