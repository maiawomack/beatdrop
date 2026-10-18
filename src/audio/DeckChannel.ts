import { EQ_BANDS, STEM_IDS, type ChannelKey, type EqBand, type LoopState, type StemId } from '../shared/types';
import { SCRATCH_PROCESSOR, loadScratchProcessor, scratchReady } from './scratchVoice';

type BufferKey = ChannelKey;

const SMOOTHING = 0.012; // seconds; removes zipper noise from gesture-driven changes
const EQ_FREQ: Record<EqBand, number> = { low: 250, mid: 1000, high: 4000 };
const ECHO_TIME = 0.375; // dotted-eighth at 120 BPM
const ECHO_FEEDBACK = 0.45;

/**
 * One deck's Web Audio graph and sample-accurate buffer playback.
 *
 *   stem sources ─► stemGain ─► meter ─► lane ─┐
 *   full source ──► fullGain ─► meter ─► lane ─┴► input ─► low ─► mid ─► high ─► filter ─┬──────────► fader ─► xf ─► destination
 *                                                                     └► echoSend ─► delay ⇄ feedback
 *                                                                                      └────► fader
 *
 * Each channel's lane (added for the spatial workstation, Task 4):
 *   gain ─► low-pass ─► high-pass ─► duck ─┬─► perf ─► input      (meter taps after duck)
 *   clip source ─► low-pass ─► high-pass ─► clip gain ─► clip mute ─┘ (clips skip the duck)
 * - lane filter: per-channel DJ filter (setChannelFilter)
 * - duck: silences a channel while one of its loop clips plays
 * - perf: master build-up ducking (setChannelPerf)
 */
export class DeckChannel {
  /** Crossfader gain stage; the engine sets it. */
  readonly xf: GainNode;

  private readonly fader: GainNode;
  private readonly input: GainNode;
  private readonly eq: Record<EqBand, BiquadFilterNode>;
  private readonly filter: BiquadFilterNode;
  private readonly echoSend: GainNode;
  private readonly gains: Record<BufferKey, GainNode>;
  /** Pass-through analysers after each gain, so UIs can show live levels. */
  private readonly meters: Record<BufferKey, AnalyserNode>;
  private readonly meterScratch = new Float32Array(512);
  private readonly lanes: Record<BufferKey, Lane>;
  /** Everything that normally plays (stems, full mix, clips) passes here; a scratch mutes it. */
  private readonly live: GainNode;
  /** Track position where the current scratch started (offsets are relative to it). */
  private scrubOrigin = 0;
  /** The scratch voice is running a tape stop (brake), not a hand scratch. */
  private braking = false;
  /** The scratch voice while a hand is on the record (scratchVoice.ts). */
  private scrub: { node: AudioWorkletNode; windowStart: number; sampleRate: number; pos: number } | null = null;
  private readonly clips = new Map<string, Clip>();
  private envelopes: Partial<Record<BufferKey, Float32Array>> = {};
  private readonly scratch = new Float32Array(1024);
  /** Beat grid in track seconds, for quantized loops and clips. */
  grid: { bpm: number; firstBeatSec: number } | null = null;

  private buffers: Partial<Record<BufferKey, AudioBuffer>> = {};
  private sources: AudioBufferSourceNode[] = [];
  /** Incremented whenever we stop sources ourselves, so stale onended events are ignored. */
  private playToken = 0;
  private startCtxTime = 0;
  private startOffset = 0;

  private _playing = false;
  private rate = 1;
  private loop: LoopState | null = null;
  duration = 0;

  /** Called when playback reaches the end of the track (not on pause/stop). */
  onEnded: (() => void) | null = null;

