// STAND-IN audio engine so the decks UI (Task 3) works before the real engine (Task 1)
// exists. Implements the proposed AudioController contract with plain Web Audio:
//
//   stem source → stem gain → analyser ┐
//   (x4 per deck, started together)    ├→ deck gain → crossfader gain → master → out
//
// Replace with Task 1's engine when it lands; UIs only depend on AudioController.

import {
  DECK_IDS,
  STEM_IDS,
  type ApplicationState,
  type AudioCommand,
  type AudioController,
  type DeckId,
  type DeckState,
  type StemId,
} from '../shared/contracts';
import { loadTrack, type LoadedTrack } from '../stems';

/** Gain smoothing time constant: avoids clicks, still feels instant. */
const RAMP_SEC = 0.012;
/** Schedule starts slightly ahead so all four stems begin on the same sample. */
const START_AHEAD_SEC = 0.03;

interface DeckRuntime {
  track: LoadedTrack | null;
  sources: AudioBufferSourceNode[];
  /** While playing, position = anchorPos + (ctx.currentTime - anchorCtx) * rate. */
  anchorCtx: number;
  anchorPos: number;
  rate: number;
  /** Position while paused. */
  offset: number;
  playToken: number;
  loadToken: number;
  stemGains: Record<StemId, GainNode>;
  analysers: Record<StemId, AnalyserNode>;
  deckGain: GainNode;
  crossfadeGain: GainNode;
}

function stemRecord<T>(make: (stem: StemId) => T): Record<StemId, T> {
  return Object.fromEntries(STEM_IDS.map((stem) => [stem, make(stem)])) as Record<StemId, T>;
}

