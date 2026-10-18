import type { LoopView, WaveformSource } from '../ar/waveforms';
import { beatAt, type AudioStateSource } from '../audio/AudioCommands';
import type { AudioEngine } from '../audio/AudioEngine';
import { parseId } from './task1Adapter';

/** Seconds of audio visible across a waveform (playhead in the middle). */
const WINDOW_SECONDS = 4;

/**
 * Feeds the holograms real data from the shared engine: amplitude around the
 * actual playhead (or a clip's loop), live levels, the lead deck's beat, and
 * loop regions. `state` is the Task1Adapter, so ids are `A:vocals`, `A:full`,
 * `A:vocals~1`...
 */
export function createTask1Waveforms(engine: AudioEngine, state: AudioStateSource): WaveformSource {
  const resolve = (id: string) => {
    const t = parseId(id);
    if (!t) return null;
    const s = state.stems.get(id);
    const pos = t.clipId ? engine.getClipPositionSec(t.deck, t.clipId) : engine.getPositionSec(t.deck);
    return { ...t, s, pos };
  };

  return {
    peaks(id, out) {
      const r = resolve(id);
      if (!r) return false;
      const env = engine.getEnvelope(r.deck, r.channel);
      if (!env) return false;
      const loop = r.s?.loop?.engaged ? r.s.loop : null;
      const n = out.length;
      const bucketsPerSample = (WINDOW_SECONDS * env.rate) / n;
      for (let i = 0; i < n; i++) {
        let t = r.pos - WINDOW_SECONDS / 2 + (i / n) * WINDOW_SECONDS;
        if (loop) t = loop.startSec + mod(t - loop.startSec, loop.endSec - loop.startSec);
        const start = Math.floor(mod(t, env.duration) * env.rate);
        let peak = 0;
        for (let k = 0; k < Math.max(1, bucketsPerSample); k++) peak = Math.max(peak, env.data[(start + k) % env.data.length]!);
        out[i] = peak;
      }
      return true;
    },
    playhead: () => 0.5,
    level(id) {
      const t = parseId(id);
      if (!t) return 0;
      return t.clipId ? engine.getClipLevel(t.deck, t.clipId) : engine.getChannelLevel(t.deck, t.channel);
    },
    beat() {
      const b = beatAt(state.transport);
      const bpm = state.transport.bpm;
      return b === null || bpm === null ? null : { bpm, phase: mod(b, 1) };
    },
    windowSeconds: () => WINDOW_SECONDS,
    loop(id): LoopView | null {
      const r = resolve(id);
      const loop = r?.s?.loop;
      if (!r || !loop) return null;
      const len = loop.endSec - loop.startSec;
      const frac = (t: number) => (t - r.pos) / WINDOW_SECONDS + 0.5;
      if (!loop.engaged) {
        const region: [number, number] = [frac(loop.startSec), frac(loop.endSec)];
        return { beats: loop.beats, engaged: false, marks: region, region, progress: 0 };
      }
      const into = mod(r.pos - loop.startSec, len);
      const start = r.pos - into;
      const marks: number[] = [];
      for (let k = -16; k <= 16; k++) {
        const f = frac(start + k * len);
        if (f >= 0 && f <= 1) marks.push(f);
      }
      return { beats: loop.beats, engaged: true, marks, region: [frac(start), frac(start + len)], progress: into / len };
    },
  };
}

function mod(a: number, n: number): number {
  return n > 0 ? ((a % n) + n) % n : 0;
}