  constructor(private readonly ctx: AudioContext, destination: AudioNode) {
    this.input = ctx.createGain();
    this.live = ctx.createGain();
    this.live.connect(this.input);

    const low = ctx.createBiquadFilter();
    low.type = 'lowshelf';
    const mid = ctx.createBiquadFilter();
    mid.type = 'peaking';
    mid.Q.value = 0.8;
    const high = ctx.createBiquadFilter();
    high.type = 'highshelf';
    this.eq = { low, mid, high };
    for (const band of EQ_BANDS) {
      this.eq[band].frequency.value = EQ_FREQ[band];
      this.eq[band].gain.value = 0;
    }

    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 20000;
    this.filter.Q.value = 0.9;

    this.fader = ctx.createGain();
    this.xf = ctx.createGain();

    this.echoSend = ctx.createGain();
    this.echoSend.gain.value = 0;
    const delay = ctx.createDelay(2);
    delay.delayTime.value = ECHO_TIME;
    const feedback = ctx.createGain();
    feedback.gain.value = ECHO_FEEDBACK;

    this.input.connect(low).connect(mid).connect(high).connect(this.filter).connect(this.fader);
    this.filter.connect(this.echoSend).connect(delay);
    delay.connect(feedback).connect(delay);
    delay.connect(this.fader);
    this.fader.connect(this.xf).connect(destination);

    const gains = {} as Record<BufferKey, GainNode>;
    const meters = {} as Record<BufferKey, AnalyserNode>;
    const lanes = {} as Record<BufferKey, Lane>;
    for (const key of [...STEM_IDS, 'full'] as BufferKey[]) {
      gains[key] = ctx.createGain();
      meters[key] = ctx.createAnalyser();
      meters[key].fftSize = this.meterScratch.length;
      const lane = makeLane(ctx);
      gains[key].connect(meters[key]).connect(lane.lp);
      lane.perf.connect(this.live);
      lanes[key] = lane;
    }
    this.gains = gains;
    this.meters = meters;
    this.lanes = lanes;
  }

  get playing(): boolean {
    return this._playing;
  }

