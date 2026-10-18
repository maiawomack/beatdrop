import type { TrackInfo } from '../shared/types';
import { separateAudio, type SeparationJob } from '../stems';

/**
 * Client for the local music library served by server/audioLibrary.ts.
 * Tracks are the audio files in mp3/; the folder is rescanned on every call,
 * so newly added files show up in the next search.
 */

/** Lists library tracks matching `query` (all words must match). An empty query lists everything. */
export async function searchLibrary(query: string, signal?: AbortSignal): Promise<TrackInfo[]> {
  const res = await fetch(`/api/library?${new URLSearchParams({ q: query })}`, { signal });
  if (!res.ok) throw new Error(`Library request failed (${res.status})`);
  const body = (await res.json()) as { tracks: TrackInfo[] };
  return body.tracks;
}

/**
 * Sends a library file to the stem separation server (tools/stems/separation_server.py,
 * which must be running) and returns the absolute URL of its stems manifest on that server.
 * Locally the next searchLibrary() call also returns the track with `stemsManifestUrl` set;
 * on the deployed site the library lives elsewhere, so use the returned URL.
 */
export async function separateTrack(
  track: TrackInfo,
  onProgress?: (job: SeparationJob) => void,
  signal?: AbortSignal,
): Promise<string> {
  if (!track.audioUrl) throw new Error('Track has no audio file');
  const res = await fetch(track.audioUrl, { signal });
  if (!res.ok) throw new Error(`Could not read ${track.fileName} (${res.status})`);
  // A File keeps the original name and extension, which the server uses to pick a decoder.
  const file = new File([await res.blob()], track.fileName.split('/').pop() ?? track.fileName);
  return separateAudio(file, {
    title: track.title,
    artist: track.artists.length > 0 ? track.artists.join(', ') : undefined,
    onProgress,
    signal,
  });
}
