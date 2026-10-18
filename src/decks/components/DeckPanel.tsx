import { forwardRef, useRef, useState, type CSSProperties } from 'react';
import type { AudioController, DeckState, StemId } from '../../shared/contracts';
import type { ResolvedTrackIndexEntry } from '../../stems';
import { formatTime, useAnimationFrame, type TrackExtras } from '../hooks';
import { DECK_COLORS } from '../theme';
import { DeckSearch, type DeckSearchHandle } from './DeckSearch';
import { StemBars } from './StemBars';
import { Overview, Waveform } from './Waveform';

export interface DeckKeys {
  play: string;
  stop: string;
  cue: string;
  mute: Record<StemId, string>;
}

interface Props {
  deck: DeckState;
  controller: AudioController;
  extras: TrackExtras;
  keys: DeckKeys;
  tracks: ResolvedTrackIndexEntry[];
  serverReady: boolean | null;
  onSeparated(trackId: string): Promise<ResolvedTrackIndexEntry | undefined>;
}

/** Stop = pause and rewind to the start (two commands; no separate engine command needed). */
export function stopDeck(controller: AudioController, deck: DeckState['id']) {
  controller.dispatch({ type: 'deck/pause', deck });
  controller.dispatch({ type: 'deck/seek', deck, timeSec: 0 });
}

export const DeckPanel = forwardRef<DeckSearchHandle, Props>(function DeckPanel(props, searchRef) {
  const { deck, controller, extras, keys, tracks, serverReady, onSeparated } = props;
  const elapsedRef = useRef<HTMLSpanElement>(null);
  const remainingRef = useRef<HTMLSpanElement>(null);
  const search = useRef<DeckSearchHandle | null>(null);
  const [dropping, setDropping] = useState(false);
  const ready = deck.status === 'ready' && deck.track;

  useAnimationFrame(() => {
    if (!deck.track || !elapsedRef.current || !remainingRef.current) return;
    const pos = controller.getPosition(deck.id);
    elapsedRef.current.textContent = formatTime(pos);
    remainingRef.current.textContent = `-${formatTime(deck.track.durationSec - pos)}`;
  });

  const setSearch = (handle: DeckSearchHandle | null) => {
    search.current = handle;
    if (typeof searchRef === 'function') searchRef(handle);
    else if (searchRef) searchRef.current = handle;
  };

  return (
    <section
      className={`deck ${deck.id === 'A' ? 'left' : 'right'}${deck.playing ? ' live' : ''}${dropping ? ' dropping' : ''}`}
      style={{ '--deck': DECK_COLORS[deck.id] } as CSSProperties}
      onDragOver={(e) => {
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropping(false);
        const file = e.dataTransfer.files[0];
        if (file) search.current?.separate(file);
      }}
    >
      <DeckSearch
        ref={setSearch}
        deck={deck.id}
        current={deck.track}
        tracks={tracks}
        serverReady={serverReady}
        onLoad={(t) => controller.dispatch({ type: 'deck/load', deck: deck.id, manifestUrl: t.manifestUrl })}
        onSeparated={onSeparated}
      />

      <div className="deck-row">
        <span className="deck-letter">{deck.id}</span>
        <span className="time">
          {ready ? (
            <>
              <span ref={elapsedRef}>0:00</span>
              <span className="remaining" ref={remainingRef} />
            </>
          ) : (
            <span className="remaining">--:--</span>
          )}
        </span>
        <span className="bpm">
          {ready ? (deck.track!.bpm * deck.playbackRate).toFixed(1) : '--'}
          <small>BPM</small>
        </span>
      </div>

      <div className="transport">
        <button
          className={`pill${deck.playing ? ' on' : ''}`}
          onClick={() => controller.dispatch({ type: deck.playing ? 'deck/pause' : 'deck/play', deck: deck.id })}
          disabled={!ready}
        >
          {deck.playing ? (
            <svg viewBox="0 0 20 20"><rect x="4" y="3" width="4" height="14" rx="1.5" /><rect x="12" y="3" width="4" height="14" rx="1.5" /></svg>
          ) : (
            <svg viewBox="0 0 20 20"><path d="M6 3.5 Q 5.5 3 6.4 3.3 L 16 9.3 Q 16.8 10 16 10.7 L 6.4 16.7 Q 5.5 17 6 16.5 Z" /></svg>
          )}
          {deck.playing ? 'Pause' : 'Play'}
          <kbd>{keys.play}</kbd>
        </button>
        <button className="pill" onClick={() => stopDeck(controller, deck.id)} disabled={!ready} title="Stop and go back to the start">
          <svg viewBox="0 0 20 20"><rect x="4" y="4" width="12" height="12" rx="2.5" /></svg>
          Stop
          <kbd>{keys.stop}</kbd>
        </button>
        <button
          className="pill"
          onClick={() => controller.dispatch({ type: 'deck/seek', deck: deck.id, timeSec: 0 })}
          disabled={!ready}
          title="Jump back to the start (keeps playing)"
        >
          <svg viewBox="0 0 20 20"><rect x="3.5" y="3.5" width="2.6" height="13" rx="1.3" /><path d="M16.5 4 Q 17 3.4 16 3.8 L 8 9.3 Q 7.2 10 8 10.7 L 16 16.2 Q 17 16.6 16.5 16 Z" /></svg>
          Cue
          <kbd>{keys.cue}</kbd>
        </button>
      </div>

      <div className="screen">
        {!ready && (
          <span className="screen-status">
            {deck.status === 'loading' ? (
              'loading stems…'
            ) : deck.status === 'error' ? (
              <span className="err">{deck.error}</span>
            ) : (
              `empty · press ${deck.id === 'A' ? '[' : ']'} to find a song`
            )}
          </span>
        )}
        <Waveform deck={deck} controller={controller} waveform={extras.waveform} />
        <Overview deck={deck} controller={controller} waveform={extras.waveform} />
      </div>

      <StemBars deck={deck} controller={controller} muteKeys={keys.mute} />
    </section>
  );
});