  /** Fetches and decodes the full mix of an unseparated track. */
  async loadFullMix(url: string, signal?: AbortSignal): Promise<void> {
    this.unload();
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`Failed to fetch audio (${res.status}): ${url}`);
    const buffer = await this.ctx.decodeAudioData(await res.arrayBuffer());
    signal?.throwIfAborted();
    this.setBuffers({ full: buffer });
  }

  /**
   * Uses already-decoded buffers, e.g. LoadedTrack.buffers from src/stems/loadTrack().
   * Stems must share one length so a shared start time keeps them aligned.
   */
  setBuffers(buffers: Partial<Record<BufferKey, AudioBuffer>>): void {
    this.unload();
    this.buffers = { ...buffers };
    this.envelopes = {};
    this.duration = Math.max(0, ...Object.values(buffers).map((b) => b.duration));
  }

  /** A decoded buffer (e.g. for tempo estimation). */
  bufferFor(key: BufferKey): AudioBuffer | null {
    return this.buffers[key] ?? null;
  }

  get loadedStems(): StemId[] {
    return STEM_IDS.filter((s) => this.buffers[s]);
  }

  unload(): void {
    this.endScratch();
    for (const id of [...this.clips.keys()]) this.disposeClip(id);
    for (const lane of Object.values(this.lanes)) lane.duck.gain.value = 1;
    this.stopSources();
    this._playing = false;
    this.buffers = {};
    this.duration = 0;
    this.startOffset = 0;
    this.loop = null;
  }

  get hasStems(): boolean {
    return STEM_IDS.some((s) => this.buffers[s]);
  }

  play(): void {
    if (this._playing || this.duration === 0) return;
    const from = this.startOffset >= this.duration - 0.01 ? 0 : this.startOffset;
    this.startSources(from);
    this._playing = true;
  }

  pause(): void {
    if (!this._playing) return;
    this.startOffset = this.position();
    this.stopSources();
    this._playing = false;
  }

  seek(sec: number): void {
    const target = clamp(sec, 0, this.duration);
    if (this._playing) {
      this.stopSources();
      this.startSources(target);
    } else {
      this.startOffset = target;
    }
  }

  position(): number {
    if (!this._playing) return this.startOffset;
    const raw = this.startOffset + (this.ctx.currentTime - this.startCtxTime) * this.rate;
    const loop = this.loop;
    if (loop && this.startOffset < loop.endSec && raw >= loop.endSec) {
      const len = loop.endSec - loop.startSec;
      return loop.startSec + ((raw - loop.startSec) % len);
    }
    return Math.min(raw, this.duration);
  }

  setRate(rate: number): void {
    if (this._playing) {
      this.startOffset = this.position();
      this.startCtxTime = this.ctx.currentTime;
    }
    this.rate = rate;
    for (const src of this.sources) src.playbackRate.setValueAtTime(rate, this.ctx.currentTime);
    for (const clip of this.clips.values()) clip.source?.playbackRate.setValueAtTime(rate, this.ctx.currentTime);
  }

  setLoop(loop: LoopState | null): void {
    this.loop = loop;
    if (!this._playing) return;
    // Restart so every stem source picks up the new loop points in sync.
    let pos = this.position();
    if (loop && pos >= loop.endSec) pos = loop.startSec;
    this.stopSources();
    this.startSources(pos);
  }

  /**
   * Live level per stem after its gain/mute, 0..1 (RMS, scaled so a loud stem nears 1).
   * A full-mix track reports its level on every stem. Cheap enough for animation frames.
   */
  levels(): Record<StemId, number> {
    const out = {} as Record<StemId, number>;
    const full = this.hasStems ? 0 : this.level('full');
    for (const stem of STEM_IDS) out[stem] = this.hasStems ? this.level(stem) : full;
    return out;
  }

  private level(key: BufferKey): number {
    if (!this._playing) return 0;
    const data = this.meterScratch;
    this.meters[key].getFloatTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += v * v;
    return clamp(Math.sqrt(sum / data.length) * 3.2, 0, 1);
  }

  setFader(gain: number): void {
    this.ramp(this.fader.gain, gain);
  }

  setXf(gain: number): void {
    this.ramp(this.xf.gain, gain);
  }

  setStemGain(stem: StemId, gain: number): void {
    this.ramp(this.gains[stem].gain, gain);
  }

  setEq(band: EqBand, gainDb: number): void {
    this.ramp(this.eq[band].gain, gainDb);
  }

  /** -1 = low-pass closed, 0 = open, +1 = high-pass closed. Exponential sweep 20 Hz–20 kHz. */
  setFilter(value: number): void {
    const type: BiquadFilterType = value > 0 ? 'highpass' : 'lowpass';
    const freq = value > 0 ? 20 * Math.pow(1000, value) : 20 * Math.pow(1000, 1 + value);
    if (this.filter.type !== type) this.filter.type = type;
    this.ramp(this.filter.frequency, freq);
  }

  setEcho(amount: number): void {
    this.ramp(this.echoSend.gain, amount);
  }

  private startSources(offset: number): void {
    const keys: BufferKey[] = this.hasStems ? STEM_IDS.filter((s) => this.buffers[s]) : ['full'];
    const when = this.ctx.currentTime;
    const token = ++this.playToken;
    let longest: AudioBufferSourceNode | null = null;
    let longestDuration = -1;

    for (const key of keys) {
      const buffer = this.buffers[key];
      if (!buffer) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = this.rate;
      if (this.loop) {
        src.loop = true;
        src.loopStart = this.loop.startSec;
        src.loopEnd = this.loop.endSec;
      }
      src.connect(this.gains[key]);
      // A shared `when` keeps all stems sample-aligned.
      src.start(when, Math.min(offset, buffer.duration));
      this.sources.push(src);
      if (buffer.duration > longestDuration) {
        longest = src;
        longestDuration = buffer.duration;
      }
    }

    if (longest) {
      longest.onended = () => {
        if (token !== this.playToken) return;
        this.sources = [];
        this._playing = false;
        this.startOffset = this.duration;
        this.onEnded?.();
      };
    }
    this.startCtxTime = when;
    this.startOffset = offset;
    for (const clip of this.clips.values()) this.startClipSource(clip, when, offset);
  }

  private stopSources(): void {
    this.playToken++;
    for (const src of this.sources) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        // already stopped
      }
      src.disconnect();
    }
    this.sources = [];
    for (const clip of this.clips.values()) this.stopClipSource(clip);
  }

  // --- Per-channel controls and loop clips (spatial workstation) ------------

  get beatSec(): number | null {
    return this.grid ? 60 / this.grid.bpm : null;
  }

  /** Track position of the next beat at least `leadSec` (real time) from now. */
  nextBeatPosition(leadSec = 0.05): number | null {
    const beat = this.beatSec;
    if (!beat || !this.grid) return null;
    const from = this.position() + leadSec * this.rate;
    return this.grid.firstBeatSec + Math.ceil((from - this.grid.firstBeatSec) / beat - 1e-9) * beat;
  }

  /** Context time at which track position `pos` plays (no loop wrap assumed). */
  ctxTimeAt(pos: number): number {
    if (!this._playing) return this.ctx.currentTime;
    return this.startCtxTime + (pos - this.startOffset) / this.rate;
  }

  /** Most recent beat at or before the current position. */
  currentBeatPosition(): number | null {
    const beat = this.beatSec;
    if (!beat || !this.grid) return null;
    return this.grid.firstBeatSec + Math.floor((this.position() - this.grid.firstBeatSec) / beat + 1e-6) * beat;
  }

  /** Per-channel DJ filter, -1 low-pass .. 0 off .. +1 high-pass. */
  setChannelFilter(key: BufferKey, value: number): void {
    setDjFilter(this.ctx, this.lanes[key].lp, this.lanes[key].hp, value);
  }

  /** Build-up ducking for one channel (engine-scheduled automation). */
  setChannelPerf(key: BufferKey, gain: number, at: number, timeConstant: number): void {
    this.lanes[key].perf.gain.setTargetAtTime(gain, at, timeConstant);
  }

  /** Live level of a channel (after its duck), 0..1. */
  channelLevel(key: BufferKey): number {
    return rms(this.lanes[key].meter, this.scratch);
  }

  clipLevel(id: string): number {
    const clip = this.clips.get(id);
    return clip ? rms(clip.meter, this.scratch) : 0;
  }

  /** Track position inside a clip's loop (what it's playing now). */
  clipPosition(id: string): number {
    const clip = this.clips.get(id);
    if (!clip) return 0;
    return clip.startSec + mod(this.position() - clip.anchor, clip.endSec - clip.startSec);
  }

  /** Normalized peak envelope of a channel's buffer, ENVELOPE_RATE buckets/s (computed once per load). */
  envelope(key: BufferKey): { data: Float32Array; rate: number; duration: number } | null {
    const buffer = this.buffers[key];
    if (!buffer) return null;
    this.envelopes[key] ??= computeEnvelope(buffer);
    return { data: this.envelopes[key]!, rate: ENVELOPE_RATE, duration: buffer.duration };
  }

  /**
   * Start a loop clip of the last `beats` beats of `key`, from the next beat.
   * Returns the clip's region and when (context time) it starts, or null if
   * the deck isn't playing, has no grid, or lacks that channel.
   */
  createClip(id: string, key: BufferKey, beats: number): { startSec: number; endSec: number; at: number } | null {
    const beat = this.beatSec;
    const b = this.nextBeatPosition();
    const buffer = this.buffers[key];
    if (!this._playing || !beat || b === null || !buffer || this.clips.has(id)) return null;
    const len = beats * beat;
    let startSec = b - len;
    let endSec = b;
    if (startSec < 0) {
      startSec = 0;
      endSec = Math.min(buffer.duration, len);
    }
    const at = this.ctxTimeAt(b);
    const clip = makeClip(this.ctx, key, startSec, endSec, b);
    clip.mute.connect(this.lanes[key].perf);
    this.clips.set(id, clip);
    this.startClipSource(clip, at, b);
    this.lanes[key].duck.gain.setTargetAtTime(0, at, 0.006);
    return { startSec, endSec, at };
  }

  // --- Scratch -------------------------------------------------------------

  get scratching(): boolean {
    return this.scrub !== null;
  }

  /**
   * Hand on the record: the scratch voice takes over from the live sound at the same
   * position and speed (so grabbing a playing record brakes it), on a mix of the audible
   * channels around the playhead. The live sound keeps running muted underneath, so
   * letting go lands where the song would have been and the deck stays in sync.
   * Returns false if there's nothing loaded or the processor isn't ready yet.
   */
  startScratch(): boolean {
    if (this.scrub || !scratchReady(this.ctx) || this.duration === 0) return false;
    const keys: BufferKey[] = this.hasStems ? STEM_IDS.filter((s) => this.buffers[s]) : ['full'];
    const first = this.buffers[keys[0]!]!;
    const sr = first.sampleRate;
    const pos = this.position();
    const windowStart = Math.max(0, pos - SCRUB_WINDOW_SEC);
    const windowEnd = Math.min(this.duration, pos + SCRUB_WINDOW_SEC);
    const from = Math.floor(windowStart * sr);
    const n = Math.max(4, Math.floor((windowEnd - windowStart) * sr));
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    for (const key of keys) {
      const buf = this.buffers[key]!;
      const weight = this.gains[key].gain.value * this.lanes[key].duck.gain.value;
      if (weight <= 0) continue;
      const l = buf.getChannelData(0);
      const r = buf.numberOfChannels > 1 ? buf.getChannelData(1) : l;
      const end = Math.min(n, l.length - from);
      for (let i = 0; i < end; i++) {
        left[i]! += l[from + i]! * weight;
        right[i]! += r[from + i]! * weight;
      }
    }
    const node = new AudioWorkletNode(this.ctx, SCRATCH_PROCESSOR, { outputChannelCount: [2] });
    const scrub = { node, windowStart, sampleRate: sr, pos };
    this.scrubOrigin = pos;
    node.port.onmessage = (e: MessageEvent<{ type: string; pos?: number }>) => {
      if (e.data.type === 'pos') scrub.pos = windowStart + e.data.pos! / sr;
      else if (e.data.type === 'done') node.disconnect();
    };
    node.port.postMessage(
      { type: 'load', left, right, pos: (pos - windowStart) * sr, srcRate: sr / this.ctx.sampleRate, spin: this.spin },
      [left.buffer, right.buffer],
    );
    node.connect(this.input);
    // Same audio at the same position: a short crossfade is seamless.
    this.live.gain.setTargetAtTime(0, this.ctx.currentTime, 0.004);
    this.scrub = scrub;
    return true;
  }

  /** The hand moved the record to `offsetSec` from where the scratch started (negative = back). */
  moveScratch(offsetSec: number): void {
    if (!this.scrub) return;
    this.scrub.node.port.postMessage({ type: 'target', pos: (this.scrubOrigin + offsetSec - this.scrub.windowStart) * this.scrub.sampleRate });
  }

  /**
   * Tape stop before a drop: the record winds down to a halt over about `sec` while the
   * live sound keeps running muted underneath (so the drop lands in sync). Returns false
   * if the deck isn't playing or is being scratched.
   */
  brake(sec: number): boolean {
    if (this.scrub || !this._playing || !this.startScratch()) return false;
    this.braking = true;
    this.scrub!.node.port.postMessage({ type: 'brake', tc: Math.max(0.03, sec / 3) });
    return true;
  }

  /** End a tape stop at context time `at`: the live sound slams back in. */
  endBrake(at: number): void {
    const scrub = this.scrub;
    if (!scrub || !this.braking) return;
    this.live.gain.setTargetAtTime(1, at, 0.002);
    // The wound-down record keeps reporting its position (the records on screen slow down) until then.
    setTimeout(() => {
      if (this.scrub !== scrub) return;
      this.scrub = null;
      this.braking = false;
      scrub.node.port.postMessage({ type: 'stop' });
      scrub.node.disconnect();
    }, Math.max(0, (at - this.ctx.currentTime) * 1000) + 30);
  }

  /** Where the record is while a hand scratches it (what you hear), or null when not scratching. */
  scratchPosition(): number | null {
    if (!this.scrub) return null;
    return Math.max(0, Math.min(this.duration, this.scrub.pos));
  }

  /**
   * Lift off: the platter spins back up as the scratch voice fades, and the live sound
   * (which kept running) fades back in where the song would have been.
   */
  endScratch(): void {
    if (!this.scrub) return;
    const { node } = this.scrub;
    this.scrub = null;
    this.braking = false;
    node.port.postMessage({ type: 'release', spin: this.spin });
    this.live.gain.setTargetAtTime(1, this.ctx.currentTime, 0.02);
    setTimeout(() => node.disconnect(), 800); // fallback; normally on 'done'
  }

  /** Normal record speed right now: the deck's rate while playing, still when paused. */
  private get spin(): number {
    return this._playing ? this.rate : 0;
  }

  /** Stop a clip on the next beat (now if paused / no grid). Returns that context time. */
  removeClip(id: string): number {
    const clip = this.clips.get(id);
    if (!clip) return this.ctx.currentTime;
    const b = this._playing ? this.nextBeatPosition() : null;
    const at = b === null ? this.ctx.currentTime : this.ctxTimeAt(b);
    clip.gain.gain.setTargetAtTime(0, at, 0.006);
    this.clips.delete(id);
    const others = [...this.clips.values()].some((c) => c.key === clip.key);
    if (!others) this.lanes[clip.key].duck.gain.setTargetAtTime(1, at, 0.006);
    const src = clip.source;
    if (src) safeStop(src, at + 0.05);
    setTimeout(() => clip.nodes.forEach((n) => n.disconnect()), Math.max(0, (at - this.ctx.currentTime) * 1000) + 300);
    return at;
  }

  setClipGain(id: string, gain: number): void {
    const clip = this.clips.get(id);
    if (clip) this.ramp(clip.gain.gain, gain);
  }

  setClipMute(id: string, muted: boolean): void {
    const clip = this.clips.get(id);
    if (clip) this.ramp(clip.mute.gain, muted ? 0 : 1);
  }

  setClipFilter(id: string, value: number): void {
    const clip = this.clips.get(id);
    if (clip) setDjFilter(this.ctx, clip.lp, clip.hp, value);
  }

  private disposeClip(id: string): void {
    const clip = this.clips.get(id);
    if (!clip) return;
    this.stopClipSource(clip);
    clip.nodes.forEach((n) => n.disconnect());
    this.clips.delete(id);
  }

  /** (Re)start a clip's source so that it is in phase with the deck at track position `pos` at time `when`. */
  private startClipSource(clip: Clip, when: number, pos: number): void {
    this.stopClipSource(clip);
    const buffer = this.buffers[clip.key];
    if (!buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.loopStart = clip.startSec;
    src.loopEnd = clip.endSec;
    src.playbackRate.value = this.rate;
    src.connect(clip.lp);
    src.start(when, clip.startSec + mod(pos - clip.anchor, clip.endSec - clip.startSec));
    clip.source = src;
  }

  private stopClipSource(clip: Clip): void {
    if (!clip.source) return;
    safeStop(clip.source);
    clip.source.disconnect();
    clip.source = null;
  }

  private ramp(param: AudioParam, value: number): void {
    param.cancelScheduledValues(this.ctx.currentTime);
    param.setTargetAtTime(value, this.ctx.currentTime, SMOOTHING);
  }
}

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

