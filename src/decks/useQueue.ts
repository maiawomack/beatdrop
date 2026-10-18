import { useCallback, useEffect, useRef, useState } from 'react';
import { DECK_IDS, type DeckId, type DeckState, type TrackInfo } from '../shared/types';
import type { EngineStore } from './engineStore';

export type Queues = Record<DeckId, TrackInfo[]>;

export interface DeckQueues {
  queues: Queues;
  add(deck: DeckId, track: TrackInfo): void;
  remove(deck: DeckId, index: number): void;
  /** Loads the next queued song onto the deck; keeps playing if the deck was playing. */
  skip(deck: DeckId): void;
}

/** A finished track's playhead sits at its end (the engine stamps the exact duration). */
const END_TOLERANCE_SEC = 0.05;

/**
 * True when a deck that was playing has stopped because its song reached the end.
 * Pause leaves the playhead mid-song and Stop rewinds it, so neither counts.
 */
export function endedNaturally(wasPlaying: boolean, deck: Pick<DeckState, 'playing' | 'positionSec' | 'durationSec'>): boolean {
  return wasPlaying && !deck.playing && deck.durationSec > 0 && deck.positionSec >= deck.durationSec - END_TOLERANCE_SEC;
}

/**
 * A play queue per deck. When a deck's song plays to the end, the next queued song loads
 * onto that deck and starts; Skip does the same immediately. Pause and Stop never advance.
 */
export function useDeckQueues(engine: EngineStore): DeckQueues {
  const [queues, setQueues] = useState<Queues>({ A: [], B: [] });
  // The end-of-song listener reads the latest queues without re-subscribing.
  const latest = useRef(queues);
  latest.current = queues;

  /** Removes the deck's next song from its queue and loads it, optionally playing it. */
  const advance = useCallback(
    (deck: DeckId, play: boolean) => {
      const [next, ...rest] = latest.current[deck];
      if (!next) return;
      latest.current = { ...latest.current, [deck]: rest };
      setQueues(latest.current);
      void (async () => {
        await engine.engine.dispatch({ type: 'LOAD_TRACK', deck, track: next });
        if (play && engine.getState().decks[deck].status === 'ready') {
          engine.dispatch({ type: 'PLAY', deck });
        }
      })();
    },
    [engine],
  );

  useEffect(() => {
    const wasPlaying: Record<DeckId, boolean> = { A: false, B: false };
    for (const id of DECK_IDS) wasPlaying[id] = engine.getState().decks[id].playing;
    return engine.subscribe(() => {
      const state = engine.getState();
      for (const id of DECK_IDS) {
        const deck = state.decks[id];
        const ended = endedNaturally(wasPlaying[id], deck);
        wasPlaying[id] = deck.playing;
        if (ended) advance(id, true);
      }
    });
  }, [engine, advance]);

  const add = useCallback((deck: DeckId, track: TrackInfo) => {
    latest.current = { ...latest.current, [deck]: [...latest.current[deck], track] };
    setQueues(latest.current);
  }, []);

  const remove = useCallback((deck: DeckId, index: number) => {
    latest.current = { ...latest.current, [deck]: latest.current[deck].filter((_, i) => i !== index) };
    setQueues(latest.current);
  }, []);

  const skip = useCallback((deck: DeckId) => advance(deck, engine.getState().decks[deck].playing), [engine, advance]);

  return { queues, add, remove, skip };
}
