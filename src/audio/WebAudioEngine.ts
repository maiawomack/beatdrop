import {
  defaultPerformanceState,
  defaultStemState,
  isStemCommand,
  wallNow,
  type AudioCommand,
  type AudioCommandSink,
  type AudioStateSource,
  type LoopBeats,
  type PerformanceCommand,
  type PerformanceState,
  type StemCommand,
  type StemId,
  type StemState,
  type TransportState,
} from './AudioCommands';
import { renderDemoStems, DEMO_BPM } from './demoSong';
import { loadStemFiles, loadTempo } from './stemLoader';
import { loopRegion, mod, nextBoundary, segmentPosition, songPosition, type Grid, type Segment } from './transport';

/** Amplitude envelope resolution used for waveform visuals. */
const ENVELOPE_RATE = 100; // buckets per second
/** Smoothing time for parameter changes (s); avoids zipper noise. */
const RAMP = 0.03;
const BEATS_PER_BAR = 4;
/** Drops land on bar downbeats. */
const DROP_QUANTUM_BEATS = BEATS_PER_BAR;
/** Scheduling headroom so boundary events are never in the past (s). */
const LEAD = 0.05;
/** Build: master highpass sweep range (Hz). */
const BUILD_HPF = { min: 12, max: 1400 };
/** Build: how much each stem's level is reduced at full build (0..1). */
const BUILD_DUCK: Record<string, number> = { bass: 0.85, drums: 0.3 };
/** DJ filter ranges (Hz). */
const LOWPASS_MIN = 160;
const HIGHPASS_MAX = 5000;

interface Channel {
  buffer: AudioBuffer;
  /** Scheduled playback segments, oldest first; the latest started one is playing. */
  segments: { source: AudioBufferSourceNode; seg: Segment }[];
  /** setFx: lowpass sweep + resonance + echo send. */
  filter: BiquadFilterNode;
  /** setFilter: DJ filter, one side at a time. */
  djLow: BiquadFilterNode;
  djHigh: BiquadFilterNode;
  gain: GainNode;
  /** Separate from the fader, so mute/solo never lose the fader value. */
  muteGain: GainNode;
  /** Silences a stem while a clip pulled from it is playing. */
  duckGain: GainNode;
  /** Build/drop ducking. Separate again, so performance effects never touch the mix. */
  perfGain: GainNode;
  panner: StereoPannerNode;
  send: GainNode;
  analyser: AnalyserNode;
  scratch: Float32Array<ArrayBuffer>;
  level: number;
  /** Peak amplitude per bucket, normalized to [0, 1]. */
  envelope: Float32Array;
  /** Bumped on every loop command, so stale "engaged" timers do nothing. */
  loopGen: number;
  /** For loop clips: the source stem. */
  clipOf: StemId | null;
  /** Every node of the chain, for disconnecting a removed clip. */
  nodes: AudioNode[];
}

/**
 * Plays synced, looping stems and applies AudioCommands:
 *   setVolume       -> fader gain (perceptual curve)
 *   setMute/setSolo -> mute gain (keeps the fader value)
 *   setPan          -> stereo panner
 *   setFx           -> lowpass sweep + resonance + dotted-eighth echo send
 *   setFilter       -> DJ lowpass (<0) / highpass (>0)
 *   setLoop         -> beat-quantized slip loop of 1/2/4/8 beats
 *   setBuild / drop -> master highpass riser + ducking, released on the bar
 *   createClip / removeClip -> beat-synced loop clip voices pulled from a stem
 *
 * Signal flow per stem:
 *   source -> fx lowpass -> dj lowpass -> dj highpass -> fader -> mute -> clip duck -> perf -> pan -> bus
 * Loop clips (createClip) are extra channels playing a looped region of their source's buffer.
 * Master: bus -> build highpass -> master -> limiter -> out (echo + riser join before the highpass).
 *
 * It is the single source of truth for stem state: UIs read `stems`,
 * `perf` and `transport`, and `subscribe()`, rather than keeping copies.
 *
 * Stand-in for the Task 1 engine (single deck). Uses stem files from
 * /stems/ if present, otherwise a generated demo song.
 */
