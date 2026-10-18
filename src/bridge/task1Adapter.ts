import {
  defaultPerformanceState,
  defaultStemState,
  isStemCommand,
  type AudioCommand,
  type AudioCommandSink,
  type AudioStateSource,
  type LoopBeats,
  type PerformanceState,
  type StemCommand,
  type StemId,
  type StemState,
  type TransportState,
} from '../audio/AudioCommands';
import {
  DECK_IDS,
  STEM_IDS,
  type AudioCommand as EngineCommand,
  type AudioEngineState,
  type ChannelKey,
  type DeckId,
  type DeckState,
} from '../shared/types';

/** What the adapter needs from the Task 1 engine (src/audio/AudioEngine.ts). */
export interface Task1Engine {
  dispatch(command: EngineCommand): unknown;
  getState(): AudioEngineState;
  subscribe(listener: (state: AudioEngineState) => void): () => void;
}

/**
 * Lets the spatial workstation drive the shared two-deck engine (Task 1).
 *
 * The spatial side sees one "stem" per playable channel of each loaded deck,
 * id `<deck>:<channel>`: `A:vocals`, `A:drums`... for separated tracks, or
 * `A:full` for a full mix. Loop clips are `<source>~<n>`, e.g. `A:vocals~1`.
 *
 * Mapping (spatial command -> engine command):
 *   setVolume  stem -> SET_STEM_GAIN · full mix -> SET_DECK_GAIN · clip -> SET_CLIP_GAIN
 *   setMute    stem -> SET_STEM_MUTE · full mix -> deck gain 0 / restore · clip -> SET_CLIP_MUTE
 *   setFilter  -> SET_CHANNEL_FILTER (per channel) · clip -> SET_CLIP_FILTER
 *   setFx      -> SET_ECHO on the deck (stretch = echo wash for the whole deck)
 *   setLoop    -> SET_LOOP_BEATS on the deck (the engine loops whole decks)
 *   createClip / removeClip -> CREATE_CLIP / REMOVE_CLIP
 *   setBuild / drop -> SET_BUILD / DROP
 *   setCrossfader -> SET_CROSSFADER · scratch -> SCRATCH_START / _MOVE / _END
 *   setTempo -> SET_PLAYBACK_RATE
 *   setSolo, setPan, grab, release -> not supported by the engine (ignored)
 *
 * State flows back from the engine on every change, so whatever Monitor 1
 * (or anything else) does to the engine shows up in the spatial view too.
 */
export class Task1Adapter implements AudioCommandSink, AudioStateSource {
  readonly stems = new Map<StemId, StemState>();
  readonly perf: PerformanceState = defaultPerformanceState();
  transport: TransportState = { playing: false, bpm: null, beatsPerBar: 4, anchorMs: null, durationSec: 0 };
  private listeners = new Set<() => void>();
  /** Full-mix "mute": deck gain is set to 0; this remembers the gain to restore. */
  private fullMuted = new Map<DeckId, number>();
  private engineState: AudioEngineState;
  readonly close: () => void;

  constructor(private engine: Task1Engine) {
    this.engineState = engine.getState();
    this.close = engine.subscribe((state) => {
      this.engineState = state;
      this.refresh();
    });
    this.refresh();
  }

