// Client for tools/stems/separation_server.py: upload a raw audio file, wait for Demucs,
// get back aligned stems. This is the hand-off point from the audio engine (Task 1):
//
//   const track = await separateAndLoad(audioContext, file, { onProgress: (job) => ... });
//   // track.buffers.vocals / drums / bass / instrumental, all the same length

import { loadTrack } from './loadTrack';
import type { LoadedTrack } from './types';

export const DEFAULT_SEPARATION_SERVER = 'http://127.0.0.1:8765';

export type SeparationState = 'queued' | 'decoding' | 'separating' | 'analyzing' | 'done' | 'error';

export interface SeparationJob {
  /** Hash of the audio + clip range; also the track id. */
  id: string;
  trackId: string;
  state: SeparationState;
  /** Overall progress, 0..1. */
  progress: number;
  /** Server-relative manifest path once state is 'done'. */
  manifestUrl: string | null;
  error: string | null;
}

export interface SeparateOptions {
  serverUrl?: string;
  /** Defaults to the file name. */
  title?: string;
  artist?: string;
  /** Also store the uploaded file in the music library (mp3/) so it's shared with the team. */
  saveToLibrary?: boolean;
  /** Only separate part of the song (saves time and browser memory). */
  startSec?: number;
  durationSec?: number;
  signal?: AbortSignal;
  onProgress?: (job: SeparationJob) => void;
  pollIntervalMs?: number;
}

export class SeparationError extends Error {
  constructor(message: string, readonly jobId?: string) {
    super(message);
    this.name = 'SeparationError';
  }
}

/** Uploads `file`, waits for separation, and returns the absolute manifest URL. */
export async function separateAudio(file: Blob, options: SeparateOptions = {}): Promise<string> {
  const { serverUrl = DEFAULT_SEPARATION_SERVER, signal, onProgress, pollIntervalMs = 500 } = options;
  signal?.throwIfAborted();

  const url = new URL('/separate', serverUrl);
  const params: Record<string, string | number | undefined> = {
    filename: file instanceof File ? file.name : undefined,
    title: options.title,
    artist: options.artist,
    start: options.startSec,
    duration: options.durationSec,
    save: options.saveToLibrary ? 1 : undefined,
  };
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }

  let job = await requestJson<SeparationJob>(url, serverUrl, { method: 'POST', body: file, signal });
  onProgress?.(job);
  while (job.state !== 'done') {
    if (job.state === 'error') throw new SeparationError(job.error ?? 'separation failed', job.id);
    await delay(pollIntervalMs, signal);
    job = await requestJson<SeparationJob>(new URL(`/jobs/${encodeURIComponent(job.id)}`, serverUrl), serverUrl, {
      signal,
    });
    onProgress?.(job);
  }
  if (!job.manifestUrl) throw new SeparationError('server finished without a manifest', job.id);
  return new URL(job.manifestUrl, serverUrl).href;
}

/** Raw audio file in, decoded and aligned stems out. */
export async function separateAndLoad(
  ctx: BaseAudioContext,
  file: Blob,
  options: SeparateOptions = {},
): Promise<LoadedTrack> {
  const manifestUrl = await separateAudio(file, options);
  return loadTrack(ctx, manifestUrl, { signal: options.signal });
}

/** True if the separation server is running and has Demucs available. */
export async function isSeparationServerReady(serverUrl = DEFAULT_SEPARATION_SERVER): Promise<boolean> {
  try {
    const response = await fetch(new URL('/health', serverUrl));
    return response.ok && (await response.json()).demucs === true;
  } catch {
    return false;
  }
}

async function requestJson<T>(url: URL, serverUrl: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    if (init.signal?.aborted) throw err;
    throw new SeparationError(
      `separation server not reachable at ${serverUrl}; start it with: ` +
        '.venv/bin/python tools/stems/separation_server.py',
    );
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new SeparationError(body?.error ?? `${response.status} ${response.statusText}`);
  }
  return body as T;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
