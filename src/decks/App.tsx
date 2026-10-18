import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { STEM_IDS, type DeckId, type StemId } from '../shared/types';
import { DeckPanel, stopDeck, type DeckKeys } from './components/DeckPanel';
import type { DeckSearchHandle } from './components/DeckSearch';
import { MixerStrip } from './components/MixerStrip';
import { Stage } from './components/Stage';
import { TempoFader } from './components/TempoFader';
import { Vinyl } from './components/Vinyl';
import { useEngineState, type EngineStore } from './engineStore';
import { formatTime, useSeparationServer, useTrackExtras } from './hooks';
import { DEFAULT_SIDE_COLORS } from './theme';
import { useKeyGlide } from './useKeyGlide';
import { useDeckQueues } from './useQueue';
import { useRecorder, type Recorder } from './useRecorder';

// Left hand drives deck A, right hand deck B; no mouse needed during a set.
const KEYS: Record<DeckId, DeckKeys> = {
  A: { play: 'Q', stop: 'W', cue: 'A', skip: 'S', mute: { vocals: '1', drums: '2', bass: '3', instrumental: '4' } },
  B: { play: 'P', stop: 'O', cue: ';', skip: 'L', mute: { vocals: '7', drums: '8', bass: '9', instrumental: '0' } },
};
const TEMPO_KEYS: Record<DeckId, { faster: string; slower: string }> = {
  A: { faster: 'E', slower: 'D' },
  B: { faster: 'I', slower: 'K' },
};

/** Fullscreen the whole interface (the browser allows it on a click or key press). */
function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen().catch(() => {});
}

export function App({ engine }: { engine: EngineStore }) {
  const state = useEngineState(engine);
  const extrasA = useTrackExtras(state.decks.A.track);
  const extrasB = useTrackExtras(state.decks.B.track);
  const serverReady = useSeparationServer();
  const recorder = useRecorder(engine);
  useKeyGlide(engine, TEMPO_KEYS);
  const search = useRef<Record<DeckId, DeckSearchHandle | null>>({ A: null, B: null });
  const queues = useDeckQueues(engine);

  // Keyboard: the primary way to drive Monitor 1 during a performance.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).tagName === 'INPUT') return;
      const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      const s = engine.getState();
      // Crossfader and tempo keys glide while held (useKeyGlide); everything else fires once.
      if (e.repeat) return;

      for (const deck of ['A', 'B'] as const) {
        const k = KEYS[deck];
        if (key === k.play) {
          engine.dispatch({ type: s.decks[deck].playing ? 'PAUSE' : 'PLAY', deck });
        } else if (key === k.stop) {
          stopDeck(engine, deck);
        } else if (key === k.cue) {
          engine.dispatch({ type: 'SEEK', deck, positionSec: 0 });
        } else if (key === k.skip) {
          queues.skip(deck);
        } else {
          const stem = STEM_IDS.find((st: StemId) => k.mute[st] === key);
          if (!stem) continue;
          engine.dispatch({ type: 'SET_STEM_MUTE', deck, stem, muted: !s.decks[deck].stems[stem].muted });
        }
        e.preventDefault();
        return;
      }
      if (key === 'F') toggleFullscreen();
      else if (key === 'R' && recorder.available) recorder.toggle();
      else if (key === '[') search.current.A?.focus();
      else if (key === ']') search.current.B?.focus();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [engine, recorder, queues.skip]);

  // Each side of the backdrop takes the color of that deck's album cover.
  const backdrop = {
    '--left': extrasA.coverColor ?? DEFAULT_SIDE_COLORS.A,
    '--right': extrasB.coverColor ?? DEFAULT_SIDE_COLORS.B,
  } as CSSProperties;

  return (
    <div className="backdrop" style={backdrop}>
      <Stage />
      <Vinyl deck={state.decks.A} engine={engine} firstBeatSec={extrasA.firstBeatSec} crossfader={state.mixer.crossfader} />
      <Vinyl deck={state.decks.B} engine={engine} firstBeatSec={extrasB.firstBeatSec} crossfader={state.mixer.crossfader} />

      <main className="app">
        <TopBar recorder={recorder} />
        {/* One rectangular unit, like a DJ controller: tempo | deck A | deck B | tempo, mixer below. */}
        <section className="console">
          <TempoFader deck={state.decks.A} engine={engine} keys={TEMPO_KEYS.A} />
          {(['A', 'B'] as const).map((id) => (
            <DeckPanel
              key={id}
              ref={(h) => (search.current[id] = h)}
              deck={state.decks[id]}
              engine={engine}
              extras={id === 'A' ? extrasA : extrasB}
              keys={KEYS[id]}
              serverReady={serverReady}
              queue={queues.queues[id]}
              onQueue={(t) => queues.add(id, t)}
              onUnqueue={(i) => queues.remove(id, i)}
              onSkip={() => queues.skip(id)}
            />
          ))}
          <TempoFader deck={state.decks.B} engine={engine} keys={TEMPO_KEYS.B} />
          <MixerStrip state={state} engine={engine} lyrics={{ A: extrasA.lyrics, B: extrasB.lyrics }} />
        </section>
        <footer className="legend">
          <span className="status" title="Splits new songs into stems">
            <i className={`led ${serverReady ? 'on' : serverReady === false ? 'off' : ''}`} />
            {serverReady === false ? 'separator offline' : 'separator ready'}
          </span>
          <span className="status" title="Task 1 audio engine (Web Audio)">
            <i className={`led ${state.decks.A.status === 'error' || state.decks.B.status === 'error' ? 'off' : 'on'}`} />
            audio engine
          </span>
          <span><kbd>[</kbd> <kbd>]</kbd> find a song</span>
          <span><kbd>Q</kbd> <kbd>P</kbd> play</span>
          <span><kbd>W</kbd> <kbd>O</kbd> stop</span>
          <span><kbd>E</kbd><kbd>D</kbd> <kbd>I</kbd><kbd>K</kbd> tempo</span>
          <span><kbd>A</kbd> <kbd>;</kbd> cue</span>
          <span><kbd>S</kbd> <kbd>L</kbd> skip</span>
          <span><kbd>1</kbd>–<kbd>4</kbd> <kbd>7</kbd>–<kbd>0</kbd> mute stems</span>
          <span><kbd>R</kbd> record</span>
          <span><kbd>F</kbd> fullscreen</span>
        </footer>
      </main>

      {/* Marker-style wobble for outlines, so borders feel drawn rather than ruled. */}
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
        <filter id="wobble">
          <feTurbulence type="fractalNoise" baseFrequency="0.018" numOctaves="2" seed="4" />
          <feDisplacementMap in="SourceGraphic" scale="3.5" />
        </filter>
      </svg>
    </div>
  );
}

