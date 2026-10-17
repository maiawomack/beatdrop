import {
  DECK_IDS,
  EQ_BANDS,
  STEM_IDS,
  type AudioCommand,
  type AudioEngineState,
  type DeckId,
  type DeckState,
  type StemId,
  type StemUrls,
} from '../shared/types';
import { DeckChannel, clamp } from './DeckChannel';

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
  private readonly channels: Record<DeckId, DeckChannel>;
  private readonly state: AudioEngineState;
  private readonly listeners = new Set<Listener>();
  private readonly loadSeq: Record<DeckId, number> = { A: 0, B: 0 };
  private readonly loadAbort: Record<DeckId, AbortController | null> = { A: null, B: null };

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);

    this.channels = {
      A: new DeckChannel(this.ctx, this.master),
      B: new DeckChannel(this.ctx, this.master),
    };
    this.state = {
      decks: { A: emptyDeck('A'), B: emptyDeck('B') },
      mixer: { crossfader: 0, masterGain: 1 },
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
    return this.channels[deck].position();
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
      case 'SET_BPM':
        this.state.decks[cmd.deck].bpm = cmd.bpm;
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

    const hasUrls = (u: StemUrls | null | undefined): u is StemUrls => !!u && Object.values(u).some(Boolean);
    const stems = hasUrls(cmd.stems) ? cmd.stems : hasUrls(cmd.track.stems) ? cmd.track.stems : null;
    const urls: StemUrls | null = stems ?? (cmd.track.audioUrl ? { full: cmd.track.audioUrl } : null);

    try {
      if (!urls) throw new Error('Track has no audio source');
      const loaded = await this.channels[id].load(urls, abort.signal);
      if (seq !== this.loadSeq[id]) return;
      deck.source = this.channels[id].hasStems ? 'stems' : 'full';
      deck.durationSec = this.channels[id].duration;
      deck.track = { ...cmd.track, durationMs: Math.round(deck.durationSec * 1000) };
      for (const s of STEM_IDS) deck.stems[s].available = loaded.includes(s);
      deck.status = 'ready';
    } catch (err) {
      if (seq !== this.loadSeq[id] || isAbort(err)) return;
      deck.status = 'error';
      deck.error = errorMessage(err);
    } finally {
      if (seq === this.loadSeq[id]) this.loadAbort[id] = null;
    }

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
  };
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
