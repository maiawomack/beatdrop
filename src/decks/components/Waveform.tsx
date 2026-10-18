import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { STEM_IDS, type DeckState } from '../../shared/types';
import type { EngineStore } from '../engineStore';
import type { TrackWaveform } from '../../stems';
import { useAnimationFrame } from '../hooks';
import { DECK_COLORS, ORANGE, STEM_COLORS } from '../theme';

const WINDOW_SEC = 8;

/** Size a canvas's backing store to its CSS box at device pixel ratio. Returns the 2D context. */
function fit(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return canvas.getContext('2d');
}

/** Per-track gain so the loudest moment fills a lane (quiet masters still read well). */
const norms = new WeakMap<TrackWaveform, number>();
function normFor(waveform: TrackWaveform): number {
  let norm = norms.get(waveform);
  if (norm === undefined) {
    let max = 1;
    for (const peaks of Object.values(waveform.stems)) for (const p of peaks) if (p > max) max = p;
    norm = 255 / max;
    norms.set(waveform, norm);
  }
  return norm;
}

interface Props {
  deck: DeckState;
  engine: EngineStore;
  waveform: TrackWaveform | null;
}

/**
 * One lane per stem, scrolling past a fixed center playhead. Lane height follows the
 * stem's volume and a muted stem goes grey, so gestures on Monitor 2 show up here.
 */
