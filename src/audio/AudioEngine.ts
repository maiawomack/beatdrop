import {
  DECK_IDS,
  EQ_BANDS,
  STEM_IDS,
  type AudioCommand,
  type AudioEngineState,
  type ChannelKey,
  type DeckId,
  type DeckState,
  type StemId,
} from '../shared/types';
import { loadTrack as loadStems } from '../stems';
import { DeckChannel, clamp, loadScrubProcessor } from './DeckChannel';
import { estimateTempo } from './tempo';

/** Build-up: master high-pass sweep range (Hz). */
const BUILD_HPF = { min: 12, max: 1400 };
/** Build-up: how much each stem is ducked at full build. Full mixes rely on the high-pass. */
const BUILD_DUCK: Partial<Record<ChannelKey, number>> = { bass: 0.85, drums: 0.3 };
const BEATS_PER_BAR = 4;
/** Scheduling headroom for beat-quantized events (s). */
const LEAD = 0.05;

type Listener = (state: AudioEngineState) => void;

/**
 * The single authoritative audio engine. Exactly one window should construct it;
 * every other subsystem changes audio only through dispatch(command) and reads
 * state through subscribe()/getState().
 *
 * Both decks run through Web Audio into one master bus, so they play, layer and
 * crossfade simultaneously with every control (stems, EQ, filter, echo, loops, rate).
 */
export class AudioEngine {
  readonly ctx: AudioContext;

  private readonly master: GainNode;
  /** Copy of the master mix as a MediaStream, for recording sets. */
  private readonly recordTap: MediaStreamAudioDestinationNode;
  private readonly channels: Record<DeckId, DeckChannel>;
  private readonly state: AudioEngineState;
  private readonly listeners = new Set<Listener>();
  private readonly loadSeq: Record<DeckId, number> = { A: 0, B: 0 };
  private readonly loadAbort: Record<DeckId, AbortController | null> = { A: null, B: null };
  // Build/drop master chain (spatial workstation).
  private readonly buildHpf: BiquadFilterNode;
  private readonly buildSend: GainNode;
  private readonly buildDelay: DelayNode;
  private readonly riserGain: GainNode;
  private readonly riserBand: BiquadFilterNode;
  private readonly noise: AudioBuffer;
  private riserSource: AudioBufferSourceNode | null = null;
  private dropTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    // master ─► build high-pass ─► out, plus an echo wash and a noise riser for build-ups.
    this.buildHpf = this.ctx.createBiquadFilter();
    this.buildHpf.type = 'highpass';
    this.buildHpf.frequency.value = BUILD_HPF.min;
    this.buildHpf.Q.value = 0.7;
    this.master.connect(this.buildHpf).connect(this.ctx.destination);
    // Recordings capture the final mix, build/drop included.
    this.recordTap = this.ctx.createMediaStreamDestination();
    this.buildHpf.connect(this.recordTap);
    this.buildSend = this.ctx.createGain();
    this.buildSend.gain.value = 0;
    this.buildDelay = this.ctx.createDelay(2);
    this.buildDelay.delayTime.value = 0.375;
    const feedback = this.ctx.createGain();
    feedback.gain.value = 0.4;
    const tone = this.ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 3500;
    this.master.connect(this.buildSend).connect(this.buildDelay);
    this.buildDelay.connect(tone).connect(feedback).connect(this.buildDelay);
    tone.connect(this.buildHpf);
    this.noise = noiseBuffer(this.ctx, 2);
    this.riserBand = this.ctx.createBiquadFilter();
    this.riserBand.type = 'bandpass';
    this.riserBand.frequency.value = 300;
    this.riserBand.Q.value = 1.4;
    this.riserGain = this.ctx.createGain();
    this.riserGain.gain.value = 0;
    this.riserBand.connect(this.riserGain).connect(this.buildHpf);
    // Scratching needs a small audio processor; load it up front so the first scratch is instant.
    void loadScrubProcessor(this.ctx);

    this.channels = {
      A: new DeckChannel(this.ctx, this.master),
      B: new DeckChannel(this.ctx, this.master),
    };
    this.state = {
      decks: { A: emptyDeck('A'), B: emptyDeck('B') },
      mixer: { crossfader: 0, masterGain: 1, build: 0, dropPending: false, dropAtMs: null, dropQuantized: false, drops: 0 },
    };