export class WebAudioEngine implements AudioCommandSink, AudioStateSource {
  readonly stems = new Map<StemId, StemState>();
  readonly perf: PerformanceState = defaultPerformanceState();
  private channels = new Map<StemId, Channel>();
  private listeners = new Set<() => void>();
  private startAt = -1;
  private duration: number;
  private master: GainNode;
  private buildHpf: BiquadFilterNode;
  private buildSend: GainNode;
  private riserGain: GainNode;
  private riserBand: BiquadFilterNode;
  private noise: AudioBuffer;
  private riserSource: AudioBufferSourceNode | null = null;
  private dropTimer: ReturnType<typeof setTimeout> | null = null;
  private bus!: GainNode;
  private delay!: DelayNode;

  private constructor(
    private ctx: AudioContext,
    buffers: Record<string, AudioBuffer>,
    readonly sourceKind: 'files' | 'demo',
    private tempo: { bpm: number; firstBeatSec: number } | null,
  ) {
    this.duration = Math.min(...Object.values(buffers).map((b) => b.duration));
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.ratio.value = 8;
    this.master.connect(limiter).connect(ctx.destination);

    this.buildHpf = ctx.createBiquadFilter();
    this.buildHpf.type = 'highpass';
    this.buildHpf.frequency.value = BUILD_HPF.min;
    this.buildHpf.Q.value = 0.7;
    this.buildHpf.connect(this.master);
    const bus = ctx.createGain();
    bus.connect(this.buildHpf);

    // Shared spacey delay used by stretch FX and by the build wash.
    const delay = ctx.createDelay(2);
    delay.delayTime.value = this.tempo ? (60 / this.tempo.bpm) * 0.75 : 0.375; // dotted eighth
    const feedback = ctx.createGain();
    feedback.gain.value = 0.38;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 3500;
    delay.connect(tone).connect(feedback).connect(delay);
    tone.connect(this.buildHpf);
    this.buildSend = ctx.createGain();
    this.buildSend.gain.value = 0;
    bus.connect(this.buildSend).connect(delay);

    // Noise riser for builds.
    this.noise = noiseBuffer(ctx, 2);
    this.riserBand = ctx.createBiquadFilter();
    this.riserBand.type = 'bandpass';
    this.riserBand.frequency.value = 300;
    this.riserBand.Q.value = 1.4;
    this.riserGain = ctx.createGain();
    this.riserGain.gain.value = 0;
    this.riserBand.connect(this.riserGain).connect(this.buildHpf);

    this.bus = bus;
    this.delay = delay;
    for (const [id, buffer] of Object.entries(buffers)) {
      this.channels.set(id, this.makeChannel(buffer, computeEnvelope(buffer), null));
      this.stems.set(id, defaultStemState());
    }
  }

  /** Build one channel's node chain (see the signal flow in the class comment). */
  private makeChannel(buffer: AudioBuffer, envelope: Float32Array, clipOf: StemId | null): Channel {
    const ctx = this.ctx;
    const filter = biquad(ctx, 'lowpass', 20000, 0.7);
    const djLow = biquad(ctx, 'lowpass', 20000, 0.7);
    const djHigh = biquad(ctx, 'highpass', 10, 0.7);
    const gain = ctx.createGain();
    const muteGain = ctx.createGain();
    const duckGain = ctx.createGain();
    const perfGain = ctx.createGain();
    const panner = ctx.createStereoPanner();
    const send = ctx.createGain();
    send.gain.value = 0;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;

    filter.connect(djLow).connect(djHigh).connect(gain).connect(muteGain).connect(duckGain).connect(perfGain).connect(panner);
    panner.connect(this.bus);
    panner.connect(analyser);
    panner.connect(send).connect(this.delay);

    return {
      buffer,
      segments: [],
      filter,
      djLow,
      djHigh,
      gain,
      muteGain,
      duckGain,
      perfGain,
      panner,
      send,
      analyser,
      scratch: new Float32Array(analyser.fftSize),
      level: 0,
      envelope,
      loopGen: 0,
      clipOf,
      nodes: [filter, djLow, djHigh, gain, muteGain, duckGain, perfGain, panner, send, analyser],
    };
  }