function emptyDeck(id: DeckId): DeckState {
  return {
    id,
    status: 'empty',
    error: null,
    track: null,
    playing: false,
    positionSec: 0,
    volume: 1,
    playbackRate: 1,
    stems: stemRecord(() => ({ volume: 1, muted: false })),
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function createStandInEngine(): AudioController {
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  const master = ctx.createGain();
  master.connect(ctx.destination);
  // Tap of the master mix for recording sets.
  const recordTap = ctx.createMediaStreamDestination();
  master.connect(recordTap);
  const levelScratch = new Float32Array(512);

  let state: ApplicationState = {
    decks: { A: emptyDeck('A'), B: emptyDeck('B') },
    mixer: { crossfader: 0, masterVolume: 1 },
  };
  const listeners = new Set<() => void>();

  const runtimes = {} as Record<DeckId, DeckRuntime>;
  for (const id of DECK_IDS) {
    const crossfadeGain = ctx.createGain();
    crossfadeGain.connect(master);
    const deckGain = ctx.createGain();
    deckGain.connect(crossfadeGain);
    const analysers = stemRecord(() => {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = levelScratch.length;
      analyser.connect(deckGain);
      return analyser;
    });
    const stemGains = stemRecord((stem) => {
      const gain = ctx.createGain();
      gain.connect(analysers[stem]);
      return gain;
    });
    runtimes[id] = {
      track: null, sources: [], anchorCtx: 0, anchorPos: 0, rate: 1, offset: 0, playToken: 0, loadToken: 0,
      stemGains, analysers, deckGain, crossfadeGain,
    };
  }

  const ramp = (param: AudioParam, value: number) => param.setTargetAtTime(value, ctx.currentTime, RAMP_SEC);

  function publish(next: ApplicationState) {
    state = next;
    for (const listener of listeners) listener();
  }

  function patchDeck(deck: DeckId, patch: Partial<DeckState>) {
    publish({ ...state, decks: { ...state.decks, [deck]: { ...state.decks[deck], ...patch } } });
  }

  function position(deck: DeckId): number {
    const rt = runtimes[deck];
    if (!rt.track) return 0;
    if (!state.decks[deck].playing) return rt.offset;
    const elapsed = Math.max(0, ctx.currentTime - rt.anchorCtx); // sources start slightly ahead
    return clamp(rt.anchorPos + elapsed * rt.rate, 0, rt.track.duration);
  }

  function stopSources(rt: DeckRuntime) {
    rt.playToken++;
    for (const source of rt.sources) {
      try {
        source.stop();
      } catch {
        // already stopped
      }
      source.disconnect();
    }
    rt.sources = [];
  }

  function startSources(deck: DeckId, offset: number) {
    const rt = runtimes[deck];
    if (!rt.track) return;
    stopSources(rt);
    const token = rt.playToken;
    const when = ctx.currentTime + START_AHEAD_SEC;
    rt.sources = STEM_IDS.map((stem) => {
      const source = ctx.createBufferSource();
      source.buffer = rt.track!.buffers[stem];
      source.playbackRate.value = rt.rate;
      source.connect(rt.stemGains[stem]);
      source.start(when, offset);
      return source;
    });
    rt.anchorCtx = when;
    rt.anchorPos = offset;
    rt.sources[0]!.onended = () => {
      if (rt.playToken !== token) return; // stopped on purpose
      rt.offset = rt.track?.duration ?? 0;
      stopSources(rt);
      patchDeck(deck, { playing: false, positionSec: rt.offset });
    };
  }

  function applyStemGain(deck: DeckId, stem: StemId) {
    const { volume, muted } = state.decks[deck].stems[stem];
    ramp(runtimes[deck].stemGains[stem].gain, muted ? 0 : volume);
  }

  function applyCrossfader(position: number) {
    // Equal-power: both decks at -3 dB in the middle, no dip in loudness.
    const angle = ((position + 1) / 2) * (Math.PI / 2);
    ramp(runtimes.A.crossfadeGain.gain, Math.cos(angle));
    ramp(runtimes.B.crossfadeGain.gain, Math.sin(angle));
  }
  applyCrossfader(0);

  async function load(deck: DeckId, manifestUrl: string) {
    const rt = runtimes[deck];
    const token = ++rt.loadToken;
    stopSources(rt);
    rt.offset = 0;
    patchDeck(deck, { status: 'loading', error: null, playing: false, positionSec: 0 });
    try {
      const track = await loadTrack(ctx, manifestUrl);
      if (rt.loadToken !== token) return; // a newer load won
      rt.track = track;
      const m = track.manifest;
      patchDeck(deck, {
        status: 'ready',
        track: {
          id: m.id, title: m.title, artist: m.artist, bpm: m.bpm, firstBeatSec: m.firstBeatSec,
          durationSec: track.duration, manifestUrl: track.manifestUrl,
        },
      });
    } catch (err) {
      if (rt.loadToken !== token) return;
      rt.track = null;
      patchDeck(deck, { status: 'error', error: String(err instanceof Error ? err.message : err), track: null });
    }
  }

  function dispatch(command: AudioCommand) {
    switch (command.type) {
      case 'deck/load':
        void load(command.deck, command.manifestUrl);
        return;
      case 'deck/play': {
        const rt = runtimes[command.deck];
        if (!rt.track || state.decks[command.deck].playing) return;
        void ctx.resume();
        const from = rt.offset >= rt.track.duration - 0.05 ? 0 : rt.offset;
        startSources(command.deck, from);
        patchDeck(command.deck, { playing: true, positionSec: from });
        return;
      }
      case 'deck/pause': {
        const rt = runtimes[command.deck];
        if (!state.decks[command.deck].playing) return;
        rt.offset = position(command.deck);
        stopSources(rt);
        patchDeck(command.deck, { playing: false, positionSec: rt.offset });
        return;
      }
      case 'deck/seek': {
        const rt = runtimes[command.deck];
        if (!rt.track) return;
        const t = clamp(command.timeSec, 0, rt.track.duration);
        rt.offset = t;
        if (state.decks[command.deck].playing) startSources(command.deck, t);
        patchDeck(command.deck, { positionSec: t });
        return;
      }
      case 'stem/setVolume':
      case 'stem/setMuted': {
        const deck = state.decks[command.deck];
        const stem = deck.stems[command.stem];
        const next =
          command.type === 'stem/setVolume'
            ? { ...stem, volume: clamp(command.volume, 0, 1) }
            : { ...stem, muted: command.muted };
        patchDeck(command.deck, { stems: { ...deck.stems, [command.stem]: next } });
        applyStemGain(command.deck, command.stem);
        return;
      }
      case 'deck/setVolume': {
        const volume = clamp(command.volume, 0, 1);
        ramp(runtimes[command.deck].deckGain.gain, volume);
        patchDeck(command.deck, { volume });
        return;
      }
      case 'deck/setRate': {
        const rt = runtimes[command.deck];
        const rate = clamp(command.rate, 0.5, 2);
        if (state.decks[command.deck].playing) {
          // Re-anchor so the playhead doesn't jump when the speed changes.
          rt.anchorPos = position(command.deck);
          rt.anchorCtx = Math.max(ctx.currentTime, rt.anchorCtx);
          for (const source of rt.sources) source.playbackRate.setValueAtTime(rate, rt.anchorCtx);
        }
        rt.rate = rate;
        patchDeck(command.deck, { playbackRate: rate });
        return;
      }
      case 'mixer/setCrossfader': {
        const crossfader = clamp(command.position, -1, 1);
        applyCrossfader(crossfader);
        publish({ ...state, mixer: { ...state.mixer, crossfader } });
        return;
      }
    }
  }

  return {
    dispatch,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getPosition: position,
    getOutputStream: () => {
      void ctx.resume();
      return recordTap.stream;
    },
    getLevels(deck) {
      const rt = runtimes[deck];
      const playing = state.decks[deck].playing;
      return stemRecord((stem) => {
        if (!playing) return 0;
        rt.analysers[stem].getFloatTimeDomainData(levelScratch);
        let sum = 0;
        for (const v of levelScratch) sum += v * v;
        // RMS mapped so a loud stem sits near the top of the meter.
        return clamp(Math.sqrt(sum / levelScratch.length) * 3.2, 0, 1);
      });
    },
  };
}
