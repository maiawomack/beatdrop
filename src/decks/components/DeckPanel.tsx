import { forwardRef, useRef, useState, type CSSProperties } from 'react';
import type { DeckState, StemId, TrackInfo } from '../../shared/types';
import type { EngineStore } from '../engineStore';
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
  engine: EngineStore;
  extras: TrackExtras;
  keys: DeckKeys;
  serverReady: boolean | null;
}

/** Stop = pause and rewind to the start (two commands; no separate engine command needed). */
export function stopDeck(engine: EngineStore, deck: DeckState['id']) {
  engine.dispatch({ type: 'PAUSE', deck });
  engine.dispatch({ type: 'SEEK', deck, positionSec: 0 });
}

/**
 * Load a track. When it's the same song coming back with stems (just split), keep the
 * playhead and keep playing, so splitting mid-set doesn't interrupt the mix.
 */
async function loadOntoDeck(engine: EngineStore, deck: DeckState, track: TrackInfo) {
  const sameSong = deck.track?.id === track.id;
  const resumeAt = sameSong ? engine.position(deck.id) : 0;
  const wasPlaying = sameSong && deck.playing;
  await engine.engine.dispatch({ type: 'LOAD_TRACK', deck: deck.id, track });
  if (resumeAt > 0) engine.dispatch({ type: 'SEEK', deck: deck.id, positionSec: resumeAt });
  if (wasPlaying) engine.dispatch({ type: 'PLAY', deck: deck.id });
}

export const DeckPanel = forwardRef<DeckSearchHandle, Props>(function DeckPanel(props, searchRef) {
  const { deck, engine, extras, keys, serverReady } = props;
  const elapsedRef = useRef<HTMLSpanElement>(null);
  const remainingRef = useRef<HTMLSpanElement>(null);
  const search = useRef<DeckSearchHandle | null>(null);
  const [dropping, setDropping] = useState(false);
  const ready = deck.status === 'ready' && deck.track;

  useAnimationFrame(() => {
    if (!deck.track || !elapsedRef.current || !remainingRef.current) return;
    const pos = engine.position(deck.id);
    elapsedRef.current.textContent = formatTime(pos);
    remainingRef.current.textContent = `-${formatTime(deck.durationSec - pos)}`;
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
        if (file) search.current?.separateFile(file);
      }}
    >
      <DeckSearch
        ref={setSearch}
        deck={deck.id}
        current={deck.track}
        serverReady={serverReady}
        onLoad={(t) => void loadOntoDeck(engine, deck, t)}
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
          {ready && deck.bpm ? (deck.bpm * deck.playbackRate).toFixed(1) : '--'}
          <small>BPM</small>
        </span>
      </div>

      <div className="transport">
        <button
          className={`pill${deck.playing ? ' on' : ''}`}
          onClick={() => engine.dispatch({ type: deck.playing ? 'PAUSE' : 'PLAY', deck: deck.id })}
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
        <button className="pill" onClick={() => stopDeck(engine, deck.id)} disabled={!ready} title="Stop and go back to the start">
          <svg viewBox="0 0 20 20"><rect x="4" y="4" width="12" height="12" rx="2.5" /></svg>
          Stop
          <kbd>{keys.stop}</kbd>
        </button>
        <button
          className="pill"
          onClick={() => engine.dispatch({ type: 'SEEK', deck: deck.id, positionSec: 0 })}
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
        {ready && deck.source === 'full' && (
          <div className="unsplit-note">
            <span>Full mix · split it to unlock stems, waveform and lyrics</span>
            <button
              className="pill"
              onClick={() => search.current?.split(deck.track!)}
              disabled={serverReady === false}
              title={serverReady === false ? 'Start the separation server first' : undefined}
            >
              Split into stems
            </button>
          </div>
        )}
        {ready && <span className={`source-chip is-${deck.source}`}>{deck.source === 'stems' ? 'stems' : 'full mix'}</span>}
        <Waveform deck={deck} engine={engine} waveform={extras.waveform} firstBeatSec={extras.firstBeatSec} />
        <Overview deck={deck} engine={engine} waveform={extras.waveform} />
      </div>

      <StemBars deck={deck} engine={engine} muteKeys={keys.mute} />
    </section>
  );
});