  /** Builds the engine (suspended until start()). Safe to call before any user gesture. */
  static async create(stemIds: string[]): Promise<WebAudioEngine> {
    const ctx = new AudioContext();
    const files = await loadStemFiles(ctx, stemIds);
    if (files) return new WebAudioEngine(ctx, files, 'files', await loadTempo());
    return new WebAudioEngine(ctx, await renderDemoStems(ctx.sampleRate), 'demo', { bpm: DEMO_BPM, firstBeatSec: 0 });
  }

  get started(): boolean {
    return this.startAt >= 0;
  }

  get playing(): boolean {
    return this.started && this.ctx.state === 'running';
  }

  /** Beat grid on the context clock, or null if the tempo is unknown or not started. */
  get grid(): Grid | null {
    if (!this.tempo || !this.started) return null;
    return { startAt: this.startAt, duration: this.duration, beatSec: 60 / this.tempo.bpm, firstBeat: this.tempo.firstBeatSec };
  }

  get transport(): TransportState {
    const g = this.grid;
    let anchorMs: number | null = null;
    if (g && this.playing) {
      // Downbeat of the current pass, so songs that aren't a whole number of beats long stay close.
      const now = this.ctx.currentTime;
      const passStart = g.startAt + Math.floor((now - g.startAt) / g.duration) * g.duration;
      anchorMs = this.wallTime(passStart + g.firstBeat);
    }
    return {
      playing: this.playing,
      bpm: this.tempo?.bpm ?? null,
      beatsPerBar: BEATS_PER_BAR,
      anchorMs,
      durationSec: this.duration,
    };
  }

  /** Must be called from a user gesture (click / key) the first time. */
  async start(): Promise<void> {
    await this.ctx.resume();
    if (this.started) return;
    this.startAt = this.ctx.currentTime + LEAD;
    for (const ch of this.channels.values()) {
      this.schedule(ch, { ctxStart: this.startAt, offset: 0, loopStart: 0, loopEnd: ch.buffer.duration });
    }
    const riser = this.ctx.createBufferSource();
    riser.buffer = this.noise;
    riser.loop = true;
    riser.connect(this.riserBand);
    riser.start(this.startAt);
    this.riserSource = riser;
    this.notify();
  }

  async togglePause(): Promise<void> {
    if (!this.started) return this.start();
    if (this.ctx.state === 'running') await this.ctx.suspend();
    else await this.ctx.resume();
    this.notify();
  }

  dispatch(command: AudioCommand): void {
    if (isStemCommand(command)) this.dispatchStem(command);
    else this.dispatchPerformance(command);
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  private dispatchStem(command: StemCommand): void {
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
        stem.pan = clamp(command.value, -1, 1);
        ch.panner.pan.setTargetAtTime(stem.pan, now, RAMP);
        break;
      case 'setVolume':
        stem.volume = clamp(command.value, 0, 1);
        ch.gain.gain.setTargetAtTime(stem.volume ** 2, now, RAMP);
        break;
      case 'setMute':
        stem.muted = command.value;
        this.applyAudibility();
        break;
      case 'setSolo':
        stem.solo = command.value;
        this.applyAudibility();
        break;
      case 'setFx': {
        const a = clamp(command.value, 0, 1);
        stem.fx = a;
        ch.filter.frequency.setTargetAtTime(20000 * (500 / 20000) ** a, now, RAMP * 2);
        ch.filter.Q.setTargetAtTime(0.7 + 7 * a, now, RAMP * 2);
        ch.send.gain.setTargetAtTime(0.55 * a, now, RAMP * 2);
        break;
      }
      case 'setFilter': {
        let v = clamp(command.value, -1, 1);
        if (Math.abs(v) < 0.02) v = 0;
        stem.filter = v;
        const lp = v < 0 ? 20000 * (LOWPASS_MIN / 20000) ** -v : 20000;
        const hp = v > 0 ? 10 * (HIGHPASS_MAX / 10) ** v : 10;
        ch.djLow.frequency.setTargetAtTime(lp, now, RAMP);
        ch.djLow.Q.setTargetAtTime(0.7 + 4 * Math.max(0, -v), now, RAMP);
        ch.djHigh.frequency.setTargetAtTime(hp, now, RAMP);
        ch.djHigh.Q.setTargetAtTime(0.7 + 4 * Math.max(0, v), now, RAMP);
        break;
      }
      case 'setLoop':
        this.setLoop(command.stemId, ch, stem, command.beats);
        break;
      case 'createClip':
        this.createClip(command.stemId, ch, command.clipId, command.beats);
        break;
      case 'removeClip':
        this.removeClip(command.stemId, ch);
        break;
    }
  }

