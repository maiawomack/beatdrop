import type { TrackInfo } from '../shared/types';

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
