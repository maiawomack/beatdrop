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

/** Build-up: master high-pass sweep range (Hz); 24 dB/oct, so the kick and bass really leave. */
const BUILD_HPF = { min: 10, max: 900 };
/** Build-up: stereo width at full build (1 = normal); the drop snaps it back wide. */
const BUILD_WIDTH = 0.4;
/** Build-up: overall level at full build, so the drop lands louder without clipping. */
const BUILD_LEVEL = 0.85;
/** Snare roll: starts at this much build, then speeds up (beats, 8ths, 16ths, 32nds) as it rises. */
const ROLL_START = 0.35;
/** Snare roll scheduling: how often the scheduler runs (ms) and how far ahead it books hits (s). */
const ROLL_TICK_MS = 25;
const ROLL_AHEAD = 0.12;
/** Rhythmic gate: from this much build the music chops in time with the roll, deeper near the top. */
const GATE_START = 0.6;
const GATE_DEPTH = 0.8;
/** The breath of silence before the drop: up to half a beat, at most this long (s). */
const DROP_GAP_MAX = 0.15;
/** Build-up: how much each stem is ducked at full build. Full mixes rely on the high-pass. */
const BUILD_DUCK: Partial<Record<ChannelKey, number>> = { bass: 0.85, drums: 0.3 };
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
  private readonly buildHp: [BiquadFilterNode, BiquadFilterNode];
  private readonly width: StereoWidth;
  private readonly buildLevel: GainNode;
  /** After the build chain: risers and impacts join here, then the safety limiter. */
  private readonly out: GainNode;
  /** Low-shelf on the master: a bass punch right on the drop. */
  private readonly dropShelf: BiquadFilterNode;
  /** Build snare roll, after the build filters (so it stays crisp). */
  private readonly rollBus: GainNode;
  private rollTimer: ReturnType<typeof setInterval> | null = null;
  /** Track position (lead deck) of the last scheduled roll hit. */
  private rollLast = -Infinity;
  /** Scheduled roll hits, so a drop or a stop can silence the ones not played yet. */
  private rollVoices: { at: number; nodes: AudioScheduledSourceNode[] }[] = [];
  private readonly buildSend: GainNode;
  private readonly buildDelay: DelayNode;
  private readonly buildFeedback: GainNode;
  private readonly buildTone: BiquadFilterNode;
  /** Rhythmic gate on the music (not the riser or roll), driven by the roll scheduler. */
  private readonly gate: GainNode;
  private readonly riserGain: GainNode;
  private readonly riserBand: BiquadFilterNode;
  private readonly riserPan: StereoPannerNode;
  private readonly riserLfo: OscillatorNode;
  private readonly riserLfoDepth: GainNode;
  private readonly noise: AudioBuffer;
  private riserSource: AudioBufferSourceNode | null = null;
  private dropTimer: ReturnType<typeof setTimeout> | null = null;
  /** The pending drop's impact sounds, so a drop cancelled before it lands stays silent. */
  private impactSources: AudioScheduledSourceNode[] = [];

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    // Decks ─► master ─► high-pass ×2 ─► stereo width ─► build level ─► out ─► limiter ─► speakers + recorder
    //            ├─► echo send ─► delay ⇄ feedback (dark) ─┘ (into the high-pass)
    //            noise riser ─► band-pass ─► auto-pan ─► out;  drop impacts ─► out
    const hp = () => {
      const f = this.ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = BUILD_HPF.min;
      f.Q.value = Math.SQRT1_2;
      return f;
    };
    this.buildHp = [hp(), hp()];
    this.width = stereoWidth(this.ctx);
    this.buildLevel = this.ctx.createGain();
    this.out = this.ctx.createGain();
    // Safety limiter: only peaks above -1.5 dBFS (two loud decks, a drop impact) are caught.
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -1.5;
    limiter.knee.value = 1;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    this.dropShelf = this.ctx.createBiquadFilter();
    this.dropShelf.type = 'lowshelf';
    this.dropShelf.frequency.value = 110;
    this.dropShelf.gain.value = 0;
    this.master.connect(this.dropShelf).connect(this.buildHp[0]).connect(this.buildHp[1]).connect(this.width.input);
    // After the limiter, a soft ceiling: transparent below 0.9, rounds off anything the
    // limiter's attack lets through, so a peak can never hard-clip.
    const ceiling = this.ctx.createWaveShaper();
    ceiling.curve = ceilingCurve(0.9);
    ceiling.oversample = '2x';
    this.gate = this.ctx.createGain();
    this.width.output.connect(this.buildLevel).connect(this.gate).connect(this.out).connect(limiter).connect(ceiling).connect(this.ctx.destination);
    // Recordings capture the final mix, build/drop included.
    this.recordTap = this.ctx.createMediaStreamDestination();
    ceiling.connect(this.recordTap);
    this.buildSend = this.ctx.createGain();
    this.buildSend.gain.value = 0;
    this.buildDelay = this.ctx.createDelay(2);
    this.buildDelay.delayTime.value = 0.375;
    this.buildFeedback = this.ctx.createGain();
    this.buildFeedback.gain.value = 0.4;
    this.buildTone = this.ctx.createBiquadFilter();
    this.buildTone.type = 'lowpass';
    this.buildTone.frequency.value = 3500;
    this.master.connect(this.buildSend).connect(this.buildDelay);
    this.buildDelay.connect(this.buildTone).connect(this.buildFeedback).connect(this.buildDelay);
    this.buildTone.connect(this.buildHp[0]);
    this.noise = noiseBuffer(this.ctx, 2, 2);
    this.rollBus = this.ctx.createGain();
    this.rollBus.connect(this.out);
    this.riserBand = this.ctx.createBiquadFilter();
    this.riserBand.type = 'bandpass';
    this.riserBand.frequency.value = 400;
    this.riserBand.Q.value = 1;
    this.riserPan = this.ctx.createStereoPanner();
    this.riserGain = this.ctx.createGain();
    this.riserGain.gain.value = 0;
    this.riserBand.connect(this.riserPan).connect(this.riserGain).connect(this.out);
    // The riser sways between the speakers, faster as the build rises.
    this.riserLfo = this.ctx.createOscillator();
    this.riserLfo.frequency.value = 0.25;
    this.riserLfoDepth = this.ctx.createGain();
    this.riserLfoDepth.gain.value = 0.15;
    this.riserLfo.connect(this.riserLfoDepth).connect(this.riserPan.pan);
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
        this.settleBuildIfSilent();
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
      this.riserLfo.start();
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
        this.settleBuildIfSilent();
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
        // Nothing playing: no build (a riser over silence isn't a build-up).
        const v = this.anyPlaying() ? clamp(cmd.value, 0, 1) : 0;
        if (v > 0) this.syncEcho();
        // Rise quickly, fall back gently (cancelling shouldn't lurch).
        const tc = v >= mixer.build ? 0.06 : 0.25;
        mixer.build = v;
        this.applyBuild(v, this.ctx.currentTime, tc);
        this.updateRoll();
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
    this.settleBuildIfSilent();
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
    this.settleBuildIfSilent();
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

  /**
   * Master build at `v` (0..1), following the hand: the high-pass climbs (kick and bass
   * leave), the stereo image narrows, the level dips a little, bass and drum stems duck,
   * an echo wash swells and a noise riser rises in pitch and sways faster between the
   * speakers. Everything is smoothed automation (time constant `tc`).
   */
  private applyBuild(v: number, at: number, tc: number): void {
    const shaped = v ** 1.5;
    const hz = BUILD_HPF.min * (BUILD_HPF.max / BUILD_HPF.min) ** shaped;
    for (const f of this.buildHp) f.frequency.setTargetAtTime(hz, at, tc);
    // A touch of resonance at the cutoff for tension; kept low so it never booms.
    this.buildHp[1].Q.setTargetAtTime(Math.SQRT1_2 + 1.1 * shaped, at, tc);
    this.width.set(1 - (1 - BUILD_WIDTH) * shaped, at, tc);
    this.buildLevel.gain.setTargetAtTime(1 - (1 - BUILD_LEVEL) * shaped, at, tc);
    this.buildSend.gain.setTargetAtTime(0.35 * v, at, tc);
    // The echo wash piles up and brightens as the build rises.
    this.buildFeedback.gain.setTargetAtTime(0.4 + 0.28 * v, at, tc);
    this.buildTone.frequency.setTargetAtTime(3500 * 2 ** v, at, tc);
    this.riserGain.gain.setTargetAtTime(0.07 * v * v, at, tc);
    this.riserBand.frequency.setTargetAtTime(400 * (8000 / 400) ** v, at, tc);
    this.riserBand.Q.setTargetAtTime(1 + 2 * v, at, tc);
    this.riserLfo.frequency.setTargetAtTime(0.25 + 5.75 * v * v, at, tc);
    this.riserLfoDepth.gain.setTargetAtTime(0.15 + 0.55 * v, at, tc);
    for (const deck of DECK_IDS) {
      for (const key of [...STEM_IDS, 'full'] as ChannelKey[]) {
        this.channels[deck].setChannelPerf(key, 1 - (BUILD_DUCK[key] ?? 0) * v, at, tc);
      }
    }
  }

  /** Every parameter the build automates (to cancel a pending drop's schedule). */
  private buildParams(): AudioParam[] {
    return [
      ...this.buildHp.flatMap((f) => [f.frequency, f.Q]),
      ...this.width.params,
      this.buildLevel.gain,
      this.buildSend.gain,
      this.riserGain.gain,
      this.riserBand.frequency,
      this.riserBand.Q,
      this.riserLfo.frequency,
      this.riserLfoDepth.gain,
      this.dropShelf.gain,
      this.buildFeedback.gain,
      this.buildTone.frequency,
    ];
  }

  private anyPlaying(): boolean {
    return DECK_IDS.some((d) => this.state.decks[d].playing);
  }

  /** The build echo repeats on the lead deck's dotted eighth (3/4 beat) when it has a tempo. */
  private syncEcho(): void {
    const lead = this.leadDeck();
    const bpm = lead ? this.channels[lead].grid!.bpm * this.state.decks[lead].playbackRate : 160;
    this.buildDelay.delayTime.setTargetAtTime(clamp((60 / bpm) * 0.75, 0.1, 1.5), this.ctx.currentTime, 0.05);
  }

  /** The deck drops are timed to: the playing deck with a BPM that the crossfader favours. */
  private leadDeck(): DeckId | null {
    const order: DeckId[] = this.state.mixer.crossfader <= 0 ? ['A', 'B'] : ['B', 'A'];
    return order.find((d) => this.state.decks[d].playing && this.channels[d].grid) ?? null;
  }

  /**
   * Bring everything back in. With a beat grid the drop lands on the lead deck's next
   * beat (never more than one beat away); without one it lands now. Until then the build
   * squeezes a little further, and when there's time, the mix takes a short breath of
   * silence (up to half a beat). On the beat the filters, width and level snap back with
   * a bass punch and a stereo bloom, the riser and snare roll stop, the echo wash rings
   * out, and the impact hits.
   */
  private drop(): void {
    const mixer = this.state.mixer;
    if (mixer.dropPending || mixer.build < 0.05 || !this.anyPlaying()) return;
    const now = this.ctx.currentTime;
    const lead = this.leadDeck();
    let T = now + LEAD;
    let beat = 0;
    if (lead) {
      const ch = this.channels[lead];
      const grid = ch.grid!;
      beat = 60 / grid.bpm / this.state.decks[lead].playbackRate;
      const from = ch.position() + LEAD * this.state.decks[lead].playbackRate;
      const next = grid.firstBeatSec + Math.ceil((from - grid.firstBeatSec) / (60 / grid.bpm) - 1e-9) * (60 / grid.bpm);
      T = Math.max(now + LEAD, ch.ctxTimeAt(next));
    }
    const peak = mixer.build;
    // The breath before the drop, if there's room for one that you can hear.
    const gap = Math.min(DROP_GAP_MAX, beat / 2, T - now - 0.03);
    const gapAt = gap >= 0.06 ? T - gap : T;
    this.stopRoll(gapAt);
    for (const p of this.buildParams()) p.cancelScheduledValues(now);
    this.applyBuild(Math.min(1, peak + 0.15), now, Math.max(0.02, (T - now) / 3));
    if (gapAt < T) {
      this.buildLevel.gain.setTargetAtTime(0.05, gapAt, 0.008);
      this.riserGain.gain.setTargetAtTime(0, gapAt, 0.01);
    }
    for (const f of this.buildHp) {
      f.frequency.setTargetAtTime(BUILD_HPF.min, T, 0.008);
      f.Q.setTargetAtTime(Math.SQRT1_2, T, 0.02);
    }
    // Width blooms past normal for a moment, then settles.
    this.width.set(1.3, T, 0.004);
    this.width.set(1, T + 0.2, 0.35);
    // Bass punch: +4 dB low shelf on the hit, easing off over about a second.
    this.dropShelf.gain.setTargetAtTime(4, T, 0.005);
    this.dropShelf.gain.setTargetAtTime(0, T + 0.15, 0.45);
    this.buildLevel.gain.setTargetAtTime(1, T, 0.004);
    this.riserGain.gain.setTargetAtTime(0, T, 0.012);
    this.riserLfoDepth.gain.setTargetAtTime(0.15, T, 0.1);
    this.buildSend.gain.setTargetAtTime(0, T, 0.35);
    // The wash already in the delay rings out long and bright, then settles back.
    this.buildFeedback.gain.setTargetAtTime(0.4, T + 0.6, 0.4);
    this.buildTone.frequency.setTargetAtTime(3500, T + 0.6, 0.4);
    for (const deck of DECK_IDS) {
      for (const key of [...STEM_IDS, 'full'] as ChannelKey[]) this.channels[deck].setChannelPerf(key, 1, T, 0.006);
    }
    this.impact(T, peak);
    mixer.dropPending = true;
    mixer.dropQuantized = lead !== null;
    mixer.dropAtMs = Date.now() + (T - now + (this.ctx.outputLatency || this.ctx.baseLatency || 0)) * 1000;
    if (this.dropTimer) clearTimeout(this.dropTimer);
    this.dropTimer = setTimeout(() => {
      mixer.dropPending = false;
      mixer.dropAtMs = null;
      mixer.build = 0;
      mixer.drops++;
      this.dropTimer = null;
      this.impactSources = [];
      this.emit();
    }, Math.max(0, (T - now) * 1000));
  }

  // --- Snare roll ----------------------------------------------------------

  /** Run the roll while the build is high enough and something plays; stop it otherwise. */
  private updateRoll(): void {
    const m = this.state.mixer;
    const want = m.build >= ROLL_START && !m.dropPending && this.anyPlaying();
    if (want && !this.rollTimer) {
      this.rollLast = -Infinity;
      this.rollTimer = setInterval(() => this.scheduleRoll(), ROLL_TICK_MS);
      this.scheduleRoll();
    } else if (!want && this.rollTimer) {
      this.stopRoll(this.ctx.currentTime);
    }
  }

  /**
   * Book the roll's next hits on the lead deck's beat grid, ROLL_AHEAD ahead. It speeds
   * up with the build: beats, then 8ths, 16ths and 32nds near the top, getting louder and
   * brighter. No grid, no roll (it never invents a tempo).
   */
  private scheduleRoll(): void {
    const lead = this.leadDeck();
    if (!lead) return;
    const ch = this.channels[lead];
    const grid = ch.grid!;
    if (this.rollLast > ch.position() + 1) this.rollLast = -Infinity; // seeked back
    const build = this.state.mixer.build;
    const div = build < 0.55 ? 1 : build < 0.75 ? 2 : build < 0.92 ? 4 : 8;
    const step = 60 / grid.bpm / div;
    const from = Math.max(ch.position() + 0.005 * this.state.decks[lead].playbackRate, this.rollLast + step * 0.5);
    let pos = grid.firstBeatSec + Math.ceil((from - grid.firstBeatSec) / step - 1e-9) * step;
    const horizon = this.ctx.currentTime + ROLL_AHEAD;
    const amount = clamp((build - ROLL_START) / (1 - ROLL_START), 0, 1);
    const depth = GATE_DEPTH * clamp((build - GATE_START) / (1 - GATE_START), 0, 1) ** 1.2;
    const stepSec = step / this.state.decks[lead].playbackRate;
    for (let at = ch.ctxTimeAt(pos); at < horizon; pos += step, at = ch.ctxTimeAt(pos)) {
      if (at >= this.ctx.currentTime) {
        this.snare(at, 0.05 + 0.13 * amount ** 1.2, amount);
        // Gate: open on each hit, dip for the second half of the step.
        this.gate.gain.setTargetAtTime(1, at, 0.003);
        if (depth > 0.02) this.gate.gain.setTargetAtTime(1 - depth, at + stepSec * 0.55, 0.006);
      }
      this.rollLast = pos;
    }
    const now = this.ctx.currentTime;
    this.rollVoices = this.rollVoices.filter((v) => v.at > now - 0.5);
  }

  /** One synthesized snare hit: a noise crack plus a short tonal body. */
  private snare(at: number, level: number, bright: number): void {
    const ctx = this.ctx;
    const noise = ctx.createBufferSource();
    noise.buffer = this.noise;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 1800 + 3200 * bright;
    band.Q.value = 0.9;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, at);
    ng.gain.exponentialRampToValueAtTime(level, at + 0.002);
    ng.gain.exponentialRampToValueAtTime(0.0001, at + 0.1);
    noise.connect(band).connect(ng).connect(this.rollBus);
    noise.start(at, Math.random() * 1.5);
    noise.stop(at + 0.12);
    const body = ctx.createOscillator();
    body.type = 'triangle';
    body.frequency.setValueAtTime(230 + 60 * bright, at);
    body.frequency.exponentialRampToValueAtTime(160, at + 0.05);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.0001, at);
    bg.gain.exponentialRampToValueAtTime(level * 0.7, at + 0.002);
    bg.gain.exponentialRampToValueAtTime(0.0001, at + 0.07);
    body.connect(bg).connect(this.rollBus);
    body.start(at);
    body.stop(at + 0.08);
    this.rollVoices.push({ at, nodes: [noise, body] });
  }

  /** Stop the roll (and open the gate); hits booked at or after `from` (context time) never sound. */
  private stopRoll(from: number): void {
    if (this.rollTimer) clearInterval(this.rollTimer);
    this.rollTimer = null;
    this.gate.gain.cancelScheduledValues(from);
    this.gate.gain.setTargetAtTime(1, from, 0.004);
    for (const v of this.rollVoices) {
      if (v.at < from) continue;
      for (const n of v.nodes) {
        try {
          n.stop(); // before its start time: never sounds
        } catch {
          // already finished
        }
      }
    }
    this.rollVoices = this.rollVoices.filter((v) => v.at < from);
  }

  /**
   * On the drop: a kick-like boom (fast pitch drop into an 808-style sub tail, lightly
   * saturated so its harmonics carry on laptop speakers) and a wide noise crash.
   * Everything goes through the limiter.
   */
  private impact(T: number, strength: number): void {
    const ctx = this.ctx;
    const level = 0.28 + 0.22 * strength;
    const sub = ctx.createOscillator();
    sub.frequency.setValueAtTime(150, T);
    sub.frequency.exponentialRampToValueAtTime(52, T + 0.09);
    sub.frequency.exponentialRampToValueAtTime(42, T + 1.2);
    const drive = ctx.createWaveShaper();
    drive.curve = softClipCurve(2.2);
    drive.oversample = '2x';
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.0001, T);
    subGain.gain.exponentialRampToValueAtTime(level, T + 0.004);
    subGain.gain.setTargetAtTime(level * 0.55, T + 0.05, 0.08);
    subGain.gain.exponentialRampToValueAtTime(0.0001, T + 1.3);
    sub.connect(drive).connect(subGain).connect(this.out);
    sub.start(T);
    sub.stop(T + 1.4);
    const crash = ctx.createBufferSource();
    crash.buffer = this.noise;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 4500;
    const crashGain = ctx.createGain();
    crashGain.gain.setValueAtTime(0.0001, T);
    crashGain.gain.exponentialRampToValueAtTime(0.16 * level, T + 0.004);
    crashGain.gain.exponentialRampToValueAtTime(0.0001, T + 1.8);
    crash.connect(hp).connect(crashGain).connect(this.out);
    crash.start(T, Math.random());
    crash.stop(T + 1.9);
    this.impactSources = [sub, crash];
  }

  /**
   * Nothing is playing any more (paused, ended, unloaded, new song): the build lets go
   * gently, and a drop that hasn't landed is cancelled, impact included.
   */
  private settleBuildIfSilent(): void {
    const mixer = this.state.mixer;
    if (this.anyPlaying() || (mixer.build === 0 && !mixer.dropPending)) return;
    const now = this.ctx.currentTime;
    if (this.dropTimer) clearTimeout(this.dropTimer);
    this.dropTimer = null;
    for (const src of this.impactSources) {
      try {
        src.stop(); // before its start time: never sounds
      } catch {
        // already finished
      }
    }
    this.impactSources = [];
    this.stopRoll(now);
    for (const p of this.buildParams()) p.cancelScheduledValues(now);
    this.applyBuild(0, now, 0.08);
    this.width.set(1, now, 0.08);
    this.dropShelf.gain.setTargetAtTime(0, now, 0.08);
    Object.assign(mixer, { build: 0, dropPending: false, dropAtMs: null });
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

interface StereoWidth {
  input: AudioNode;
  output: AudioNode;
  params: AudioParam[];
  /** 1 = normal stereo, 0 = mono, above 1 = extra wide. */
  set(width: number, at: number, tc: number): void;
}

/** Mid/side width: L' = L(1+w)/2 + R(1-w)/2, R' = R(1+w)/2 + L(1-w)/2. Mono input plays as is. */
function stereoWidth(ctx: AudioContext): StereoWidth {
  const input = ctx.createGain();
  const split = ctx.createChannelSplitter(2);
  const merge = ctx.createChannelMerger(2);
  input.connect(split);
  const direct = [ctx.createGain(), ctx.createGain()];
  const cross = [ctx.createGain(), ctx.createGain()];
  for (const ch of [0, 1]) {
    cross[ch]!.gain.value = 0;
    split.connect(direct[ch]!, ch).connect(merge, 0, ch);
    split.connect(cross[ch]!, ch).connect(merge, 0, 1 - ch);
  }
  return {
    input,
    output: merge,
    params: [...direct, ...cross].map((g) => g.gain),
    set(width, at, tc) {
      const w = clamp(width, 0, 1.5);
      for (const g of direct) g.gain.setTargetAtTime((1 + w) / 2, at, tc);
      for (const g of cross) g.gain.setTargetAtTime((1 - w) / 2, at, tc);
    },
  };
}

/** Identity up to `knee`, then a tanh shoulder that never exceeds 1. */
function ceilingCurve(knee: number): Float32Array<ArrayBuffer> {
  const n = 4096;
  const curve = new Float32Array(n);
  const room = 1 - knee;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    curve[i] = Math.sign(x) * (a <= knee ? a : knee + room * Math.tanh((a - knee) / room));
  }
  return curve;
}

/** tanh soft clipper, normalized so full scale stays full scale. */
function softClipCurve(drive: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(drive * x) / Math.tanh(drive);
  }
  return curve;
}

function channelData(buffer: AudioBuffer): Float32Array[] {
  return Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
}

/** White noise; with 2 channels the sides are independent (wide in stereo). */
function noiseBuffer(ctx: BaseAudioContext, seconds: number, channels = 1): AudioBuffer {
  const b = ctx.createBuffer(channels, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate);
  for (let c = 0; c < channels; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
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
