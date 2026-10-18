import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ApplicationState, AudioController, LoadedTrackInfo } from '../shared/contracts';
import {
  fetchLyrics,
  fetchWaveform,
  isSeparationServerReady,
  type TrackLyrics,
  type TrackManifest,
  type TrackWaveform,
} from '../stems';

export function useAppState(controller: AudioController): ApplicationState {
  return useSyncExternalStore(controller.subscribe, controller.getState);
}

/** Runs `frame` on every animation frame (for playheads and meters; avoids React renders). */
export function useAnimationFrame(frame: (now: number) => void): void {
  const ref = useRef(frame);
  ref.current = frame;
  useEffect(() => {
    let id = 0;
    const tick = (now: number) => {
      ref.current(now);
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, []);
}

export interface TrackExtras {
  waveform: TrackWaveform | null;
  lyrics: TrackLyrics | null;
  /** Absolute URL of the cover art, if the song had any. */
  cover: string | null;
  /** The cover's most vivid color, for the background on this deck's side. */
  coverColor: string | null;
}

const NO_EXTRAS: TrackExtras = { waveform: null, lyrics: null, cover: null, coverColor: null };

/**
 * A cover's representative color: average of its pixels weighted toward saturated
 * mid-tones, so a vivid accent wins over large black, white or grey areas.
 */
async function vividColor(url: string): Promise<string | null> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const size = 24;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  g.drawImage(img, 0, 0, size, size);
  const px = g.getImageData(0, 0, size, size).data;
  let r = 0, gr = 0, b = 0, total = 0;
  for (let i = 0; i < px.length; i += 4) {
    const [pr, pg, pb] = [px[i]! / 255, px[i + 1]! / 255, px[i + 2]! / 255];
    const max = Math.max(pr, pg, pb), min = Math.min(pr, pg, pb);
    const light = (max + min) / 2;
    const sat = max === min ? 0 : (max - min) / (1 - Math.abs(2 * light - 1));
    const weight = sat * sat * (1 - Math.abs(light - 0.5) * 1.6) + 0.002;
    r += pr * weight; gr += pg * weight; b += pb * weight; total += weight;
  }
  const to255 = (v: number) => Math.round((v / total) * 255);
  return `rgb(${to255(r)} ${to255(gr)} ${to255(b)})`;
}

/** Waveform peaks, lyrics and cover art for the loaded track (fetched once per track). */
export function useTrackExtras(track: LoadedTrackInfo | null): TrackExtras {
  const [extras, setExtras] = useState<TrackExtras>(NO_EXTRAS);
  const url = track?.manifestUrl;
  useEffect(() => {
    setExtras(NO_EXTRAS);
    if (!url) return;
    const abort = new AbortController();
    (async () => {
      const manifest = (await (await fetch(url, { signal: abort.signal })).json()) as TrackManifest;
      const ref = { manifest, manifestUrl: url };
      const [waveform, lyrics] = await Promise.all([
        fetchWaveform(ref, abort.signal),
        fetchLyrics(ref, abort.signal).catch(() => null),
      ]);
      const cover = manifest.cover ? new URL(manifest.cover, url).href : null;
      const coverColor = cover ? await vividColor(cover).catch(() => null) : null;
      if (!abort.signal.aborted) setExtras({ waveform, lyrics, cover, coverColor });
    })().catch(() => {
      // Extras are decoration; the deck still plays without them.
    });
    return () => abort.abort();
  }, [url]);
  return extras;
}

/** Polls the Task 5 separation server so the UI can say whether uploads will work. */
export function useSeparationServer(intervalMs = 10_000): boolean | null {
  const [ready, setReady] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    const check = () => isSeparationServerReady().then((ok) => alive && setReady(ok));
    check();
    const id = setInterval(check, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [intervalMs]);
  return ready;
}

export function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
