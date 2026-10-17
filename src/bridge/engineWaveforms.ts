import type { WaveformSource } from '../ar/waveforms';
import type { WebAudioEngine } from '../audio/WebAudioEngine';

/** Seconds of audio visible across a waveform (playhead in the middle). */
const WINDOW_SECONDS = 4;

/** Feeds real stem amplitude data and live levels from the audio engine to the visuals. */
export function createEngineWaveforms(engine: WebAudioEngine): WaveformSource {
  return {
    peaks(stemId, out) {
      const env = engine.envelope(stemId);
      if (!env) return false;
      const now = engine.position(stemId);
      const n = out.length;
      const bucketsPerSample = (WINDOW_SECONDS * env.rate) / n;
      for (let i = 0; i < n; i++) {
        const t = now - WINDOW_SECONDS / 2 + (i / n) * WINDOW_SECONDS;
        const start = Math.floor(mod(t, env.duration) * env.rate);
        let peak = 0;
        for (let k = 0; k < Math.max(1, bucketsPerSample); k++) {
          peak = Math.max(peak, env.data[(start + k) % env.data.length]);
        }
        out[i] = peak;
      }
      return true;
    },
    playhead: () => 0.5,
    level: (stemId) => engine.level(stemId),
  };
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}
