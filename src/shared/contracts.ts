// PROPOSED shared contracts (CLAUDE.md "Define shared TypeScript contracts").
// Written alongside Task 3 so the decks UI has something to build against.
// Not final: agree on these with Tasks 1 (audio engine) and 4 (spatial AR) before
// depending on them elsewhere, and announce any changes to the team.

import type { StemId } from '../stems';

export type { StemId } from '../stems';
export { STEM_IDS } from '../stems';

export type DeckId = 'A' | 'B';
export const DECK_IDS: readonly DeckId[] = ['A', 'B'];

/**
 * Everything that changes audio goes through one of these. Producers: the decks UI
 * (Task 3), the spatial AR layer (Task 4), keyboard shortcuts. Consumer: the single
 * audio engine (Task 1). Values are absolute (not deltas) so replays are idempotent.
 */
export type AudioCommand =
  | { type: 'deck/load'; deck: DeckId; manifestUrl: string }
  | { type: 'deck/play'; deck: DeckId }
  | { type: 'deck/pause'; deck: DeckId }
  | { type: 'deck/seek'; deck: DeckId; timeSec: number }
  /** 0..1 linear gain. The MVP pinch-and-drag gesture sends this for 'vocals'. */
  | { type: 'stem/setVolume'; deck: DeckId; stem: StemId; volume: number }
  | { type: 'stem/setMuted'; deck: DeckId; stem: StemId; muted: boolean }
  /** 0..1 linear gain (channel fader). */
  | { type: 'deck/setVolume'; deck: DeckId; volume: number }
  /**
   * Playback speed, 0.5..2 (1 = normal). Varispeed like a turntable: pitch moves with
   * tempo. Mirrors Task 1's SET_PLAYBACK_RATE.
   */
  | { type: 'deck/setRate'; deck: DeckId; rate: number }
  /** -1 = only deck A, 0 = both, 1 = only deck B (equal-power curve). */
  | { type: 'mixer/setCrossfader'; position: number };

export interface StemState {
  volume: number;
  muted: boolean;
}

export interface LoadedTrackInfo {
  id: string;
  title: string;
  artist: string;
  bpm: number;
  firstBeatSec: number;
  durationSec: number;
  manifestUrl: string;
}

export interface DeckState {
  id: DeckId;
  status: 'empty' | 'loading' | 'ready' | 'error';
  error: string | null;
  track: LoadedTrackInfo | null;
  playing: boolean;
  /**
   * Position when this state was published. For smooth playheads read the live
   * position from the controller instead of re-rendering on every frame.
   */
  positionSec: number;
  volume: number;
  /** Playback speed, 0.5..2. Effective BPM = track.bpm * playbackRate. */
  playbackRate: number;
  stems: Record<StemId, StemState>;
}

export interface MixerState {
  crossfader: number;
  masterVolume: number;
}

/** Authoritative state, owned by the window that owns the audio engine. */
export interface ApplicationState {
  decks: Record<DeckId, DeckState>;
  mixer: MixerState;
}

/** What UIs talk to. Implemented by the audio engine (or a stand-in until it exists). */
export interface AudioController {
  dispatch(command: AudioCommand): void;
  getState(): ApplicationState;
  /** Called on every state change; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Live playback position, cheap enough to call every animation frame. */
  getPosition(deck: DeckId): number;
  /** Live output level per stem, 0..1, for meters. */
  getLevels(deck: DeckId): Record<StemId, number>;
  /**
   * Optional: the master mix as a MediaStream, for recording a set with MediaRecorder.
   * UIs hide the record button when the engine doesn't provide it.
   */
  getOutputStream?(): MediaStream;
}
