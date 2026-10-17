/**
 * Waveform data for stem visuals.
 *
 * The renderer asks a WaveformSource for amplitude peaks. When the audio
 * engine has decoded buffers it can provide real peaks (e.g. max |sample| per
 * bucket around the playhead); until then ProceduralWaveforms gives each stem
 * a distinct, musically-shaped fallback.
 */
export interface WaveformSource {
  /**
   * Fill `out` with amplitudes in [0, 1] spanning the visible window.
   * Return false if no data is available for this stem.
   */
  peaks(stemId: string, out: Float32Array, timeSec: number): boolean;
  /** Fixed playhead position in [0, 1]; omit for an animated sweep. */
  playhead?(stemId: string): number;
  /** Live output level in [0, 1], used to pulse the glow with the music. */
  level?(stemId: string): number;
}

type Shape = (u: number) => number;

/** Visible window scrolls this many loops per second (slow, so it's easy to grab). */
const SCROLL_SPEED = 0.035;
/** Beats per visible loop. */
const BEATS = 8;

export class ProceduralWaveforms implements WaveformSource {
  private shapes: Record<string, Shape> = {
    drums: drumsShape,
    vocals: vocalsShape,
    bass: bassShape,
  };

  peaks(stemId: string, out: Float32Array, timeSec: number): boolean {
    const shape = this.shapes[stemId] ?? genericShape(hashString(stemId));
    const offset = timeSec * SCROLL_SPEED;
    // Gentle breathing so it feels alive without wobbling around.
    const breathe = 0.93 + 0.07 * Math.sin(timeSec * 1.8 + hashString(stemId));
    const n = out.length;
    for (let i = 0; i < n; i++) {
      const u = fract(i / n + offset);
      out[i] = clamp01(shape(u) * breathe);
    }
    return true;
  }
}

/** Kick/snare transients with sharp attacks and fast decays, plus hi-hat ticks. */
function drumsShape(u: number): number {
  const beatPos = u * BEATS;
  const beat = Math.floor(beatPos);
  const local = beatPos - beat;
  const isKick = beat % 2 === 0;
  const hit = Math.exp(-local * (isKick ? 11 : 16)) * (isKick ? 1 : 0.72);
  const attack = Math.min(1, local * 60); // a couple of samples of rise
  const hat = 0.2 * Math.exp(-fract(u * BEATS * 2) * 22);
  const grit = 0.8 + 0.2 * valueNoise(u, 256, 11);
  return 0.04 + Math.max(hit * attack * grit, hat);
}

/** Phrases with syllable-like modulation and gaps of near-silence between them. */
function vocalsShape(u: number): number {
  const phrases = [
    { at: 0.14, width: 0.1, level: 0.85 },
    { at: 0.42, width: 0.08, level: 0.7 },
    { at: 0.72, width: 0.12, level: 0.95 },
  ];
  let env = 0;
  for (const p of phrases) {
    const d = wrappedDistance(u, p.at);
    env = Math.max(env, p.level * Math.exp(-(d * d) / (2 * p.width * p.width)));
  }
  const syllables = 0.6 + 0.4 * Math.abs(Math.sin(u * Math.PI * 34));
  const breath = 0.85 + 0.15 * valueNoise(u, 48, 23);
  return 0.05 + env * syllables * breath;
}

/** Thick sustained low end that ducks on each kick (sidechain pump). */
function bassShape(u: number): number {
  const local = fract(u * BEATS);
  const pump = 1 - 0.55 * Math.exp(-local * 5);
  const swell = 0.85 + 0.15 * Math.sin(u * Math.PI * 2 * 2);
  const wobble = 0.92 + 0.08 * valueNoise(u, 32, 37);
  return 0.12 + 0.72 * pump * swell * wobble;
}

/** Fallback for unknown stems: smooth noise, seeded so each stem differs. */
function genericShape(seed: number): Shape {
  return (u) => 0.1 + 0.7 * valueNoise(u, 24, seed);
}

/** Smooth noise that is periodic over u in [0, 1). */
function valueNoise(u: number, cells: number, seed: number): number {
  const x = fract(u) * cells;
  const i = Math.floor(x);
  const f = x - i;
  const a = hash01(i % cells, seed);
  const b = hash01((i + 1) % cells, seed);
  const s = f * f * (3 - 2 * f);
  return a + (b - a) * s;
}

function hash01(i: number, seed: number): number {
  const x = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 997;
}

function wrappedDistance(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, 1 - d);
}

function fract(x: number): number {
  return x - Math.floor(x);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
