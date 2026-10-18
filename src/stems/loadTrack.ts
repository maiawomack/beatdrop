// Loads prepared stems into Web Audio buffers. No playback or UI here: the audio
// engine owns playback and decides how buffers are routed and started.

import {
  STEM_IDS,
  STEM_MANIFEST_VERSION,
  type LoadedTrack,
  type StemId,
  type TrackIndex,
  type TrackIndexEntry,
  type TrackLyrics,
  type TrackManifest,
  type TrackWaveform,
} from './types';

/** Default location when the stems folder is served from the app's public root. */
export const DEFAULT_STEMS_INDEX_URL = '/stems/index.json';

/** Decoders may round a resampled length differently; anything beyond this is a real mismatch. */
const LENGTH_TOLERANCE_FRAMES = 2;

export class StemLoadError extends Error {
  constructor(message: string, readonly trackId?: string, readonly stem?: StemId) {
    super(message);
    this.name = 'StemLoadError';
  }
}

export interface LoadTrackOptions {
  signal?: AbortSignal;
  /** Called after each stem finishes decoding. */
  onProgress?: (decodedStems: number, totalStems: number) => void;
}

export interface ResolvedTrackIndexEntry extends TrackIndexEntry {
  /** Absolute URL to pass to loadTrack(). */
  manifestUrl: string;
}

export async function fetchTrackIndex(
  indexUrl: string = DEFAULT_STEMS_INDEX_URL,
  signal?: AbortSignal,
): Promise<ResolvedTrackIndexEntry[]> {
  const url = absoluteUrl(indexUrl);
  const index = await fetchJson<TrackIndex>(url, signal);
  checkVersion(index.version, url);
  return index.tracks.map((entry) => ({ ...entry, manifestUrl: new URL(entry.manifest, url).href }));
}

export async function loadTrack(
  ctx: BaseAudioContext,
  manifestUrl: string,
  { signal, onProgress }: LoadTrackOptions = {},
): Promise<LoadedTrack> {
  const url = absoluteUrl(manifestUrl);
  const manifest = await fetchJson<TrackManifest>(url, signal);
  validateManifest(manifest, url);

  let decoded = 0;
  const entries = await Promise.all(
    STEM_IDS.map(async (stem) => {
      const fileUrl = new URL(manifest.stems[stem].file, url).href;
      const response = await fetchOk(fileUrl, signal);
      let buffer: AudioBuffer;
      try {
        buffer = await ctx.decodeAudioData(await response.arrayBuffer());
      } catch (err) {
        throw new StemLoadError(`could not decode ${fileUrl}: ${String(err)}`, manifest.id, stem);
      }
      onProgress?.(++decoded, STEM_IDS.length);
      return [stem, buffer] as const;
    }),
  );
  signal?.throwIfAborted();

  // Stems are written with identical frame counts; after the browser resamples to the
  // context rate they must still match, or playback would drift apart.
  const expected = Math.round((manifest.frames * ctx.sampleRate) / manifest.sampleRate);
  for (const [stem, buffer] of entries) {
    if (Math.abs(buffer.length - expected) > LENGTH_TOLERANCE_FRAMES) {
      throw new StemLoadError(
        `${stem} decoded to ${buffer.length} frames, expected ${expected}; re-run prepare_stems.py`,
        manifest.id,
        stem,
      );
    }
  }

  const buffers = {} as Record<StemId, AudioBuffer>;
  for (const [stem, buffer] of entries) {
    buffers[stem] = buffer.length === expected ? buffer : withLength(ctx, buffer, expected);
  }
  return { manifest, manifestUrl: url, buffers, length: expected, duration: expected / ctx.sampleRate };
}

export function fetchWaveform(
  track: Pick<LoadedTrack, 'manifest' | 'manifestUrl'>,
  signal?: AbortSignal,
): Promise<TrackWaveform> {
  return fetchJson<TrackWaveform>(new URL(track.manifest.waveform, track.manifestUrl).href, signal);
}

/** Lyrics for a track, or null if none were found when it was prepared. */
export async function fetchLyrics(
  track: Pick<LoadedTrack, 'manifest' | 'manifestUrl'>,
  signal?: AbortSignal,
): Promise<TrackLyrics | null> {
  if (!track.manifest.lyrics) return null;
  return fetchJson<TrackLyrics>(new URL(track.manifest.lyrics, track.manifestUrl).href, signal);
}

/**
 * Index of the synced line being sung at `timeSec` (track time, i.e. the playback
 * position), or -1 before the first line. Binary search, cheap enough per frame.
 */
export function lyricLineAt(lyrics: TrackLyrics, timeSec: number): number {
  const { lines } = lyrics;
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid]!.timeSec <= timeSec) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

function validateManifest(manifest: TrackManifest, url: string): void {
  checkVersion(manifest.version, url);
  const missing = STEM_IDS.filter((stem) => !manifest.stems?.[stem]?.file);
  if (missing.length > 0) {
    throw new StemLoadError(`${url} is missing stems: ${missing.join(', ')}`, manifest.id);
  }
  if (!(manifest.frames > 0 && manifest.sampleRate > 0)) {
    throw new StemLoadError(`${url} has invalid frames/sampleRate`, manifest.id);
  }
}

function checkVersion(version: number, url: string): void {
  if (version !== STEM_MANIFEST_VERSION) {
    throw new StemLoadError(`${url} has version ${version}, loader expects ${STEM_MANIFEST_VERSION}`);
  }
}

/** Copy into a buffer of exactly `length` frames (zero-padded or truncated). */
function withLength(ctx: BaseAudioContext, source: AudioBuffer, length: number): AudioBuffer {
  const out = ctx.createBuffer(source.numberOfChannels, length, source.sampleRate);
  for (let ch = 0; ch < source.numberOfChannels; ch++) {
    const data = source.getChannelData(ch);
    out.copyToChannel(data.length > length ? data.subarray(0, length) : data, ch);
  }
  return out;
}

function absoluteUrl(url: string): string {
  return new URL(url, globalThis.location?.href).href;
}

async function fetchOk(url: string, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new StemLoadError(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  return response;
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  return (await fetchOk(url, signal)).json() as Promise<T>;
}
