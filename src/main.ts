/**
 * Audio engine dev harness — a throwaway page for testing Task 1 end to end.
 * The real Monitor 1 UI (Task 3) should replace this file, reusing the same wiring:
 * engine + search bar + local library.
 */
import { AudioEngine } from './audio/AudioEngine';
import { searchLibrary, separateTrack } from './library/api';
import { DECK_IDS, STEM_IDS, type AudioCommand, type AudioEngineState, type DeckId, type DeckState, type TrackInfo } from './shared/types';
import { createSearchBar } from './ui/SearchBar';

const engine = new AudioEngine();

// Handy for teammates: `beatdrop.engine.dispatch({ type: 'SET_STEM_GAIN', deck: 'A', stem: 'vocals', gain: 0.3 })`
(window as unknown as { beatdrop: unknown }).beatdrop = { engine };

interface SliderSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  read: (d: DeckState) => number;
  command: (deck: DeckId, value: number) => AudioCommand;
}

const SLIDERS: SliderSpec[] = [
  { key: 'gain', label: 'Gain', min: 0, max: 1, step: 0.01, read: (d) => d.gain, command: (deck, gain) => ({ type: 'SET_DECK_GAIN', deck, gain }) },
  ...STEM_IDS.map((stem): SliderSpec => ({ key: stem, label: `${stem[0]!.toUpperCase()}${stem.slice(1)} stem`, min: 0, max: 1, step: 0.01, read: (d) => d.stems[stem].gain, command: (deck, gain) => ({ type: 'SET_STEM_GAIN', deck, stem, gain }) })),
  { key: 'low', label: 'EQ low (dB)', min: -24, max: 6, step: 0.5, read: (d) => d.eq.low, command: (deck, gainDb) => ({ type: 'SET_EQ', deck, band: 'low', gainDb }) },
  { key: 'mid', label: 'EQ mid (dB)', min: -24, max: 6, step: 0.5, read: (d) => d.eq.mid, command: (deck, gainDb) => ({ type: 'SET_EQ', deck, band: 'mid', gainDb }) },
  { key: 'high', label: 'EQ high (dB)', min: -24, max: 6, step: 0.5, read: (d) => d.eq.high, command: (deck, gainDb) => ({ type: 'SET_EQ', deck, band: 'high', gainDb }) },
  { key: 'filter', label: 'Filter', min: -1, max: 1, step: 0.01, read: (d) => d.filter, command: (deck, value) => ({ type: 'SET_FILTER', deck, value }) },
  { key: 'echo', label: 'Echo', min: 0, max: 1, step: 0.01, read: (d) => d.echo, command: (deck, amount) => ({ type: 'SET_ECHO', deck, amount }) },
  { key: 'rate', label: 'Rate', min: 0.5, max: 2, step: 0.01, read: (d) => d.playbackRate, command: (deck, rate) => ({ type: 'SET_PLAYBACK_RATE', deck, rate }) },
];