function TopBar({ recorder }: { recorder: Recorder }) {
  const [now, setNow] = useState(() => new Date());
  const [fullscreen, setFullscreen] = useState(() => Boolean(document.fullscreenElement));
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 10_000);
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      clearInterval(id);
      document.removeEventListener('fullscreenchange', onChange);
    };
  }, []);

  return (
    <header className="topbar">
      <h1 className="wordmark">
        Beat
        <NoteD />
        rop
      </h1>
      <div className="spacer" />
      {recorder.available && (
        <button
          className={`pill rec${recorder.recording ? ' on' : ''}`}
          onClick={recorder.toggle}
          title={recorder.recording ? 'Stop recording and save the set (R)' : 'Record the mix (R)'}
        >
          <i className="rec-dot" />
          {recorder.recording ? `Stop rec ${formatTime(recorder.elapsed)}` : 'Record'}
          <kbd>R</kbd>
        </button>
      )}
      <span className="clock">{now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
      <button className="pill fs" onClick={toggleFullscreen} title="Fullscreen (F)">
        {fullscreen ? (
          <svg viewBox="0 0 20 20"><path d="M7 2.5 V7 H2.5 M13 2.5 V7 H17.5 M7 17.5 V13 H2.5 M13 17.5 V13 H17.5" /></svg>
        ) : (
          <svg viewBox="0 0 20 20"><path d="M2.5 7 V2.5 H7 M13 2.5 H17.5 V7 M2.5 13 V17.5 H7 M17.5 13 V17.5 H13" /></svg>
        )}
        {fullscreen ? 'Exit' : 'Fullscreen'}
      </button>
    </header>
  );
}

/** The "d" in the wordmark, drawn as an eighth note. */
function NoteD() {
  return (
    <svg className="note-d" viewBox="0 0 36 62" aria-label="d">
      <g fill="none" stroke="currentColor" strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M 22.5 45 C 22 36, 6 35, 5.5 46 C 5 56, 22 57, 22.5 45" />
        <path d="M 23 47 L 23.5 6" />
        <path d="M 23.5 6 C 26 12, 33 13, 32 23" />
      </g>
    </svg>
  );
}
