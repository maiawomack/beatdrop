/**
 * Shared contracts between BeatDrop subsystems.
 *
 * DRAFT — proposed by the audio engine (Task 1). The DJ UI (Task 3), Spatial AR
 * (Task 4) and Integration (Task 6) depend on these types; agree on changes with
 * the team before editing. Everything here must stay plain, serializable data so
 * it can be sent over BroadcastChannel between windows.
 */

import { STEM_IDS, type StemId } from '../stems/types';

export type DeckId = 'A' | 'B';
export const DECK_IDS: readonly DeckId[] = ['A', 'B'];

// Stem ids are defined once, by the stem pipeline's data contract (Task 5).
export { STEM_IDS, type StemId };

export type EqBand = 'low' | 'mid' | 'high';
export const EQ_BANDS: readonly EqBand[] = ['low', 'mid', 'high'];

export interface TrackInfo {
  /** Stable library id derived from the file path, e.g. "calvin-harris-summer". */
  id: string;
  title: string;
  artists: string[];
  album: string | null;
  artworkUrl: string | null;
  /** Null until the audio has been decoded (the library doesn't parse durations). */
  durationMs: number | null;
  /** Path of the source file inside mp3/, for display. */
  fileName: string;
  /** Full-mix URL the engine fetches and decodes. */
  audioUrl: string | null;
  /**
   * manifest.json written by the stem pipeline (tools/stems), or null when the track
   * hasn't been separated yet. Loaded with loadTrack() from src/stems.
   */
  stemsManifestUrl: string | null;
  /** From the stems manifest when separated; otherwise set manually (SET_BPM). */
  bpm: number | null;
}

// ---------------------------------------------------------------------------
// Commands — the only way other subsystems change audio.
// Ranges: gains 0..1, crossfader -1 (full A) .. +1 (full B), EQ dB -24..+6,
// filter -1 (low-pass) .. 0 (off) .. +1 (high-pass), echo 0..1, rate 0.5..2.
// The engine clamps out-of-range values rather than throwing.
// ---------------------------------------------------------------------------

export type AudioCommand =
  /** Loads the separated stems when `track.stemsManifestUrl` is set, else the full mix at `track.audioUrl`. */
  | { type: 'LOAD_TRACK'; deck: DeckId; track: TrackInfo }
  | { type: 'UNLOAD_TRACK'; deck: DeckId }
  | { type: 'PLAY'; deck: DeckId }
  | { type: 'PAUSE'; deck: DeckId }
  | { type: 'TOGGLE_PLAY'; deck: DeckId }
  | { type: 'SEEK'; deck: DeckId; positionSec: number }
  | { type: 'SET_DECK_GAIN'; deck: DeckId; gain: number }
  | { type: 'SET_STEM_GAIN'; deck: DeckId; stem: StemId; gain: number }
  | { type: 'SET_STEM_MUTE'; deck: DeckId; stem: StemId; muted: boolean }
  | { type: 'SET_EQ'; deck: DeckId; band: EqBand; gainDb: number }
  | { type: 'SET_FILTER'; deck: DeckId; value: number }
  | { type: 'SET_ECHO'; deck: DeckId; amount: number }
  | { type: 'SET_LOOP'; deck: DeckId; startSec: number; endSec: number }
  | { type: 'CLEAR_LOOP'; deck: DeckId }
  | { type: 'SET_PLAYBACK_RATE'; deck: DeckId; rate: number }
  | { type: 'SET_BPM'; deck: DeckId; bpm: number | null }
  | { type: 'SET_CROSSFADER'; value: number }
  | { type: 'SET_MASTER_GAIN'; gain: number };

// ---------------------------------------------------------------------------
// State — published by the engine owner; read-only for everyone else.
// ---------------------------------------------------------------------------

/**
 * Where a deck's audio comes from. Both are decoded into Web Audio, so every control
 * works and both decks play simultaneously.
 * - 'stems': separated stem files (per-stem gain/mute available).
 * - 'full': only the full mix (per-stem controls are stored but have no effect).
 */
export type DeckSource = 'none' | 'stems' | 'full';
export type DeckStatus = 'empty' | 'loading' | 'ready' | 'error';

export interface StemState {
  gain: number;
  muted: boolean;
  /** False when the loaded track has no file for this stem. */
  available: boolean;
}

export interface LoopState {
  startSec: number;
  endSec: number;
}

export interface DeckState {
  id: DeckId;
  track: TrackInfo | null;
  source: DeckSource;
  status: DeckStatus;
  error: string | null;
  playing: boolean;
  /**
   * Position at wall-clock time `positionAt` (Date.now() ms). To get a live
   * position in another window: positionSec + (Date.now() - positionAt) / 1000 * playbackRate
   * while playing (ignoring loop wrap). Within the engine's window use engine.getPositionSec(deck).
   */
  positionSec: number;
  positionAt: number;
  durationSec: number;
  playbackRate: number;
  bpm: number | null;
  gain: number;
  stems: Record<StemId, StemState>;
  eq: Record<EqBand, number>;
  filter: number;
  echo: number;
  loop: LoopState | null;
}

export interface MixerState {
  crossfader: number;
  masterGain: number;
}

export interface AudioEngineState {
  decks: Record<DeckId, DeckState>;
  mixer: MixerState;
}
