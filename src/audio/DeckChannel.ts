import { EQ_BANDS, STEM_IDS, type EqBand, type LoopState, type StemId, type StemUrls } from '../shared/types';

type BufferKey = StemId | 'full';

const SMOOTHING = 0.012; // seconds; removes zipper noise from gesture-driven changes
const EQ_FREQ: Record<EqBand, number> = { low: 250, mid: 1000, high: 4000 };
const ECHO_TIME = 0.375; // dotted-eighth at 120 BPM
const ECHO_FEEDBACK = 0.45;

/**
 * One deck's Web Audio graph and sample-accurate buffer playback.
 *
 *   stem sources ─► stemGain ─┐
 *   full source ──► fullGain ─┴► input ─► low ─► mid ─► high ─► filter ─┬──────────► fader ─► xf ─► destination
 *                                                                     └► echoSend ─► delay ⇄ feedback
 *                                                                                      └────► fader
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
    for (const key of [...STEM_IDS, 'full'] as BufferKey[]) {
      gains[key] = ctx.createGain();
      gains[key].connect(this.input);
    }
    this.gains = gains;
  }

  get playing(): boolean {
    return this._playing;
  }

  /** Fetches and decodes every URL in parallel. Resolves to the stems that loaded. */
  async load(urls: StemUrls, signal?: AbortSignal): Promise<StemId[]> {
    this.unload();
    const entries = Object.entries(urls).filter((e): e is [BufferKey, string] => typeof e[1] === 'string');
    const decoded = await Promise.all(
      entries.map(async ([key, url]) => {
        const res = await fetch(url, { signal });
        if (!res.ok) throw new Error(`Failed to fetch ${key} (${res.status}): ${url}`);
        const buffer = await this.ctx.decodeAudioData(await res.arrayBuffer());
        return [key, buffer] as const;
      }),
    );
    signal?.throwIfAborted();
    for (const [key, buffer] of decoded) this.buffers[key] = buffer;
    this.duration = Math.max(0, ...decoded.map(([, b]) => b.duration));
    return STEM_IDS.filter((s) => this.buffers[s]);
  }

  unload(): void {
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
