import { useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { ApplicationState, AudioController, DeckId } from '../../shared/contracts';
import { lyricLineAt, type TrackLyrics } from '../../stems';
import { useAnimationFrame } from '../hooks';
import { DECK_COLORS } from '../theme';

interface Props {
  state: ApplicationState;
  controller: AudioController;
  lyrics: Record<DeckId, TrackLyrics | null>;
}

/** Crossfader in the middle, each deck's current lyric line on its side. */
export function MixerStrip({ state, controller, lyrics }: Props) {
  const x = state.mixer.crossfader;

  const drag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    const apply = (clientX: number) => {
      const box = target.getBoundingClientRect();
      const position = ((clientX - box.left) / box.width) * 2 - 1;
      controller.dispatch({ type: 'mixer/setCrossfader', position: Math.abs(position) < 0.04 ? 0 : position });
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
      <LyricLine deck="A" lyrics={lyrics.A} controller={controller} />
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
      <LyricLine deck="B" lyrics={lyrics.B} controller={controller} />
    </section>
  );
}

function LyricLine({ deck, lyrics, controller }: { deck: DeckId; lyrics: TrackLyrics | null; controller: AudioController }) {
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
    const i = lyricLineAt(lyrics, controller.getPosition(deck));
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
