/**
 * A tiny built-in demo song, synthesized offline so the app works without
 * any audio files: 8 bars at 120 BPM in A minor (Am - F - C - G).
 *
 * "vocals" is a formant-filtered synth lead standing in for a real voice.
 */

const BPM = 120;
const BEAT = 60 / BPM;
const BARS = 8;
const LENGTH = BARS * 4 * BEAT; // 16 s, loops seamlessly on the bar

export async function renderDemoStems(sampleRate = 44100): Promise<Record<string, AudioBuffer>> {
  const [drums, bass, vocals] = await Promise.all([
    render(sampleRate, scheduleDrums),
    render(sampleRate, scheduleBass),
    render(sampleRate, scheduleVox),
  ]);
  return { drums, bass, vocals };
}

async function render(sampleRate: number, schedule: (ctx: OfflineAudioContext) => void): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(1, Math.ceil(LENGTH * sampleRate), sampleRate);
  schedule(ctx);
  const buffer = await ctx.startRendering();
  normalize(buffer, 0.8);
  return buffer;
}

// --- Drums -------------------------------------------------------------------

function scheduleDrums(ctx: OfflineAudioContext): void {
  const noise = noiseBuffer(ctx, 1);
  for (let bar = 0; bar < BARS; bar++) {
    for (let beat = 0; beat < 4; beat++) {
      const t = (bar * 4 + beat) * BEAT;
      kick(ctx, t);
      if (beat === 1 || beat === 3) snare(ctx, noise, t);
      hat(ctx, noise, t, false);
      hat(ctx, noise, t + BEAT / 2, true);
    }
    // Little snare fill at the end of every 4th bar.
    if (bar % 4 === 3) {
      for (let i = 1; i < 4; i++) snare(ctx, noise, (bar * 4 + 3) * BEAT + (i * BEAT) / 4, 0.5);
    }
  }
}

function kick(ctx: BaseAudioContext, t: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.setValueAtTime(150, t);
  osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
  gain.gain.setValueAtTime(1, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.5);
}

function snare(ctx: BaseAudioContext, noise: AudioBuffer, t: number, level = 1): void {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 1800;
  band.Q.value = 0.8;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.7 * level, t);
  ng.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
  src.connect(band).connect(ng).connect(ctx.destination);
  src.start(t);
  src.stop(t + 0.25);

  const body = ctx.createOscillator();
  body.type = 'triangle';
  body.frequency.value = 190;
  const bg = ctx.createGain();
  bg.gain.setValueAtTime(0.4 * level, t);
  bg.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
  body.connect(bg).connect(ctx.destination);
  body.start(t);
  body.stop(t + 0.12);
}

function hat(ctx: BaseAudioContext, noise: AudioBuffer, t: number, open: boolean): void {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 7500;
  const g = ctx.createGain();
  const decay = open ? 0.14 : 0.04;
  g.gain.setValueAtTime(open ? 0.22 : 0.16, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + decay);
  src.connect(hp).connect(g).connect(ctx.destination);
  src.start(t, Math.random() * 0.5);
  src.stop(t + decay + 0.02);
}

// --- Bass --------------------------------------------------------------------

/** Am F C G, twice. Root frequencies in octave 1-2. */
const BASS_ROOTS = [55, 43.65, 65.41, 49, 55, 43.65, 65.41, 49];

function scheduleBass(ctx: OfflineAudioContext): void {
  for (let bar = 0; bar < BARS; bar++) {
    const root = BASS_ROOTS[bar];
    for (let eighth = 0; eighth < 8; eighth++) {
      // Skip the downbeats so it pumps against the kick.
      if (eighth % 2 === 0 && eighth !== 0) continue;
      const t = (bar * 4 + eighth / 2) * BEAT;
      const f = eighth === 7 ? root * 2 : root;
      bassNote(ctx, t, eighth === 0 ? BEAT * 0.45 : BEAT * 0.4, f);
    }
  }
}

function bassNote(ctx: BaseAudioContext, t: number, dur: number, f: number): void {
  const saw = ctx.createOscillator();
  saw.type = 'sawtooth';
  saw.frequency.value = f;
  const sub = ctx.createOscillator();
  sub.frequency.value = f;

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 4;
  lp.frequency.setValueAtTime(1400, t);
  lp.frequency.exponentialRampToValueAtTime(260, t + 0.15);

  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.5, t + 0.005);
  g.gain.setTargetAtTime(0.35, t + 0.005, 0.08);
  g.gain.setTargetAtTime(0, t + dur, 0.02);

  const subGain = ctx.createGain();
  subGain.gain.value = 0.8;

  saw.connect(lp).connect(g);
  sub.connect(subGain).connect(g);
  g.connect(ctx.destination);
  for (const o of [saw, sub]) {
    o.start(t);
    o.stop(t + dur + 0.15);
  }
}

// --- "Vocals" (formant synth lead) ---------------------------------------------

/** [bar, beat, lengthInBeats, midiNote] */
const MELODY: [number, number, number, number][] = [
  [0, 0, 1, 76], [0, 1, 1, 74], [0, 2, 2, 72],
  [1, 0, 1.5, 71], [1, 1.5, 0.5, 72], [1, 2, 1.5, 69],
  [2, 0, 1, 72], [2, 1, 1, 74], [2, 2, 1, 76], [2, 3, 1, 77],
  [3, 0, 2.5, 76],
  [4, 0, 1, 79], [4, 1, 1, 77], [4, 2, 2, 76],
  [5, 0, 1, 74], [5, 1, 1, 72], [5, 2, 1.5, 74],
  [6, 0, 1, 72], [6, 1, 1, 71], [6, 2, 2, 69],
  [7, 0, 2.5, 69],
];

/** "Ah" vowel formants: [frequency, Q, gain]. */
const FORMANTS: [number, number, number][] = [
  [800, 8, 1],
  [1150, 10, 0.5],
  [2900, 12, 0.25],
];

function scheduleVox(ctx: OfflineAudioContext): void {
  for (const [bar, beat, len, midi] of MELODY) {
    voxNote(ctx, (bar * 4 + beat) * BEAT, len * BEAT * 0.95, 440 * 2 ** ((midi - 69) / 12));
  }
}

function voxNote(ctx: BaseAudioContext, t: number, dur: number, f: number): void {
  const out = ctx.createGain();
  out.gain.setValueAtTime(0, t);
  out.gain.linearRampToValueAtTime(1, t + 0.05);
  out.gain.setTargetAtTime(0, t + dur, 0.06);
  out.connect(ctx.destination);

  const mix = ctx.createGain();
  for (const [freq, q, gain] of FORMANTS) {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = gain;
    mix.connect(bp).connect(g).connect(out);
  }

  // Vibrato that eases in after the attack, like a singer.
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 5.5;
  const depth = ctx.createGain();
  depth.gain.setValueAtTime(0, t);
  depth.gain.linearRampToValueAtTime(14, t + Math.min(0.35, dur));
  lfo.connect(depth);

  for (const detune of [-6, 6]) {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = f;
    osc.detune.value = detune;
    depth.connect(osc.detune);
    osc.connect(mix);
    osc.start(t);
    osc.stop(t + dur + 0.4);
  }
  lfo.start(t);
  lfo.stop(t + dur + 0.4);
}

// --- Helpers -----------------------------------------------------------------

function noiseBuffer(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

function normalize(buffer: AudioBuffer, target: number): void {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    for (const v of buffer.getChannelData(c)) peak = Math.max(peak, Math.abs(v));
  }
  if (peak < 1e-6) return;
  const k = target / peak;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) data[i] *= k;
  }
}
