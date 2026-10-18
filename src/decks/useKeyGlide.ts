import { useEffect } from 'react';
import type { DeckId } from '../shared/types';
import type { EngineStore } from './engineStore';
import { clampRate } from './components/TempoFader';

/** Crossfader: units per second (full range is 2), ramping up while held. */
const XF_SPEED_START = 0.5;
const XF_SPEED_MAX = 2;
const XF_RAMP_SEC = 0.8;
/** ↓ glides back to center at this speed. */
const XF_CENTER_SPEED = 3;
/** Tempo: octaves per second (0.03 ≈ 2%/s for fine matching), ramping up while held. */
const TEMPO_SPEED_START = 0.03;
const TEMPO_SPEED_MAX = 0.33;
const TEMPO_RAMP_SEC = 1.2;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const ramp = (start: number, max: number, rampSec: number, heldSec: number) =>
  start + (max - start) * Math.min(1, heldSec / rampSec);

export const GLIDE_ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowDown'];

/**
 * Holding a crossfader or tempo key moves the slider smoothly every frame instead of
 * jumping in steps on key-repeat. Slow at first for precision, faster the longer you hold.
 */
export function useKeyGlide(engine: EngineStore, tempoKeys: Record<DeckId, { faster: string; slower: string }>) {
  useEffect(() => {
    const held = new Map<string, number>(); // key -> when it went down (ms)
    // Unsnapped values being glided, so passing through 1x or center doesn't stick.
    let xf: number | null = null;
    const octaves: Record<DeckId, number | null> = { A: null, B: null };
    let raf = 0;
    let last = 0;

    const tempoDir = (deck: DeckId) =>
      (held.has(tempoKeys[deck].faster) ? 1 : 0) - (held.has(tempoKeys[deck].slower) ? 1 : 0);
    const isGlideKey = (key: string) =>
      GLIDE_ARROWS.includes(key) || Object.values(tempoKeys).some((k) => key === k.faster || key === k.slower);

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const state = engine.getState();
      const heldSec = (key: string) => (now - (held.get(key) ?? now)) / 1000;

      const left = held.has('ArrowLeft');
      const right = held.has('ArrowRight');
      if (left || right || held.has('ArrowDown')) {
        xf ??= state.mixer.crossfader;
        if (left !== right) {
          const speed = ramp(XF_SPEED_START, XF_SPEED_MAX, XF_RAMP_SEC, heldSec(left ? 'ArrowLeft' : 'ArrowRight'));
          xf = clamp(xf + (left ? -1 : 1) * speed * dt, -1, 1);
        } else if (!left) {
          const step = XF_CENTER_SPEED * dt;
          xf = Math.abs(xf) <= step ? 0 : xf - Math.sign(xf) * step;
        }
        engine.dispatch({ type: 'SET_CROSSFADER', value: xf });
      } else {
        xf = null;
      }

      for (const deck of ['A', 'B'] as const) {
        const dir = tempoDir(deck);
        if (!dir) {
          octaves[deck] = null;
          continue;
        }
        const key = dir > 0 ? tempoKeys[deck].faster : tempoKeys[deck].slower;
        const speed = ramp(TEMPO_SPEED_START, TEMPO_SPEED_MAX, TEMPO_RAMP_SEC, heldSec(key));
        const oct = clamp((octaves[deck] ?? Math.log2(state.decks[deck].playbackRate)) + dir * speed * dt, -1, 1);
        octaves[deck] = oct;
        engine.dispatch({ type: 'SET_PLAYBACK_RATE', deck, rate: clampRate(2 ** oct) });
      }

      raf = held.size ? requestAnimationFrame(frame) : 0;
    };

    const normalize = (e: KeyboardEvent) => (e.key.length === 1 ? e.key.toUpperCase() : e.key);

    const onDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).tagName === 'INPUT') return;
      const key = normalize(e);
      if (!isGlideKey(key)) return;
      e.preventDefault();
      if (held.has(key)) return; // ignore OS key-repeat; the frame loop does the moving
      held.set(key, performance.now());
      if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };
    const onUp = (e: KeyboardEvent) => held.delete(normalize(e));
    const onBlur = () => held.clear();

    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [engine, tempoKeys]);
}