export function Waveform({ deck, engine, waveform, firstBeatSec }: Props & { firstBeatSec: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useAnimationFrame(() => {
    const canvas = ref.current;
    const g = canvas && fit(canvas);
    if (!canvas || !g) return;
    const { width: w, height: h } = canvas;
    const dpr = window.devicePixelRatio || 1;
    const cx = w / 2;
    const laneH = h / STEM_IDS.length;
    g.clearRect(0, 0, w, h);

    // Lane dividers.
    g.fillStyle = '#1c1524';
    for (let i = 1; i < STEM_IDS.length; i++) g.fillRect(0, Math.round(i * laneH), w, dpr);

    if (!waveform || !deck.track) return;
    const pos = engine.position(deck.id);
    const pxPerSec = w / WINDOW_SEC;

    // Beat grid: every beat light, every bar (4 beats) a bit stronger.
    const { bpm } = deck;
    if (bpm && bpm > 0) {
      const beat = 60 / bpm;
      const startK = Math.ceil((pos - WINDOW_SEC / 2 - firstBeatSec) / beat);
      const endK = Math.floor((pos + WINDOW_SEC / 2 - firstBeatSec) / beat);
      for (let k = startK; k <= endK; k++) {
        const x = Math.round(cx + (firstBeatSec + k * beat - pos) * pxPerSec);
        g.fillStyle = ((k % 4) + 4) % 4 === 0 ? '#3b2d4a' : '#1d1626';
        g.fillRect(x, 0, dpr, h);
      }
    }

    const bps = waveform.bucketsPerSecond;
    const step = 3 * dpr;
    const norm = normFor(waveform);
    STEM_IDS.forEach((stem, lane) => {
      const peaks = waveform.stems[stem];
      const { gain: volume, muted } = deck.stems[stem];
      const mid = laneH * lane + laneH / 2;
      const maxH = laneH / 2 - 4 * dpr;
      const scale = muted ? 0.35 : volume;
      g.beginPath();
      g.moveTo(0, mid);
      const heights: number[] = [];
      for (let x = 0; x <= w + step; x += step) {
        const t0 = pos + (x - step / 2 - cx) / pxPerSec;
        const t1 = pos + (x + step / 2 - cx) / pxPerSec;
        let peak = 0;
        for (let i = Math.floor(t0 * bps); i <= Math.floor(t1 * bps); i++) peak = Math.max(peak, peaks[i] ?? 0);
        const bh = Math.min(1, (peak / 255) * norm) * maxH * scale;
        heights.push(bh);
        g.lineTo(x, mid - bh);
      }
      for (let i = heights.length - 1; i >= 0; i--) g.lineTo(i * step, mid + heights[i]!);
      g.closePath();
      g.fillStyle = muted ? '#2a2233' : STEM_COLORS[stem];
      g.shadowColor = STEM_COLORS[stem];
      g.shadowBlur = muted ? 0 : 8 * dpr;
      g.fill();
      g.shadowBlur = 0;
    });

    // Fade what has already played.
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = 'rgba(11, 7, 16, 0.6)';
    g.fillRect(0, 0, cx, h);
    g.globalCompositeOperation = 'source-over';

    // Playhead with small caps.
    g.fillStyle = ORANGE;
    g.shadowColor = ORANGE;
    g.shadowBlur = 10 * dpr;
    g.fillRect(Math.round(cx - dpr), 0, 2 * dpr, h);
    const cap = 6 * dpr;
    g.beginPath();
    g.moveTo(cx - cap, 0);
    g.lineTo(cx + cap, 0);
    g.lineTo(cx, cap);
    g.moveTo(cx - cap, h);
    g.lineTo(cx + cap, h);
    g.lineTo(cx, h - cap);
    g.fill();
    g.shadowBlur = 0;
  });

  return (
    <div className="wave">
      <canvas ref={ref} />
    </div>
  );
}

/** Whole-track overview with progress; click to seek. */
export function Overview({ deck, engine, waveform }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const shape = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    shape.current = null; // new track: redraw the shape
  }, [waveform]);

  useAnimationFrame(() => {
    const canvas = ref.current;
    const g = canvas && fit(canvas);
    if (!canvas || !g) return;
    const { width: w, height: h } = canvas;
    g.clearRect(0, 0, w, h);
    if (!deck.track || !deck.durationSec) return;
    const px = (engine.position(deck.id) / deck.durationSec) * w;
    if (!waveform) {
      // Full mix (not split yet): no peaks, just a progress bar.
      g.fillStyle = '#3a3a44';
      g.fillRect(0, h / 2 - 2, w, 4);
      g.fillStyle = DECK_COLORS[deck.id];
      g.fillRect(0, h / 2 - 2, px, 4);
      g.fillStyle = ORANGE;
      g.fillRect(Math.round(px), 0, 2, h);
      return;
    }

    if (!shape.current || shape.current.width !== w || shape.current.height !== h) {
      const off = document.createElement('canvas');
      off.width = w;
      off.height = h;
      const og = off.getContext('2d')!;
      const peaks = waveform.mix;
      const per = peaks.length / w;
      const norm = 255 / Math.max(1, ...peaks);
      og.fillStyle = '#000';
      for (let x = 0; x < w; x++) {
        let max = 0;
        for (let i = Math.floor(x * per); i < Math.floor((x + 1) * per); i++) max = Math.max(max, peaks[i] ?? 0);
        const bh = Math.min(1, (max / 255) * norm) * (h / 2 - 2);
        og.fillRect(x, h / 2 - bh, 1, bh * 2);
      }
      shape.current = off;
    }

    // Tint the shape: played part in mane blue, the rest in light sky.
    g.drawImage(shape.current, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = '#3a2c48';
    g.fillRect(0, 0, w, h);
    g.fillStyle = DECK_COLORS[deck.id];
    g.fillRect(0, 0, px, h);
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = ORANGE;
    g.fillRect(Math.round(px), 0, 2, h);
  });

  const seek = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!deck.track || !deck.durationSec) return;
    const box = e.currentTarget.getBoundingClientRect();
    const fraction = (e.clientX - box.left) / box.width;
    engine.dispatch({ type: 'SEEK', deck: deck.id, positionSec: fraction * deck.durationSec });
  };

  return (
    <div className="overview" onPointerDown={seek}>
      <canvas ref={ref} />
    </div>
  );
}
