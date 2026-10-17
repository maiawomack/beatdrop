import type { AudioCommand, AudioCommandSink, StemId } from './AudioCommands';
import { renderDemoStems } from './demoSong';
import { loadStemFiles } from './stemLoader';

export interface StemMixState {
  pan: number;
  volume: number;
  stretch: number;
  grabbed: boolean;
}

/** Amplitude envelope resolution used for waveform visuals. */
const ENVELOPE_RATE = 100; // buckets per second
/** Smoothing time for parameter changes (s); avoids zipper noise. */
const RAMP = 0.03;

interface Channel {
  buffer: AudioBuffer;
  source: AudioBufferSourceNode | null;
  filter: BiquadFilterNode;
  gain: GainNode;
  panner: StereoPannerNode;
  send: GainNode;
  analyser: AnalyserNode;
  scratch: Float32Array<ArrayBuffer>;
  level: number;
  /** Peak amplitude per bucket, normalized to [0, 1]. */
  envelope: Float32Array;
}

/**
 * Plays synced, looping stems and applies AudioCommands:
 *   setVolume  -> gain (perceptual curve)
 *   setPan     -> stereo panner
 *   setStretch -> lowpass sweep + resonance + dotted-eighth delay send
 *
 * Uses stem files from /stems/ if present, otherwise a generated demo song.
 */
export class WebAudioEngine implements AudioCommandSink {
  readonly stems = new Map<StemId, StemMixState>();
  private channels = new Map<StemId, Channel>();
  private startAt = -1;

  private constructor(
    private ctx: AudioContext,
    buffers: Record<string, AudioBuffer>,
    readonly sourceKind: 'files' | 'demo',
  ) {
    const master = ctx.createGain();
    master.gain.value = 0.9;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.ratio.value = 8;
    master.connect(limiter).connect(ctx.destination);

    // Shared spacey delay used by stretch.
    const delay = ctx.createDelay(2);
    delay.delayTime.value = 0.375;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.38;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 3500;
    delay.connect(tone).connect(feedback).connect(delay);
    tone.connect(master);

    for (const [id, buffer] of Object.entries(buffers)) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 20000;
      filter.Q.value = 0.7;
      const gain = ctx.createGain();
      const panner = ctx.createStereoPanner();
      const send = ctx.createGain();
      send.gain.value = 0;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;

      filter.connect(gain).connect(panner);
      panner.connect(master);
      panner.connect(analyser);
      panner.connect(send).connect(delay);

      this.channels.set(id, {
        buffer,
        source: null,
        filter,
        gain,
        panner,
        send,
        analyser,
        scratch: new Float32Array(analyser.fftSize),
        level: 0,
        envelope: computeEnvelope(buffer),
      });
      this.stems.set(id, { pan: 0, volume: 1, stretch: 0, grabbed: false });
    }
  }

  /** Builds the engine (suspended until start()). Safe to call before any user gesture. */
  static async create(stemIds: string[]): Promise<WebAudioEngine> {
    const ctx = new AudioContext();
    const files = await loadStemFiles(ctx, stemIds);
    if (files) return new WebAudioEngine(ctx, files, 'files');
    return new WebAudioEngine(ctx, await renderDemoStems(ctx.sampleRate), 'demo');
  }

  get started(): boolean {
    return this.startAt >= 0;
  }

  get playing(): boolean {
    return this.started && this.ctx.state === 'running';
  }

  /** Must be called from a user gesture (click / key) the first time. */
  async start(): Promise<void> {
    await this.ctx.resume();
    if (this.started) return;
    this.startAt = this.ctx.currentTime + 0.05;
    for (const ch of this.channels.values()) {
      const src = this.ctx.createBufferSource();
      src.buffer = ch.buffer;
      src.loop = true;
      src.connect(ch.filter);
      src.start(this.startAt);
      ch.source = src;
    }
  }

  async togglePause(): Promise<void> {
    if (!this.started) return this.start();
    if (this.ctx.state === 'running') await this.ctx.suspend();
    else await this.ctx.resume();
  }

  dispatch(command: AudioCommand): void {
    const ch = this.channels.get(command.stemId);
    const stem = this.stems.get(command.stemId);
    if (!ch || !stem) return;
    const now = this.ctx.currentTime;

    switch (command.type) {
      case 'grab':
        stem.grabbed = true;
        this.tick(1500, 0.07, stem.pan);
        break;
      case 'release':
        stem.grabbed = false;
        this.tick(950, 0.045, stem.pan);
        break;
      case 'setPan':
        stem.pan = command.value;
        ch.panner.pan.setTargetAtTime(clamp(command.value, -1, 1), now, RAMP);
        break;
      case 'setVolume':
        stem.volume = command.value;
        ch.gain.gain.setTargetAtTime(clamp(command.value, 0, 1) ** 2, now, RAMP);
        break;
      case 'setStretch': {
        stem.stretch = command.value;
        const a = clamp(command.value, 0, 1);
        ch.filter.frequency.setTargetAtTime(20000 * (500 / 20000) ** a, now, RAMP * 2);
        ch.filter.Q.setTargetAtTime(0.7 + 7 * a, now, RAMP * 2);
        ch.send.gain.setTargetAtTime(0.55 * a, now, RAMP * 2);
        break;
      }
    }
  }

  /** Short soft UI click, panned to the stem: stands in for haptic feedback. */
  private tick(freq: number, level: number, pan: number): void {
    if (this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.6, t + 0.05);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    const p = this.ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    osc.connect(g).connect(p).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + 0.08);
  }

  /** Playback position within this stem's loop, seconds. */
  position(stemId: StemId): number {
    const ch = this.channels.get(stemId);
    if (!ch || !this.started) return 0;
    const t = Math.max(0, this.ctx.currentTime - this.startAt);
    return t % ch.buffer.duration;
  }

  /** Normalized peak envelope for visuals, plus its sample rate. */
  envelope(stemId: StemId): { data: Float32Array; rate: number; duration: number } | null {
    const ch = this.channels.get(stemId);
    return ch ? { data: ch.envelope, rate: ENVELOPE_RATE, duration: ch.buffer.duration } : null;
  }

  /** Smoothed live output level in [0, 1] (post volume/pan). */
  level(stemId: StemId): number {
    const ch = this.channels.get(stemId);
    if (!ch || !this.playing) return 0;
    ch.analyser.getFloatTimeDomainData(ch.scratch);
    let sum = 0;
    for (const v of ch.scratch) sum += v * v;
    const rms = Math.sqrt(sum / ch.scratch.length);
    const target = Math.min(1, rms * 4);
    ch.level += (target - ch.level) * (target > ch.level ? 0.6 : 0.15);
    return ch.level;
  }
}

function computeEnvelope(buffer: AudioBuffer): Float32Array {
  const bucket = Math.max(1, Math.floor(buffer.sampleRate / ENVELOPE_RATE));
  const n = Math.ceil(buffer.length / bucket);
  const env = new Float32Array(n);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      const b = (i / bucket) | 0;
      const v = Math.abs(data[i]);
      if (v > env[b]) env[b] = v;
    }
  }
  let peak = 0;
  for (const v of env) peak = Math.max(peak, v);
  // sqrt lifts quiet detail so the shape reads well visually.
  if (peak > 0) for (let i = 0; i < n; i++) env[i] = Math.sqrt(env[i] / peak);
  return env;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
