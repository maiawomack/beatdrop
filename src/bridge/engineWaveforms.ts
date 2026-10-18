import type { LoopView, WaveformSource } from '../ar/waveforms';
import { beatAt } from '../audio/AudioCommands';
import type { WebAudioEngine } from '../audio/WebAudioEngine';

/** Seconds of audio visible across a waveform (playhead in the middle). */
const WINDOW_SECONDS = 4;

/**
 * Feeds real stem amplitude data, live levels, beat position and loop state
 * from the audio engine to the visuals. Everything here reflects actual
 * playback: when a stem loops, the waveform shows the looped audio.
 */
export function createEngineWaveforms(engine: WebAudioEngine): WaveformSource {
  return {
    peaks(stemId, out) {
      const env = engine.envelope(stemId);
      if (!env) return false;
      const now = engine.position(stemId);
      const loop = engine.stems.get(stemId)?.loop;
      const looping = loop?.engaged ? loop : null;
      const n = out.length;
      const bucketsPerSample = (WINDOW_SECONDS * env.rate) / n;
      for (let i = 0; i < n; i++) {
        let t = now - WINDOW_SECONDS / 2 + (i / n) * WINDOW_SECONDS;
        // Inside a loop, the audio around the playhead is the loop repeating.
        if (looping) t = looping.startSec + mod(t - looping.startSec, looping.endSec - looping.startSec);
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
    beat: () => {
      const b = beatAt(engine.transport);
      const bpm = engine.transport.bpm;
      return b === null || bpm === null ? null : { bpm, phase: mod(b, 1) };
    },
    windowSeconds: () => WINDOW_SECONDS,
    loop(stemId): LoopView | null {
      const loop = engine.stems.get(stemId)?.loop;
      if (!loop) return null;
      const pos = engine.position(stemId);
      const len = loop.endSec - loop.startSec;
      const frac = (t: number) => (t - pos) / WINDOW_SECONDS + 0.5;
      if (!loop.engaged) {
        // Not engaged yet: the region is still ahead of (or around) the playhead on the song.
        const region: [number, number] = [frac(loop.startSec), frac(loop.endSec)];
        return { beats: loop.beats, engaged: false, marks: region, region, progress: 0 };
      }
      const into = mod(pos - loop.startSec, len);
      const start = pos - into;
      const marks: number[] = [];
      for (let k = -8; k <= 8; k++) {
        const f = frac(start + k * len);
        if (f >= 0 && f <= 1) marks.push(f);
      }
      return { beats: loop.beats, engaged: true, marks, region: [frac(start), frac(start + len)], progress: into / len };
    },
  };
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}