  /**
   * Engage / change / exit a loop on the next beat. Implemented by starting a
   * new buffer source at the exact sample position the old one would reach at
   * that moment, so the switch is seamless and stays phase-locked.
   */
  private setLoop(id: StemId, ch: Channel, stem: StemState, beats: LoopBeats | null): void {
    const g = this.grid;
    if (!g || !this.playing) return; // tempo unknown or paused: no loops (state unchanged)
    if (beats === null && !stem.loop) return;
    const now = this.ctx.currentTime;
    const T = nextBoundary(g, now, 1, LEAD);
    const q = this.positionAt(ch, T);

    let seg: Segment;
    if (beats === null) {
      seg = { ctxStart: T, offset: songPosition(g, T), loopStart: 0, loopEnd: ch.buffer.duration };
    } else {
      const len = beats * g.beatSec;
      // Changing length keeps the loop's start; a new loop starts at the current beat.
      const region = stem.loop ? loopRegion(g, stem.loop.startSec, beats) : loopRegion(g, q, beats);
      const offset = region.start + mod(q - region.start, region.end - region.start || len);
      seg = { ctxStart: T, offset, loopStart: region.start, loopEnd: region.end };
    }
    this.schedule(ch, seg);

    const gen = ++ch.loopGen;
    if (beats !== null) stem.loop = { beats, startSec: seg.loopStart, endSec: seg.loopEnd, engaged: false };
    setTimeout(
      () => {
        if (ch.loopGen !== gen) return;
        const s = this.stems.get(id)!;
        s.loop = beats === null ? null : { ...s.loop!, engaged: true };
        this.notify();
      },
      Math.max(0, (T - now) * 1000),
    );
  }

  /**
   * New voice looping the last `beats` beats of the source (ending on the
   * current beat), starting on the next beat, phase-locked to the grid.
   */
  private createClip(sourceId: StemId, src: Channel, clipId: StemId, beats: LoopBeats): void {
    const g = this.grid;
    if (!g || !this.playing || this.channels.has(clipId) || src.clipOf) return;
    const now = this.ctx.currentTime;
    const T = nextBoundary(g, now, 1, LEAD);
    const q = this.positionAt(src, T);
    const len = beats * g.beatSec;
    // The phrase that just played: `beats` beats ending at the beat we're on.
    let end = g.firstBeat + Math.round((q - g.firstBeat) / g.beatSec) * g.beatSec;
    let start = end - len;
    if (start < 0) {
      start = 0;
      end = Math.min(src.buffer.duration, len);
    }
    const ch = this.makeChannel(src.buffer, src.envelope, sourceId);
    this.channels.set(clipId, ch);
    this.schedule(ch, { ctxStart: T, offset: start + mod(q - start, end - start), loopStart: start, loopEnd: end });
    this.stems.set(clipId, {
      ...defaultStemState(),
      clipOf: sourceId,
      loop: { beats, startSec: start, endSec: end, engaged: false },
    });
    this.applyAudibility();
    // The source steps aside while its phrase loops.
    src.duckGain.gain.setTargetAtTime(0, T, 0.01);
    this.stems.get(sourceId)!.ducked = true;
    const gen = ++ch.loopGen;
    setTimeout(
      () => {
        const s = this.stems.get(clipId);
        if (!s || ch.loopGen !== gen || !s.loop) return;
        s.loop = { ...s.loop, engaged: true };
        this.notify();
      },
      Math.max(0, (T - now) * 1000),
    );
  }

  /** Stop a clip on the next beat and bring its source back. */
  private removeClip(clipId: StemId, ch: Channel): void {
    const sourceId = ch.clipOf;
    if (!sourceId) return;
    const now = this.ctx.currentTime;
    const g = this.grid;
    const T = g && this.playing ? nextBoundary(g, now, 1, LEAD) : now;
    for (const s of ch.segments) safeStop(s.source, T + 0.02);
    ch.duckGain.gain.setTargetAtTime(0, T, 0.006);
    this.channels.delete(clipId);
    const othersLeft = [...this.channels.values()].some((c) => c.clipOf === sourceId);
    const src = this.channels.get(sourceId);
    if (src && !othersLeft) src.duckGain.gain.setTargetAtTime(1, T, 0.006);
    setTimeout(
      () => {
        this.stems.delete(clipId);
        const source = this.stems.get(sourceId);
        if (source && !othersLeft) source.ducked = false;
        this.applyAudibility();
        this.notify();
        setTimeout(() => ch.nodes.forEach((n) => n.disconnect()), 200);
      },
      Math.max(0, (T - now) * 1000),
    );
  }