    for (const id of DECK_IDS) {
      this.channels[id].onEnded = () => {
        this.state.decks[id].playing = false;
        this.stampPosition(id, this.channels[id].duration);
        this.emit();
      };
    }
    this.applyCrossfader();
  }

  /** Browsers start AudioContexts suspended; call from a user gesture (click/keydown). */
  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume();
    if (!this.riserSource) {
      const riser = this.ctx.createBufferSource();
      riser.buffer = this.noise;
      riser.loop = true;
      riser.connect(this.riserBand);
      riser.start();
      this.riserSource = riser;
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  /** A serializable snapshot with up-to-date positions. */
  getState(): AudioEngineState {
    for (const id of DECK_IDS) this.refreshPosition(id);
    return structuredClone(this.state);
  }

  /** Live playhead position in seconds — cheap enough to call every animation frame. */
  getPositionSec(deck: DeckId): number {
    // While a hand is on the record, the playhead is where the scratch is (what you hear);
    // the song keeps running underneath and the playhead returns there on release.
    const ch = this.channels[deck];
    return ch.scratchPosition() ?? ch.position();
  }

  /** Live output level per stem, 0..1, for meters (all zero while paused). */
  getLevels(deck: DeckId): Record<StemId, number> {
    return this.channels[deck].levels();
  }

  /** The master mix as a MediaStream, e.g. for MediaRecorder. */
  getOutputStream(): MediaStream {
    void this.resume();
    return this.recordTap.stream;
  }

  async dispatch(cmd: AudioCommand): Promise<void> {
    switch (cmd.type) {
      case 'LOAD_TRACK':
        return this.load(cmd.deck, cmd);
      case 'UNLOAD_TRACK':
        this.loadAbort[cmd.deck]?.abort();
        this.loadSeq[cmd.deck]++;
        this.channels[cmd.deck].unload();
        this.state.decks[cmd.deck] = { ...emptyDeck(cmd.deck), ...this.keepControls(cmd.deck) };
        break;
      case 'PLAY':
        return this.play(cmd.deck);
      case 'PAUSE':
        this.pause(cmd.deck);
        break;
      case 'TOGGLE_PLAY':
        if (this.state.decks[cmd.deck].playing) this.pause(cmd.deck);
        else return this.play(cmd.deck);
        break;
      case 'SEEK': {
        const deck = this.state.decks[cmd.deck];
        if (deck.status !== 'ready') return;
        const target = clamp(cmd.positionSec, 0, deck.durationSec);
        this.channels[cmd.deck].seek(target);
        this.stampPosition(cmd.deck, target);
        break;
      }
      case 'SET_DECK_GAIN': {
        const gain = clamp(cmd.gain, 0, 1);
        this.state.decks[cmd.deck].gain = gain;
        this.channels[cmd.deck].setFader(gain);
        break;
      }
      case 'SET_STEM_GAIN':
        this.state.decks[cmd.deck].stems[cmd.stem].gain = clamp(cmd.gain, 0, 1);
        this.applyStem(cmd.deck, cmd.stem);
        break;
      case 'SET_STEM_MUTE':
        this.state.decks[cmd.deck].stems[cmd.stem].muted = cmd.muted;
        this.applyStem(cmd.deck, cmd.stem);
        break;
      case 'SET_EQ': {
        const db = clamp(cmd.gainDb, -24, 6);
        this.state.decks[cmd.deck].eq[cmd.band] = db;
        this.channels[cmd.deck].setEq(cmd.band, db);
        break;
      }
      case 'SET_FILTER': {
        const value = clamp(cmd.value, -1, 1);
        this.state.decks[cmd.deck].filter = value;
        this.channels[cmd.deck].setFilter(value);
        break;
      }
      case 'SET_ECHO': {
        const amount = clamp(cmd.amount, 0, 1);
        this.state.decks[cmd.deck].echo = amount;
        this.channels[cmd.deck].setEcho(amount);
        break;
      }
      case 'SET_LOOP': {
        const deck = this.state.decks[cmd.deck];
        const startSec = clamp(cmd.startSec, 0, deck.durationSec);
        const endSec = clamp(cmd.endSec, 0, deck.durationSec);
        if (endSec - startSec < 0.05) return;
        deck.loop = { startSec, endSec };
        this.channels[cmd.deck].setLoop(deck.loop);
        break;
      }
      case 'CLEAR_LOOP':
        this.state.decks[cmd.deck].loop = null;
        this.channels[cmd.deck].setLoop(null);
        break;
      case 'SET_PLAYBACK_RATE': {
        const rate = clamp(cmd.rate, 0.5, 2);
        this.state.decks[cmd.deck].playbackRate = rate;
        this.channels[cmd.deck].setRate(rate);
        break;
      }
      case 'SET_BPM': {
        const deck = this.state.decks[cmd.deck];
        deck.bpm = cmd.bpm;
        deck.bpmSource = cmd.bpm === null ? null : 'manual';
        this.applyGrid(cmd.deck);
        break;
      }
      case 'SET_CHANNEL_FILTER': {
        const value = clamp(cmd.value, -1, 1);
        this.state.decks[cmd.deck].channelFilter[cmd.channel] = value;
        this.channels[cmd.deck].setChannelFilter(cmd.channel, value);
        break;
      }
      case 'SET_LOOP_BEATS':
        this.loopBeats(cmd.deck, cmd.beats);
        break;
      case 'CREATE_CLIP':
        this.createClip(cmd.deck, cmd.channel, cmd.clipId, cmd.beats);
        break;
      case 'REMOVE_CLIP':
        this.removeClip(cmd.deck, cmd.clipId);
        return;
      case 'SET_CLIP_GAIN': {
        const clip = this.state.decks[cmd.deck].clips[cmd.clipId];
        if (!clip) return;
        clip.gain = clamp(cmd.gain, 0, 1);
        this.channels[cmd.deck].setClipGain(cmd.clipId, clip.gain);
        break;
      }
      case 'SET_CLIP_MUTE': {
        const clip = this.state.decks[cmd.deck].clips[cmd.clipId];
        if (!clip) return;
        clip.muted = cmd.muted;
        this.channels[cmd.deck].setClipMute(cmd.clipId, cmd.muted);
        break;
      }
      case 'SET_CLIP_FILTER': {
        const clip = this.state.decks[cmd.deck].clips[cmd.clipId];
        if (!clip) return;
        clip.filter = clamp(cmd.value, -1, 1);
        this.channels[cmd.deck].setClipFilter(cmd.clipId, clip.filter);
        break;
      }
      case 'SET_BUILD': {
        const mixer = this.state.mixer;
        if (mixer.dropPending) return;
        const v = clamp(cmd.value, 0, 1);
        // Rise quickly, fall back gently (cancelling shouldn't lurch).
        const tc = v >= mixer.build ? 0.06 : 0.25;
        mixer.build = v;
        this.applyBuild(v, this.ctx.currentTime, tc);
        break;
      }
      case 'DROP':
        this.drop();
        break;
      case 'SCRATCH_START': {
        const deck = this.state.decks[cmd.deck];
        if (deck.status !== 'ready' || deck.scratching) return;
        void this.resume();
        if (!this.channels[cmd.deck].startScratch()) return;
        deck.scratching = true;
        break;
      }
      case 'SCRATCH_MOVE':
        // Streams at gesture rate: no state change, so no broadcast.
        this.channels[cmd.deck].moveScratch(cmd.offsetSec);
        return;
      case 'SCRATCH_END':
        if (!this.state.decks[cmd.deck].scratching) return;
        this.channels[cmd.deck].endScratch();
        this.state.decks[cmd.deck].scratching = false;
        break;
      case 'SET_CROSSFADER':
        this.state.mixer.crossfader = clamp(cmd.value, -1, 1);
        this.applyCrossfader();
        break;
      case 'SET_MASTER_GAIN': {
        const gain = clamp(cmd.gain, 0, 1);
        this.state.mixer.masterGain = gain;
        this.master.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.012);
        break;
      }
      default:
        assertNever(cmd);
    }
    this.emit();
  }

  // -------------------------------------------------------------------------

  private async load(id: DeckId, cmd: Extract<AudioCommand, { type: 'LOAD_TRACK' }>): Promise<void> {
    const seq = ++this.loadSeq[id];
    this.loadAbort[id]?.abort();
    const abort = new AbortController();
    this.loadAbort[id] = abort;

    const deck: DeckState = {
      ...emptyDeck(id),
      ...this.keepControls(id),
      track: cmd.track,
      status: 'loading',
      bpm: cmd.track.bpm,
    };
    this.state.decks[id] = deck;
    this.channels[id].unload();
    this.emit();

    try {
      const channel = this.channels[id];
      if (cmd.track.stemsManifestUrl) {
        // Task 5's loader validates the manifest and guarantees equal-length buffers.
        const loaded = await loadStems(this.ctx, cmd.track.stemsManifestUrl, { signal: abort.signal });
        if (seq !== this.loadSeq[id]) return;
        channel.setBuffers(loaded.buffers);
        deck.bpm = loaded.manifest.bpm;
        deck.firstBeatSec = loaded.manifest.firstBeatSec ?? 0;
        deck.bpmSource = 'manifest';
      } else if (cmd.track.audioUrl) {
        await channel.loadFullMix(cmd.track.audioUrl, abort.signal);
        if (seq !== this.loadSeq[id]) return;
        if (deck.bpm === null) {
          // Library files have no BPM: estimate it so loops, clips and drops can follow the beat.
          const buffer = channel.bufferFor('full');
          const est = buffer ? estimateTempo(channelData(buffer), buffer.sampleRate) : null;
          if (est) {
            deck.bpm = est.bpm;
            deck.firstBeatSec = est.firstBeatSec;
            deck.bpmSource = 'estimated';
          }
        } else {
          deck.bpmSource = 'manual';
        }
      } else {
        throw new Error('Track has no audio source');
      }
      deck.source = channel.hasStems ? 'stems' : 'full';
      deck.durationSec = channel.duration;
      deck.track = { ...cmd.track, durationMs: Math.round(deck.durationSec * 1000) };
      const loadedStems = channel.loadedStems;
      for (const s of STEM_IDS) deck.stems[s].available = loadedStems.includes(s);
      deck.status = 'ready';
    } catch (err) {
      if (seq !== this.loadSeq[id] || isAbort(err)) return;
      deck.status = 'error';
      deck.error = errorMessage(err);
    } finally {
      if (seq === this.loadSeq[id]) this.loadAbort[id] = null;
    }

    this.applyGrid(id);
    this.applyDeckControls(id);
    this.stampPosition(id, 0);
    this.emit();
  }

  private async play(id: DeckId): Promise<void> {
    const deck = this.state.decks[id];
    if (deck.status !== 'ready' || deck.playing) return;
    await this.resume();
    this.channels[id].play();
    deck.playing = true;
    this.stampPosition(id, this.channels[id].position());
    this.emit();
  }

  private pause(id: DeckId): void {
    const deck = this.state.decks[id];
    if (!deck.playing) return;
    this.channels[id].pause();
    deck.playing = false;
    this.refreshPosition(id);
  }

  /** Controls that survive loading a new track (mixer-style settings). */
  private keepControls(id: DeckId): Pick<DeckState, 'gain' | 'eq' | 'filter' | 'echo' | 'playbackRate'> {
    const d = this.state.decks[id];
    return { gain: d.gain, eq: { ...d.eq }, filter: d.filter, echo: d.echo, playbackRate: d.playbackRate };
  }

  private applyDeckControls(id: DeckId): void {
    const d = this.state.decks[id];
    const ch = this.channels[id];
    ch.setFader(d.gain);
    for (const band of EQ_BANDS) ch.setEq(band, d.eq[band]);
    ch.setFilter(d.filter);
    ch.setEcho(d.echo);
    ch.setRate(d.playbackRate);
    for (const stem of STEM_IDS) this.applyStem(id, stem);
    for (const key of [...STEM_IDS, 'full'] as ChannelKey[]) ch.setChannelFilter(key, d.channelFilter[key] ?? 0);
  }

  // --- Spatial workstation additions: grid, loops, clips, build/drop -------

  /** Live waveform data for a channel of a deck. */
  getEnvelope(deck: DeckId, channel: ChannelKey): { data: Float32Array; rate: number; duration: number } | null {
    return this.channels[deck].envelope(channel);
  }

  /** Live output level of a channel (stem or full mix), 0..1. */
  getChannelLevel(deck: DeckId, channel: ChannelKey): number {
    return this.state.decks[deck].playing ? this.channels[deck].channelLevel(channel) : 0;
  }

  getClipLevel(deck: DeckId, clipId: string): number {
    return this.state.decks[deck].playing ? this.channels[deck].clipLevel(clipId) : 0;
  }

  /** Track position a clip is playing right now. */
  getClipPositionSec(deck: DeckId, clipId: string): number {
    return this.channels[deck].clipPosition(clipId);
  }

  private applyGrid(id: DeckId): void {
    const d = this.state.decks[id];
    this.channels[id].grid = d.bpm ? { bpm: d.bpm, firstBeatSec: d.firstBeatSec } : null;
  }

  /** Beat-snapped loop from the current beat (playback continues seamlessly inside it). */
  private loopBeats(id: DeckId, beats: number | null): void {
    const deck = this.state.decks[id];
    const ch = this.channels[id];
    if (beats === null) {
      deck.loop = null;
      ch.setLoop(null);
      return;
    }
    const start = ch.currentBeatPosition();
    const beat = ch.beatSec;
    if (start === null || !beat || deck.status !== 'ready') return;
    const startSec = clamp(start, 0, deck.durationSec);
    const endSec = clamp(start + beats * beat, 0, deck.durationSec);
    if (endSec - startSec < 0.05) return;
    deck.loop = { startSec, endSec, beats };
    ch.setLoop(deck.loop);
  }

  private createClip(id: DeckId, channel: ChannelKey, clipId: string, beats: number): void {
    const deck = this.state.decks[id];
    if (deck.clips[clipId]) return;
    const made = this.channels[id].createClip(clipId, channel, beats);
    if (!made) return;
    deck.clips[clipId] = { channel, beats, startSec: made.startSec, endSec: made.endSec, gain: 1, muted: false, filter: 0, engaged: false };
    setTimeout(() => {
      const clip = this.state.decks[id].clips[clipId];
      if (!clip) return;
      clip.engaged = true;
      this.emit();
    }, Math.max(0, (made.at - this.ctx.currentTime) * 1000));
  }

  private removeClip(id: DeckId, clipId: string): void {
    if (!this.state.decks[id].clips[clipId]) return;
    const at = this.channels[id].removeClip(clipId);
    setTimeout(() => {
      delete this.state.decks[id].clips[clipId];
      this.emit();
    }, Math.max(0, (at - this.ctx.currentTime) * 1000));
  }

  /** Master build: high-pass sweep, stem ducking, echo wash, noise riser. */
  private applyBuild(v: number, at: number, tc: number): void {
    const shaped = v ** 1.6;
    this.buildHpf.frequency.setTargetAtTime(BUILD_HPF.min * (BUILD_HPF.max / BUILD_HPF.min) ** shaped, at, tc);
    this.buildHpf.Q.setTargetAtTime(0.7 + 5 * shaped, at, tc);
    this.buildSend.gain.setTargetAtTime(0.45 * v, at, tc);
    this.riserGain.gain.setTargetAtTime(0.12 * v * v, at, tc);
    this.riserBand.frequency.setTargetAtTime(300 * (9000 / 300) ** v, at, tc);
    for (const deck of DECK_IDS) {
      for (const key of [...STEM_IDS, 'full'] as ChannelKey[]) {
        this.channels[deck].setChannelPerf(key, 1 - (BUILD_DUCK[key] ?? 0) * v, at, tc);
      }
    }
  }

  /** The deck drops are timed to: the playing deck with a BPM that the crossfader favours. */
  private leadDeck(): DeckId | null {
    const order: DeckId[] = this.state.mixer.crossfader <= 0 ? ['A', 'B'] : ['B', 'A'];
    return order.find((d) => this.state.decks[d].playing && this.channels[d].grid) ?? null;
  }

  private drop(): void {
    const mixer = this.state.mixer;
    if (mixer.dropPending || mixer.build < 0.05) return;
    const now = this.ctx.currentTime;
    const lead = this.leadDeck();
    let T = now + LEAD;
    if (lead) {
      const ch = this.channels[lead];
      const grid = ch.grid!;
      const bar = (60 / grid.bpm) * BEATS_PER_BAR;
      const from = ch.position() + LEAD * this.state.decks[lead].playbackRate;
      const b = grid.firstBeatSec + Math.ceil((from - grid.firstBeatSec) / bar - 1e-9) * bar;
      T = Math.max(now + LEAD, ch.ctxTimeAt(b));
      this.buildDelay.delayTime.setTargetAtTime((60 / grid.bpm) * 0.75, now, 0.05);
    }
    const peak = mixer.build;
    // Keep the tension climbing into the drop.
    this.applyBuild(Math.min(1, peak + 0.15), now, Math.max(0.02, (T - now) / 3));
    this.buildHpf.frequency.setTargetAtTime(BUILD_HPF.min, T, 0.012);
    this.buildHpf.Q.setTargetAtTime(0.7, T, 0.02);
    this.riserGain.gain.setTargetAtTime(0, T, 0.01);
    this.buildSend.gain.setTargetAtTime(0, T, 0.35);
    for (const deck of DECK_IDS) {
      for (const key of [...STEM_IDS, 'full'] as ChannelKey[]) this.channels[deck].setChannelPerf(key, 1, T, 0.008);
    }
    this.impact(T, peak);
    mixer.dropPending = true;
    mixer.dropQuantized = lead !== null;
    mixer.dropAtMs = Date.now() + (T - now + (this.ctx.outputLatency || this.ctx.baseLatency || 0)) * 1000;
    if (this.dropTimer) clearTimeout(this.dropTimer);
    this.dropTimer = setTimeout(() => {
      mixer.dropPending = false;
      mixer.build = 0;
      mixer.drops++;
      this.dropTimer = null;
      this.emit();
    }, Math.max(0, (T - now) * 1000));
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
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2500;
    const crashGain = ctx.createGain();
    crashGain.gain.setValueAtTime(0.0001, T);
    crashGain.gain.exponentialRampToValueAtTime(0.1 * level, T + 0.005);
    crashGain.gain.exponentialRampToValueAtTime(0.0001, T + 1.4);
    crash.connect(hp).connect(crashGain).connect(this.master);
    crash.start(T);
    crash.stop(T + 1.5);
  }

  private applyStem(id: DeckId, stem: StemId): void {
    const s = this.state.decks[id].stems[stem];
    this.channels[id].setStemGain(stem, s.muted ? 0 : s.gain);
  }

  /** Equal-power crossfade: -1 → A only, 0 → both at -3 dB, +1 → B only. */
  private applyCrossfader(): void {
    const t = ((this.state.mixer.crossfader + 1) / 2) * (Math.PI / 2);
    this.channels.A.setXf(Math.cos(t));
    this.channels.B.setXf(Math.sin(t));
  }

  private refreshPosition(id: DeckId): void {
    this.stampPosition(id, this.channels[id].position());
  }

  private stampPosition(id: DeckId, sec: number): void {
    const deck = this.state.decks[id];
    deck.positionSec = sec;
    deck.positionAt = Date.now();
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.getState();
    for (const listener of this.listeners) listener(snapshot);
  }
}

function emptyDeck(id: DeckId): DeckState {
  const stems = {} as DeckState['stems'];
  for (const s of STEM_IDS) stems[s] = { gain: 1, muted: false, available: false };
  return {
    id,
    track: null,
    source: 'none',
    status: 'empty',
    error: null,
    playing: false,
    positionSec: 0,
    positionAt: Date.now(),
    durationSec: 0,
    playbackRate: 1,
    bpm: null,
    gain: 1,
    stems,
    eq: { low: 0, mid: 0, high: 0 },
    filter: 0,
    echo: 0,
    loop: null,
    firstBeatSec: 0,
    bpmSource: null,
    channelFilter: {},
    clips: {},
    scratching: false,
  };
}

function channelData(buffer: AudioBuffer): Float32Array[] {
  return Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
}

function noiseBuffer(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const b = ctx.createBuffer(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function assertNever(value: never): never {
  throw new Error(`Unknown audio command: ${JSON.stringify(value)}`);
}