// --- Lanes, clips and helpers (spatial workstation additions) ---------------

const ENVELOPE_RATE = 100;

interface Lane {
  lp: BiquadFilterNode;
  hp: BiquadFilterNode;
  duck: GainNode;
  perf: GainNode;
  meter: AnalyserNode;
}

interface Clip {
  key: BufferKey;
  startSec: number;
  endSec: number;
  /** Deck position at which the clip plays `startSec` (keeps it phase-locked). */
  anchor: number;
  lp: BiquadFilterNode;
  hp: BiquadFilterNode;
  gain: GainNode;
  mute: GainNode;
  meter: AnalyserNode;
  source: AudioBufferSourceNode | null;
  nodes: AudioNode[];
}

function makeLane(ctx: AudioContext): Lane {
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 20000;
  lp.Q.value = 0.7;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 10;
  hp.Q.value = 0.7;
  const duck = ctx.createGain();
  const perf = ctx.createGain();
  const meter = ctx.createAnalyser();
  meter.fftSize = 1024;
  lp.connect(hp).connect(duck).connect(perf);
  duck.connect(meter);
  return { lp, hp, duck, perf, meter };
}

function makeClip(ctx: AudioContext, key: BufferKey, startSec: number, endSec: number, anchor: number): Clip {
  const lane = makeLane(ctx);
  const gain = ctx.createGain();
  const mute = ctx.createGain();
  lane.hp.disconnect();
  lane.hp.connect(gain).connect(mute);
  mute.connect(lane.meter);
  return {
    key,
    startSec,
    endSec,
    anchor,
    lp: lane.lp,
    hp: lane.hp,
    gain,
    mute,
    meter: lane.meter,
    source: null,
    nodes: [lane.lp, lane.hp, gain, mute, lane.meter],
  };
}