const LOOP_SECONDS = 4;

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <style>
    body { margin: 0; background: #0d0d12; color: #f2f2f5; font: 14px/1.4 system-ui, sans-serif; }
    main { max-width: 960px; margin: 0 auto; padding: 24px 16px; display: grid; gap: 20px; }
    h1 { font-size: 18px; margin: 0; }
    button { background: #23232e; color: inherit; border: 1px solid #2c2c38; border-radius: 6px; padding: 6px 12px; font: inherit; cursor: pointer; }
    .decks { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
    .deck { border: 1px solid #2c2c38; border-radius: 8px; padding: 14px; display: grid; gap: 8px; }
    .deck h2 { font-size: 15px; margin: 0; }
    .buttons { display: flex; gap: 8px; flex-wrap: wrap; }
    .muted { color: #9a9aa8; font-size: 12px; }
    .error { color: #ff6b6b; font-size: 12px; }
    label { display: grid; grid-template-columns: 100px 1fr; align-items: center; gap: 8px; font-size: 12px; }
    kbd { border: 1px solid #2c2c38; border-radius: 3px; padding: 0 4px; font-size: 11px; }
  </style>
  <main>
    <h1>BeatDrop — audio engine harness</h1>
    <div id="search"></div>
    <section class="decks">${DECK_IDS.map(deckTemplate).join('')}</section>
    <label>Crossfader <input id="xf" type="range" min="-1" max="1" step="0.01" value="0"></label>
    <label>Master <input id="master" type="range" min="0" max="1" step="0.01" value="1"></label>
    <p class="muted">
      Add songs by dropping audio files (mp3, wav, m4a, flac, ogg) named “Artist - Title” into <code>mp3/</code>;
      they appear in the next search.<br>
      <kbd>/</kbd> search · <kbd>Enter</kbd> load to A · <kbd>Shift+Enter</kbd> load to B ·
      <kbd>Q</kbd>/<kbd>P</kbd> play/pause A/B · <kbd>Space</kbd> play/pause both ·
      <kbd>W</kbd>/<kbd>O</kbd> loop A/B · <kbd>←</kbd>/<kbd>→</kbd> crossfader
    </p>
  </main>
`;

function deckTemplate(id: DeckId): string {
  return `
    <div class="deck" data-deck="${id}">
      <h2>Deck ${id}</h2>
      <div data-field="title" class="muted">Empty</div>
      <div data-field="info" class="muted"></div>
      <div data-field="error" class="error"></div>
      <div class="buttons">
        <button data-action="toggle">Play</button>
        <button data-action="loop">Loop ${LOOP_SECONDS}s</button>
        <button data-action="restart">⏮</button>
      </div>
      ${SLIDERS.map(
        (s) => `<label>${s.label} <input data-control="${s.key}" type="range" min="${s.min}" max="${s.max}" step="${s.step}"></label>`,
      ).join('')}
    </div>`;
}

// --- Search ----------------------------------------------------------------

async function loadTrack(track: TrackInfo, deck: DeckId): Promise<void> {
  await engine.resume();
  await engine.dispatch({ type: 'LOAD_TRACK', deck, track });
}

const searchBar = createSearchBar({
  search: (query, signal) => searchLibrary(query, signal),
  onSelect: (track, deck) => void loadTrack(track, deck),
  placeholder: 'Search your library (mp3/)…',
  minChars: 0,
  extraActions: [
    {
      label: 'Separate',
      title: 'Separate stems (needs tools/stems/separation_server.py running)',
      isAvailable: (t) => !t.stemsManifestUrl,
      run: async (t, progress) => {
        await separateTrack(t, (job) => progress(`Separating “${t.title}”: ${job.state} ${Math.round(job.progress * 100)}%`));
        searchBar.refresh();
        return `Stems ready for “${t.title}”. Load it again to use them.`;
      },
    },
  ],
});
document.querySelector('#search')!.append(searchBar.element);

// --- Decks -----------------------------------------------------------------

function deckEl(id: DeckId): HTMLElement {
  return document.querySelector<HTMLElement>(`.deck[data-deck="${id}"]`)!;
}

function toggleLoop(id: DeckId): void {
  const d = latest.decks[id];
  if (d.loop) {
    void engine.dispatch({ type: 'CLEAR_LOOP', deck: id });
  } else {
    const start = engine.getPositionSec(id);
    void engine.dispatch({ type: 'SET_LOOP', deck: id, startSec: start, endSec: start + LOOP_SECONDS });
  }
}

for (const id of DECK_IDS) {
  const root = deckEl(id);
  root.querySelector('[data-action="toggle"]')!.addEventListener('click', () => {
    void engine.dispatch({ type: 'TOGGLE_PLAY', deck: id });
  });
  root.querySelector('[data-action="loop"]')!.addEventListener('click', () => toggleLoop(id));
  root.querySelector('[data-action="restart"]')!.addEventListener('click', () => {
    void engine.dispatch({ type: 'SEEK', deck: id, positionSec: 0 });
  });
  for (const spec of SLIDERS) {
    const input = root.querySelector<HTMLInputElement>(`[data-control="${spec.key}"]`)!;
    input.addEventListener('input', () => void engine.dispatch(spec.command(id, Number(input.value))));
  }
}

const xf = document.querySelector<HTMLInputElement>('#xf')!;
xf.addEventListener('input', () => void engine.dispatch({ type: 'SET_CROSSFADER', value: Number(xf.value) }));
const master = document.querySelector<HTMLInputElement>('#master')!;
master.addEventListener('input', () => void engine.dispatch({ type: 'SET_MASTER_GAIN', gain: Number(master.value) }));

let latest: AudioEngineState = engine.getState();

engine.subscribe((state) => {
  latest = state;
  for (const id of DECK_IDS) {
    const d = state.decks[id];
    const root = deckEl(id);
    root.querySelector('[data-field="title"]')!.textContent = d.track
      ? `${d.track.title} — ${d.track.artists.join(', ')}`
      : 'Empty';
    root.querySelector('[data-field="error"]')!.textContent = d.error ?? '';
    root.querySelector('[data-action="toggle"]')!.textContent = d.playing ? 'Pause' : 'Play';
    root.querySelector('[data-action="loop"]')!.textContent = d.loop ? 'Exit loop' : `Loop ${LOOP_SECONDS}s`;
    for (const spec of SLIDERS) {
      setIfIdle(root.querySelector<HTMLInputElement>(`[data-control="${spec.key}"]`)!, spec.read(d));
    }
  }
  setIfIdle(xf, state.mixer.crossfader);
  setIfIdle(master, state.mixer.masterGain);
});

/** Reflect state changes made elsewhere (e.g. the AR window) without fighting the user's drag. */
function setIfIdle(input: HTMLInputElement, value: number): void {
  if (document.activeElement !== input) input.value = String(value);
}

function tick(): void {
  for (const id of DECK_IDS) {
    const d = latest.decks[id];
    const info = deckEl(id).querySelector('[data-field="info"]')!;
    const source = d.source === 'stems' ? `stems (${countStems(d)})` : d.source;
    info.textContent =
      d.status === 'empty'
        ? ''
        : `${d.status} · ${source} · ${formatTime(engine.getPositionSec(id))} / ${formatTime(d.durationSec)}`;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

function countStems(d: DeckState): number {
  return Object.values(d.stems).filter((s) => s.available).length;
}

function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// --- Keyboard --------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
  if (e.repeat) return;
  void engine.resume();
  const key = e.key.toLowerCase();
  if (key === '/') {
    e.preventDefault();
    searchBar.focus();
  } else if (key === 'q') {
    void engine.dispatch({ type: 'TOGGLE_PLAY', deck: 'A' });
  } else if (key === 'p') {
    void engine.dispatch({ type: 'TOGGLE_PLAY', deck: 'B' });
  } else if (key === ' ') {
    e.preventDefault();
    const anyPlaying = DECK_IDS.some((id) => latest.decks[id].playing);
    for (const id of DECK_IDS) void engine.dispatch({ type: anyPlaying ? 'PAUSE' : 'PLAY', deck: id });
  } else if (key === 'w') {
    toggleLoop('A');
  } else if (key === 'o') {
    toggleLoop('B');
  } else if ((key === 'arrowleft' || key === 'arrowright') && !(e.target instanceof HTMLInputElement)) {
    e.preventDefault();
    const step = key === 'arrowleft' ? -0.05 : 0.05;
    void engine.dispatch({ type: 'SET_CROSSFADER', value: latest.mixer.crossfader + step });
  }
});
