# Audio engine (Task 1)

## Setup

1. Install Node.js 20+ and run `npm install`.
2. Put audio files in `mp3/` (see below).
3. Run `npm run dev` and open http://127.0.0.1:5173/ (the decks interface).
   The engine test harness is at http://127.0.0.1:5173/harness.html.

No API keys or accounts are needed. Music is served from your own files by routes on the
Vite server ([`server/audioLibrary.ts`](../server/audioLibrary.ts)), so use `npm run dev` or
`npm run preview`, not a static file host.

## Adding music

- Drop files into `mp3/`. Supported: `.mp3 .wav .m4a .aac .flac .ogg .opus`. Subfolders are fine.
- Name them `Artist - Title.mp3`. That's where the artist and title come from
  (`Artist A, Artist B - Title` and `A & B - Title` give multiple artists).
- The folder is rescanned on every search, so new files appear without restarting.
- `mp3/` is committed, together with its pre-split stems in `mp3/.stems/` (see Stems below).
  Purchased music is licensed to you; keep the repository private.

Each file gets an id from its path, e.g. `mp3/Calvin Harris - Summer.mp3` → `calvin-harris-summer`.

## Stems

Stems come from the stem pipeline in [`tools/stems/`](../tools/stems/README.md) (Task 5), which
writes `mp3/.stems/<stems id>/manifest.json` plus the stem files. That folder is committed with
the songs, so a fresh clone already has them. The engine loads them with that pipeline's
`loadTrack()` from [`src/stems/`](../src/stems/).

To separate library songs, either:

- **All at once:** `.venv/bin/python tools/stems/sync_library.py` splits every song in `mp3/`
  that has no stems yet (`--watch --only-new` keeps splitting songs as they're added).
- **From the app:** start `tools/stems/separation_server.py`, then click **Split** on a search
  result or load the song and use **Split into stems**. Uploaded files are saved into `mp3/`.

Either way the output folder is `t-<hash of the file>`, and the library computes the same hash
to find it.

When a track has stems, search shows a **stems** badge and loading it plays the four stems, so
per-stem controls work and the deck's BPM comes from the manifest. Otherwise the deck plays the
full mix.

## Using the engine

One window owns the engine. Everything else sends commands:

```ts
import { AudioEngine } from './audio/AudioEngine';
import { searchLibrary } from './library/api';

const engine = new AudioEngine();
await engine.resume();                               // from a click/keydown
const [track] = await searchLibrary('summer');
await engine.dispatch({ type: 'LOAD_TRACK', deck: 'A', track });
await engine.dispatch({ type: 'PLAY', deck: 'A' });
await engine.dispatch({ type: 'SET_STEM_GAIN', deck: 'A', stem: 'vocals', gain: 0.4 });

engine.subscribe((state) => render(state)); // fires on every change, serializable
engine.getPositionSec('A');                 // live playhead for animation frames
```

All commands and state shapes are defined in [`src/shared/types.ts`](../src/shared/types.ts).

Two read-only helpers were added for the decks UI (Task 3). They don't change playback:

```ts
engine.getLevels('A');      // { vocals, drums, bass, instrumental } live level 0..1, for meters
engine.getOutputStream();   // master mix as a MediaStream, for recording a set
```

`getLevels` comes from a pass-through `AnalyserNode` after each stem's gain in `DeckChannel`.
A full-mix track reports its one level on every stem.
Both decks decode into Web Audio and share one master bus, so they play and layer at the
same time, and every control works on both.

## HTTP routes

| Route | Returns |
|---|---|
| `GET /api/library?q=<words>` | `{ tracks: TrackInfo[] }`. All words must match; empty lists everything |
| `GET /api/library/audio/<id>` | the full-mix file (Range requests supported) |
| `GET /api/library/stems/<stems id>/<file>` | files from `mp3/.stems/<stems id>/` (manifest, waveform, lyrics, stems) |
| `GET /api/library/stems/index.json` | every split track, built from the manifests |
