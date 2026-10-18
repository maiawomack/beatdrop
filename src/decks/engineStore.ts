import { useSyncExternalStore } from 'react';
import type { AudioEngine } from '../audio/AudioEngine';
import type { AudioCommand, AudioEngineState, DeckId, StemId } from '../shared/types';

/**
 * React glue for Task 1's AudioEngine. The engine's getState() returns a fresh clone on
 * every call, which useSyncExternalStore can't use directly, so this caches the latest
 * snapshot from subscribe(). Everything the decks UI does goes through here.
 */
export class EngineStore {
  private snapshot: AudioEngineState;
  private readonly listeners = new Set<() => void>();

  constructor(readonly engine: AudioEngine) {
    this.snapshot = engine.getState();
    engine.subscribe((state) => {
      this.snapshot = state;
      for (const listener of this.listeners) listener();
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): AudioEngineState => this.snapshot;

  /** Fire-and-forget; the engine reports failures (e.g. a bad file) in deck state. */
  dispatch = (command: AudioCommand): void => {
    this.engine.dispatch(command).catch((err) => console.error('audio command failed', command, err));
  };

  /** Live playhead, cheap enough for every animation frame. */
  position = (deck: DeckId): number => this.engine.getPositionSec(deck);

  levels = (deck: DeckId): Record<StemId, number> => this.engine.getLevels(deck);
}

export function useEngineState(store: EngineStore): AudioEngineState {
  return useSyncExternalStore(store.subscribe, store.getState);
}
