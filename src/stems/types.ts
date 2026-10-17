// Data contract for prepared stems (Task 5). Produced by tools/stems/prepare_stems.py,
// consumed by the audio engine (Task 1) and the DJ UI waveforms (Task 3).
//
// STEM_IDS / StemId mirror the shared StemId contract in CLAUDE.md. If the team's
// shared contracts module lands, re-export StemId from there instead of redefining it.

export const STEM_IDS = ['vocals', 'drums', 'bass', 'instrumental'] as const;

/** `instrumental` = everything that is not vocals, drums or bass (Demucs "other"). */
export type StemId = (typeof STEM_IDS)[number];

export const STEM_MANIFEST_VERSION = 1;

export interface StemFileInfo {
  /** Path relative to the manifest. */
  file: string;
  peakDb: number;
  rmsDb: number;
}

/** <track-id>/manifest.json */
export interface TrackManifest {
  version: number;
  id: string;
  title: string;
  artist: string;
  /** Sample rate of the files on disk (decoded buffers use the AudioContext's rate). */
  sampleRate: number;
  channels: number;
  /** Exact frame count shared by every stem file. */
  frames: number;
  durationSec: number;
  bpm: number;
  bpmSource: 'estimated' | 'manual';
  /** Beat-grid phase: beats fall at firstBeatSec + k * 60 / bpm (k may be 0). */
  firstBeatSec: number;
  /** Gain already baked into every stem (same for all stems of the track). */
  gainDb: number;
  mixPeakDb: number;
  mixRmsDb: number;
  /** e.g. "demucs:htdemucs", "import", "synthetic". */
  source: string;
  stems: Record<StemId, StemFileInfo>;
  /** Path relative to the manifest. */
  waveform: string;
}

/** index.json at the stems root. */
export interface TrackIndex {
  version: number;
  tracks: TrackIndexEntry[];
}

export interface TrackIndexEntry {
  id: string;
  title: string;
  artist: string;
  bpm: number;
  durationSec: number;
  /** Path relative to index.json. */
  manifest: string;
}

/** <track-id>/waveform.json: max |amplitude| per bucket, 0-255 (255 = full scale). */
export interface TrackWaveform {
  version: number;
  bucketsPerSecond: number;
  stems: Record<StemId, number[]>;
  /** Summed stems. */
  mix: number[];
}

/**
 * A decoded track. Every buffer has the same length and sample rate, so starting all
 * stems with the same `when` and `offset` keeps them sample-aligned.
 */
export interface LoadedTrack {
  manifest: TrackManifest;
  /** Absolute URL of manifest.json; resolve relative paths (e.g. waveform) against it. */
  manifestUrl: string;
  buffers: Record<StemId, AudioBuffer>;
  /** Shared length of every buffer, in frames at the AudioContext's sample rate. */
  length: number;
  duration: number;
}
