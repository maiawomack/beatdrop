# Audio engine (Task 1)

## Setup

1. Install Node.js 20+ and run `npm install`.
2. Put audio files in `mp3/` (see below).
3. Run `npm run dev` and open http://127.0.0.1:5173/.

No API keys or accounts are needed. Music is served from your own files by routes on the
Vite server ([`server/audioLibrary.ts`](../server/audioLibrary.ts)), so use `npm run dev` or
`npm run preview`, not a static file host.

## Adding music

- Drop files into `mp3/`. Supported: `.mp3 .wav .m4a .aac .flac .ogg .opus`. Subfolders are fine.
- Name them `Artist - Title.mp3`. That's where the artist and title come from
  (`Artist A, Artist B - Title` and `A & B - Title` give multiple artists).
- The folder is rescanned on every search, so new files appear without restarting.
- `mp3/` and `stems/` are gitignored. Purchased music is licensed to you, so don't commit
  it; each teammate keeps their own copies.

Each file gets an id from its path, e.g. `mp3/Calvin Harris - Summer.mp3` → `calvin-harris-summer`.

## Stems (for stem processing, Task 5)

Write stems into `stems/<id>/` (or `stems/<file name without extension>/`):

```
stems/calvin-harris-summer/
  vocals.wav
  drums.wav
  bass.wav
  instrumental.wav      ("other.wav" also counts as instrumental)
```

Files named `vocals`, `drums`, `bass`, `instrumental` or `other` (any supported extension) are
detected automatically. To use other names, add a `manifest.json` such as
`{ "vocals": "song_vocals.mp3", "instrumental": "song_accomp.mp3" }`. Stems must be the same
length and start aligned with the original.

When a track has stems, search shows a **stems** badge and loading it plays the stems, so
per-stem controls work. Otherwise the deck plays the full mix.

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
Both decks decode into Web Audio and share one master bus, so they play and layer at the
same time, and every control works on both.

## HTTP routes

| Route | Returns |
|---|---|
| `GET /api/library?q=<words>` | `{ tracks: TrackInfo[] }`. All words must match; empty lists everything |
| `GET /api/library/audio/<id>` | the full-mix file (Range requests supported) |
| `GET /api/library/stems/<id>/<stem>` | one stem file |
