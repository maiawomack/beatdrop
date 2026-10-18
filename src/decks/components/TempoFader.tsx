import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import type { AudioController, DeckState } from '../../shared/contracts';
import { DECK_COLORS } from '../theme';

const MIN_RATE = 0.5;
const MAX_RATE = 2;
/** One nudge = 1% faster or slower. */
export const NUDGE = 1.01;

/** Snap to normal speed when within this much of it. */
const SNAP = 0.004;

export function clampRate(rate: number): number {
  const r = Math.min(MAX_RATE, Math.max(MIN_RATE, rate));
  return Math.abs(r - 1) < SNAP ? 1 : r;
}

/** Signed percent change from normal speed, e.g. "+4.0%". */
export function formatRate(rate: number): string {
  const pct = (rate - 1) * 100;
  return `${pct > 0 ? '+' : pct < 0 ? '−' : '±'}${Math.abs(pct).toFixed(1)}%`;
}

interface Props {
  deck: DeckState;
  controller: AudioController;
  keys: { faster: string; slower: string };
}

/**
 * A turntable-style tempo fader beside the deck. The scale is in octaves so 0.5x,
 * 1x and 2x are evenly spaced (fine control around normal speed); up is faster.
 */
export function TempoFader({ deck, controller, keys }: Props) {
  const rate = deck.playbackRate;
  const octaves = Math.log2(rate); // -1 .. 1
  const setRate = (r: number) => controller.dispatch({ type: 'deck/setRate', deck: deck.id, rate: clampRate(r) });

  const drag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    const apply = (clientY: number) => {
      const box = target.getBoundingClientRect();
      const v = 1 - (2 * (clientY - box.top)) / box.height;
      setRate(2 ** Math.max(-1, Math.min(1, Math.abs(v) < 0.03 ? 0 : v)));
    };
    target.setPointerCapture(e.pointerId);
    apply(e.clientY);
    target.onpointermove = (ev) => apply(ev.clientY);
    target.onpointerup = () => {
      target.onpointermove = null;
      target.onpointerup = null;
    };
  };

  return (
    <aside
      className={`tempo ${deck.id === 'A' ? 'left' : 'right'}${rate !== 1 ? ' shifted' : ''}`}
      style={{ '--deck': DECK_COLORS[deck.id] } as CSSProperties}
      aria-label={`Deck ${deck.id} tempo`}
    >
      <span className="tempo-label">Tempo</span>
      <button className="tempo-step" onClick={() => setRate(rate * NUDGE)} title={`1% faster · hold ${keys.faster} to glide`}>
        +<kbd>{keys.faster}</kbd>
      </button>
      <div className="tempo-track" onPointerDown={drag} title="Drag to change speed">
        <span className="tempo-mark top">2×</span>
        <span className="tempo-mark mid">1×</span>
        <span className="tempo-mark bottom">½×</span>
        <div className="tempo-slot" />
        <div className="tempo-cap" style={{ top: `${((1 - octaves) / 2) * 100}%` }} />
      </div>
      <button className="tempo-step" onClick={() => setRate(rate / NUDGE)} title={`1% slower · hold ${keys.slower} to glide`}>
        −<kbd>{keys.slower}</kbd>
      </button>
      {/* Live BPM at this speed, so you see the tempo change as you move the fader. */}
      <button className="tempo-readout" onClick={() => setRate(1)} title="Back to normal speed">
        {deck.track ? (
          <>
            <b>{(deck.track.bpm * rate).toFixed(1)}</b>
            <small>BPM</small>
          </>
        ) : (
          <b>×{rate.toFixed(2)}</b>
        )}
        <small className="pct">{formatRate(rate)}</small>
      </button>
    </aside>
  );
}