  private dispatchPerformance(command: PerformanceCommand): void {
    if (!this.started) return;
    const now = this.ctx.currentTime;
    switch (command.type) {
      case 'setBuild': {
        if (this.perf.dropPending) return;
        const v = clamp(command.value, 0, 1);
        // Rise quickly, fall back gently (cancelling a build shouldn't lurch).
        const tc = v >= this.perf.build ? 0.06 : 0.25;
        this.perf.build = v;
        this.applyBuild(v, now, tc);
        break;
      }
      case 'drop': {
        if (this.perf.dropPending || this.perf.build < 0.05) return;
        if (!this.playing) {
          this.perf.build = 0;
          this.applyBuild(0, now, 0.05);
          return;
        }
        const g = this.grid;
        const T = g ? nextBoundary(g, now, DROP_QUANTUM_BEATS, LEAD) : now + LEAD;
        const peak = this.perf.build;
        // Final push into the drop: tension keeps climbing until the downbeat.
        this.applyBuild(Math.min(1, peak + 0.15), now, Math.max(0.02, (T - now) / 3));
        // The drop itself.
        this.buildHpf.frequency.setTargetAtTime(BUILD_HPF.min, T, 0.012);
        this.buildHpf.Q.setTargetAtTime(0.7, T, 0.02);
        this.riserGain.gain.setTargetAtTime(0, T, 0.01);
        this.buildSend.gain.setTargetAtTime(0, T, 0.35);
        for (const ch of this.channels.values()) ch.perfGain.gain.setTargetAtTime(1, T, 0.008);
        this.impact(T, peak);

        this.perf.dropPending = true;
        this.perf.dropAtMs = this.wallTime(T);
        this.perf.dropQuantized = g !== null;
        if (this.dropTimer) clearTimeout(this.dropTimer);
        this.dropTimer = setTimeout(() => {
          this.perf.dropPending = false;
          this.perf.build = 0;
          this.perf.drops++;
          this.dropTimer = null;
          this.notify();
        }, Math.max(0, (T - now) * 1000));
        break;
      }
    }
  }

  /** Master-bus build: highpass sweep, bass/drum duck, echo wash, noise riser. */
  private applyBuild(v: number, at: number, tc: number): void {
    const shaped = v ** 1.6;
    this.buildHpf.frequency.setTargetAtTime(BUILD_HPF.min * (BUILD_HPF.max / BUILD_HPF.min) ** shaped, at, tc);
    this.buildHpf.Q.setTargetAtTime(0.7 + 5 * shaped, at, tc);
    this.buildSend.gain.setTargetAtTime(0.5 * v, at, tc);
    this.riserGain.gain.setTargetAtTime(0.14 * v * v, at, tc);
    this.riserBand.frequency.setTargetAtTime(300 * (9000 / 300) ** v, at, tc);
    for (const [id, ch] of this.channels) {
      ch.perfGain.gain.setTargetAtTime(1 - (BUILD_DUCK[ch.clipOf ?? id] ?? 0) * v, at, tc);
    }
  }

  /** Sub boom + noise crash on the drop. */
  private impact(T: number, strength: number): void {
    const ctx = this.ctx;
    const level = 0.35 + 0.35 * strength;
    const sub = ctx.createOscillator();
    sub.frequency.setValueAtTime(95, T);
    sub.frequency.exponentialRampToValueAtTime(38, T + 0.45);
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.0001, T);
    subGain.gain.exponentialRampToValueAtTime(level, T + 0.008);
    subGain.gain.exponentialRampToValueAtTime(0.0001, T + 1.2);
    sub.connect(subGain).connect(this.master);
    sub.start(T);
    sub.stop(T + 1.3);

