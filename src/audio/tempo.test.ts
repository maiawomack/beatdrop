import { describe, expect, it } from 'vitest';
import { estimateTempo } from './tempo';

/** Synthetic drum loop: kick on every beat, quieter hat on the off-beats, a little noise. */
function track(bpm: number, offsetSec: number, seconds = 40, sr = 22050): Float32Array {
  const out = new Float32Array(seconds * sr);
  const beat = 60 / bpm;
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < out.length; i++) out[i] = 0.02 * rand();
  for (let t = offsetSec; t < seconds; t += beat / 2) {
    const onBeat = Math.abs(((t - offsetSec) / beat) % 1) < 1e-6 || Math.abs(((t - offsetSec) / beat) % 1 - 1) < 1e-6;
    const s0 = Math.round(t * sr);
    for (let k = 0; k < sr * 0.12 && s0 + k < out.length; k++) {
      const env = Math.exp(-k / (sr * (onBeat ? 0.04 : 0.01)));
      out[s0 + k]! += (onBeat ? 0.9 * Math.sin((2 * Math.PI * 60 * k) / sr) : 0.25 * rand()) * env;
    }
  }
  return out;
}

describe('tempo estimate', () => {
  for (const [bpm, offset] of [
    [120, 0.0],
    [100, 0.23],
    [128, 0.11],
    [95, 0.4],
  ] as const) {
    it(`finds ${bpm} BPM and the beat phase`, () => {
      const sr = 22050;
      const est = estimateTempo([track(bpm, offset)], sr)!;
      expect(est).not.toBeNull();
      expect(Math.abs(est.bpm - bpm)).toBeLessThan(1);
      const beat = 60 / est.bpm;
      const err = Math.abs(((est.firstBeatSec - offset) % beat + beat * 1.5) % beat - beat / 2);
      expect(err).toBeLessThan(0.03);
    });
  }

  it('returns null for audio that is too short', () => {
    expect(estimateTempo([new Float32Array(1000)], 44100)).toBeNull();
  });
});