/** Two-filter DJ sweep: low-pass 20 kHz -> 160 Hz below 0, high-pass 10 Hz -> 5 kHz above, resonant toward the ends. */
function setDjFilter(ctx: BaseAudioContext, lp: BiquadFilterNode, hp: BiquadFilterNode, value: number): void {
  let v = clamp(value, -1, 1);
  if (Math.abs(v) < 0.02) v = 0;
  const now = ctx.currentTime;
  lp.frequency.setTargetAtTime(v < 0 ? 20000 * (160 / 20000) ** -v : 20000, now, SMOOTHING * 2);
  lp.Q.setTargetAtTime(0.7 + 4 * Math.max(0, -v), now, SMOOTHING * 2);
  hp.frequency.setTargetAtTime(v > 0 ? 10 * (5000 / 10) ** v : 10, now, SMOOTHING * 2);
  hp.Q.setTargetAtTime(0.7 + 4 * Math.max(0, v), now, SMOOTHING * 2);
}

function rms(analyser: AnalyserNode, scratch: Float32Array): number {
  const buf = scratch.length === analyser.fftSize ? scratch : new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf as Float32Array<ArrayBuffer>);
  let sum = 0;
  for (const v of buf) sum += v * v;
  return Math.min(1, Math.sqrt(sum / buf.length) * 4);
}

function computeEnvelope(buffer: AudioBuffer): Float32Array {
  const bucket = Math.max(1, Math.floor(buffer.sampleRate / ENVELOPE_RATE));
  const n = Math.ceil(buffer.length / bucket);
  const env = new Float32Array(n);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      const b = (i / bucket) | 0;
      const v = Math.abs(data[i]!);
      if (v > env[b]!) env[b] = v;
    }
  }
  let peak = 0;
  for (const v of env) peak = Math.max(peak, v);
  if (peak > 0) for (let i = 0; i < n; i++) env[i] = Math.sqrt(env[i]! / peak);
  return env;
}

function safeStop(src: AudioBufferSourceNode, when?: number): void {
  try {
    src.stop(when);
  } catch {
    // already stopped
  }
}

function mod(a: number, n: number): number {
  return n > 0 ? ((a % n) + n) % n : 0;
}

// --- Scratch voice ----------------------------------------------------------

/** Audio kept either side of the playhead for scratching (s). */
const SCRUB_WINDOW_SEC = 6;

/** Load the scratch processor into a context (once); see scratchVoice.ts. */
export const loadScrubProcessor = loadScratchProcessor;