    const crash = ctx.createBufferSource();
    crash.buffer = this.noise;
    const hp = biquad(ctx, 'highpass', 2500, 0.7);
    const crashGain = ctx.createGain();
    crashGain.gain.setValueAtTime(0.0001, T);
    crashGain.gain.exponentialRampToValueAtTime(0.12 * level, T + 0.005);
    crashGain.gain.exponentialRampToValueAtTime(0.0001, T + 1.4);
    crash.connect(hp).connect(crashGain).connect(this.master);
    crash.start(T);
    crash.stop(T + 1.5);
  }

  /** Start a source for `seg`, stop the previous one at the same instant, and prune finished ones. */
  private schedule(ch: Channel, seg: Segment): void {
    const src = this.ctx.createBufferSource();
    src.buffer = ch.buffer;
    src.loop = true;
    src.loopStart = seg.loopStart;
    src.loopEnd = seg.loopEnd;
    src.connect(ch.filter);
    src.start(seg.ctxStart, seg.offset);
    // Pending segments the new one replaces never play.
    for (const s of ch.segments) {
      if (s.seg.ctxStart < seg.ctxStart) continue;
      safeStop(s.source);
      s.source.disconnect();
    }
    ch.segments = ch.segments.filter((s) => s.seg.ctxStart < seg.ctxStart);
    // Drop segments that have already handed over to a successor.
    const now = this.ctx.currentTime;
    while (ch.segments.length > 1 && ch.segments[1].seg.ctxStart <= now) {
      ch.segments.shift()!.source.disconnect();
    }
    // The latest remaining one hands over to the new segment, sample-exactly.
    const last = ch.segments[ch.segments.length - 1];
    if (last) safeStop(last.source, seg.ctxStart);
    ch.segments.push({ source: src, seg });
  }

  private positionAt(ch: Channel, t: number): number {
    let current: Segment | null = null;
    for (const s of ch.segments) if (s.seg.ctxStart <= t + 1e-6) current = s.seg;
    current ??= ch.segments[0]?.seg ?? null;
    return current ? segmentPosition(current, t) : 0;
  }

  /** Context time -> wall-clock ms (performance.timeOrigin based), including output latency. */
  private wallTime(ctxTime: number): number {
    const ts = this.ctx.getOutputTimestamp?.();
    if (ts && ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0) {
      return performance.timeOrigin + ts.performanceTime + (ctxTime - ts.contextTime) * 1000;
    }
    const latency = (this.ctx.outputLatency || this.ctx.baseLatency || 0) * 1000;
    return wallNow() + (ctxTime - this.ctx.currentTime) * 1000 + latency;
  }

  /** Recompute which stems can be heard from mute + solo, and ramp their mute gains. */
  private applyAudibility(): void {
    const anySolo = [...this.stems.values()].some((s) => s.solo);
    const now = this.ctx.currentTime;
    for (const [id, s] of this.stems) {
      s.audible = !s.muted && (!anySolo || s.solo);
      this.channels.get(id)?.muteGain.gain.setTargetAtTime(s.audible ? 1 : 0, now, RAMP);
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

  /** Playback position within this stem's buffer, seconds (follows loops). */
  position(stemId: StemId): number {
    const ch = this.channels.get(stemId);
    if (!ch || !this.started) return 0;
    return this.positionAt(ch, this.ctx.currentTime);
  }

  /** Master-timeline song position (ignores stem loops), seconds. */
  songPosition(): number {
    if (!this.started) return 0;
    return songPosition({ startAt: this.startAt, duration: this.duration, beatSec: 1, firstBeat: 0 }, this.ctx.currentTime);
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

  /** Stop everything and release the audio device. */
  async close(): Promise<void> {
    if (this.dropTimer) clearTimeout(this.dropTimer);
    this.riserSource?.stop();
    for (const ch of this.channels.values()) for (const s of ch.segments) safeStop(s.source);
    this.listeners.clear();
    await this.ctx.close();
  }
}

function safeStop(source: AudioBufferSourceNode, when?: number): void {
  try {
    source.stop(when);
  } catch {
    /* already stopped */
  }
}

function biquad(ctx: BaseAudioContext, type: BiquadFilterType, freq: number, q: number): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

function noiseBuffer(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const b = ctx.createBuffer(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
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