  /** Latest engine state (for status displays). */
  get state(): AudioEngineState {
    return this.engineState;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispatch(command: AudioCommand): void {
    if (!isStemCommand(command)) {
      switch (command.type) {
        case 'setBuild':
          this.engine.dispatch({ type: 'SET_BUILD', value: command.value });
          break;
        case 'drop':
          this.engine.dispatch({ type: 'DROP' });
          break;
        case 'setCrossfader':
          this.engine.dispatch({ type: 'SET_CROSSFADER', value: command.value });
          break;
        case 'setTempo':
          this.engine.dispatch({ type: 'SET_PLAYBACK_RATE', deck: command.deck, rate: command.rate });
          break;
        case 'scratch': {
          const { deck } = command;
          if (command.phase === 'start') this.engine.dispatch({ type: 'SCRATCH_START', deck });
          else if (command.phase === 'move') this.engine.dispatch({ type: 'SCRATCH_MOVE', deck, offsetSec: command.offsetSec });
          else this.engine.dispatch({ type: 'SCRATCH_END', deck });
          break;
        }
      }
      return;
    }
    const target = parseId(command.stemId);
    if (!target) return;
    const out = this.translate(command, target);
    if (out) this.engine.dispatch(out);
  }

  private translate(c: StemCommand, t: Target): EngineCommand | null {
    const { deck } = t;
    switch (c.type) {
      case 'setVolume':
        if (t.clipId) return { type: 'SET_CLIP_GAIN', deck, clipId: t.clipId, gain: c.value };
        if (t.channel === 'full') {
          if (this.fullMuted.has(deck)) {
            this.fullMuted.set(deck, c.value);
            return null;
          }
          return { type: 'SET_DECK_GAIN', deck, gain: c.value };
        }
        return { type: 'SET_STEM_GAIN', deck, stem: t.channel, gain: c.value };
      case 'setMute':
        if (t.clipId) return { type: 'SET_CLIP_MUTE', deck, clipId: t.clipId, muted: c.value };
        if (t.channel === 'full') {
          const d = this.engineState.decks[deck];
          if (c.value && !this.fullMuted.has(deck)) {
            this.fullMuted.set(deck, d.gain);
            return { type: 'SET_DECK_GAIN', deck, gain: 0 };
          }
          if (!c.value && this.fullMuted.has(deck)) {
            const gain = this.fullMuted.get(deck)!;
            this.fullMuted.delete(deck);
            return { type: 'SET_DECK_GAIN', deck, gain };
          }
          return null;
        }
        return { type: 'SET_STEM_MUTE', deck, stem: t.channel, muted: c.value };
      case 'setFilter':
        if (t.clipId) return { type: 'SET_CLIP_FILTER', deck, clipId: t.clipId, value: c.value };
        return { type: 'SET_CHANNEL_FILTER', deck, channel: t.channel, value: c.value };
      case 'setFx':
        return { type: 'SET_ECHO', deck, amount: 0.8 * c.value };
      case 'setLoop':
        return { type: 'SET_LOOP_BEATS', deck, beats: c.beats };
      case 'createClip':
        if (t.clipId) return null; // no clips of clips
        return { type: 'CREATE_CLIP', deck, channel: t.channel, clipId: c.clipId, beats: c.beats };
      case 'removeClip':
        return t.clipId ? { type: 'REMOVE_CLIP', deck, clipId: t.clipId } : null;
      default:
        return null; // grab, release, setPan, setSolo
    }
  }

  /** Rebuild the spatial view of engine state. */
  private refresh(): void {
    const s = this.engineState;
    this.stems.clear();
    for (const deck of DECK_IDS) {
      const d = s.decks[deck];
      if (d.status !== 'ready') {
        this.fullMuted.delete(deck);
        continue;
      }
      const loop = d.loop
        ? { beats: (d.loop.beats ?? 4) as LoopBeats, startSec: d.loop.startSec, endSec: d.loop.endSec, engaged: true }
        : null;
      for (const ch of deckChannels(d)) {
        const muted = ch === 'full' ? this.fullMuted.has(deck) : d.stems[ch].muted;
        const volume = ch === 'full' ? (this.fullMuted.get(deck) ?? d.gain) : d.stems[ch].gain;
        this.stems.set(`${deck}:${ch}`, {
          ...defaultStemState(),
          volume,
          muted,
          audible: !muted,
          fx: Math.min(1, d.echo / 0.8),
          filter: d.channelFilter[ch] ?? 0,
          loop,
          ducked: Object.values(d.clips).some((c) => c.channel === ch),
        });
      }
      for (const [clipId, c] of Object.entries(d.clips)) {
        this.stems.set(clipId, {
          ...defaultStemState(),
          volume: c.gain,
          muted: c.muted,
          audible: !c.muted,
          filter: c.filter,
          loop: { beats: c.beats as LoopBeats, startSec: c.startSec, endSec: c.endSec, engaged: c.engaged },
          clipOf: `${deck}:${c.channel}`,
        });
      }
    }
    const m = s.mixer;
    Object.assign(this.perf, {
      build: m.build,
      dropPending: m.dropPending,
      dropAtMs: m.dropAtMs,
      dropQuantized: m.dropQuantized,
      drops: m.drops,
      crossfader: m.crossfader,
      scratching: DECK_IDS.filter((d) => s.decks[d].scratching),
      tempo: { A: s.decks.A.playbackRate, B: s.decks.B.playbackRate },
    });
    this.transport = transportOf(s);
    for (const l of this.listeners) l();
  }
}

/** Channels a loaded deck exposes to the spatial view. */
export function deckChannels(d: DeckState): ChannelKey[] {
  if (d.source === 'stems') return STEM_IDS.filter((s) => d.stems[s].available);
  return d.source === 'full' ? ['full'] : [];
}

/** The deck the beat grid follows: playing, with a BPM, favoured by the crossfader. */
export function leadDeck(s: AudioEngineState): DeckId | null {
  const order: DeckId[] = s.mixer.crossfader <= 0 ? ['A', 'B'] : ['B', 'A'];
  return order.find((d) => s.decks[d].playing && s.decks[d].bpm) ?? order.find((d) => s.decks[d].status === 'ready') ?? null;
}

function transportOf(s: AudioEngineState): TransportState {
  const lead = leadDeck(s);
  const d = lead ? s.decks[lead] : null;
  if (!d || !d.bpm) return { playing: !!d?.playing, bpm: null, beatsPerBar: 4, anchorMs: null, durationSec: d?.durationSec ?? 0 };
  const rate = d.playbackRate || 1;
  // Wall time at which the deck was (or would have been) at firstBeatSec.
  const anchorMs = d.playing ? d.positionAt - ((d.positionSec - d.firstBeatSec) / rate) * 1000 : null;
  return { playing: d.playing, bpm: d.bpm * rate, beatsPerBar: 4, anchorMs, durationSec: d.durationSec };
}

interface Target {
  deck: DeckId;
  channel: ChannelKey;
  /** Set when the id is a loop clip. */
  clipId?: string;
}

/** `A:vocals` -> deck A, vocals · `A:vocals~2` -> clip of A:vocals. */
export function parseId(id: string): Target | null {
  const m = /^([AB]):([a-z]+)(~\d+)?$/.exec(id);
  if (!m) return null;
  const channel = m[2] as ChannelKey;
  if (channel !== 'full' && !(STEM_IDS as readonly string[]).includes(channel)) return null;
  return { deck: m[1] as DeckId, channel, clipId: m[3] ? id : undefined };
}
