import { useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { AudioEngineState, DeckId } from '../../shared/types';
import type { EngineStore } from '../engineStore';
import { lyricLineAt, type TrackLyrics } from '../../stems';
import { useAnimationFrame } from '../hooks';
import { DECK_COLORS } from '../theme';

interface Props {
  state: AudioEngineState;
  engine: EngineStore;
  lyrics: Record<DeckId, TrackLyrics | null>;
}

/** Crossfader in the middle, each deck's current lyric line on its side. */
export function MixerStrip({ state, engine, lyrics }: Props) {
  const x = state.mixer.crossfader;

  const drag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    const apply = (clientX: number) => {
      const box = target.getBoundingClientRect();
      const position = ((clientX - box.left) / box.width) * 2 - 1;
      engine.dispatch({ type: 'SET_CROSSFADER', value: Math.abs(position) < 0.04 ? 0 : position });
    };
    target.setPointerCapture(e.pointerId);
    apply(e.clientX);
    target.onpointermove = (ev) => apply(ev.clientX);
    target.onpointerup = () => {
      target.onpointermove = null;
      target.onpointerup = null;
    };
  };

  return (
    <section className="mixer">
      <LyricLine deck="A" lyrics={lyrics.A} engine={engine} />
      <div className="xfader">
        <span
          className="side"
          style={{ '--deck': DECK_COLORS.A, '--amount': Math.cos(((x + 1) / 4) * Math.PI) } as CSSProperties}
        >
          A
        </span>
        <div className="track" onPointerDown={drag}>
          <div className="ticks" />
          <div className="slot" />
          <div className="cap" style={{ left: `${((x + 1) / 2) * 100}%` }} />
        </div>
        <span
          className="side"
          style={{ '--deck': DECK_COLORS.B, '--amount': Math.sin(((x + 1) / 4) * Math.PI) } as CSSProperties}
        >
          B
        </span>
        <div className="xfader-help">
          <kbd>←</kbd> <kbd>→</kbd> crossfade · <kbd>↓</kbd> center
        </div>
      </div>
      <LyricLine deck="B" lyrics={lyrics.B} engine={engine} />
    </section>
  );
}

function LyricLine({ deck, lyrics, engine }: { deck: DeckId; lyrics: TrackLyrics | null; engine: EngineStore }) {
  const nowRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLDivElement>(null);
  const shown = useRef(-2);
  useEffect(() => {
    shown.current = -2; // new track or lyrics finished loading: redraw
  }, [lyrics]);

  useAnimationFrame(() => {
    if (!nowRef.current || !nextRef.current) return;
    if (!lyrics?.synced) {
      if (shown.current !== -3) {
        nowRef.current.textContent = '';
        // Unsynced lyrics can't follow the music; just say they exist.
        nextRef.current.textContent = lyrics ? 'lyrics: text only, no timing' : '';
        shown.current = -3;
      }
      return;
    }
    const i = lyricLineAt(lyrics, engine.position(deck));
    if (i === shown.current) return; // only touch the DOM when the line changes
    shown.current = i;
    nowRef.current.textContent = lyrics.lines[i]?.text || (i >= 0 ? '♪' : '');
    nextRef.current.textContent = lyrics.lines.slice(i + 1).find((l) => l.text)?.text ?? '';
  });

  return (
    <div className={`lyric${deck === 'B' ? ' right' : ''}`}>
      <div className="now" ref={nowRef} />
      <div className="next" ref={nextRef} />
    </div>
  );
}
