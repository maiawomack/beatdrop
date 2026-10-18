# Stem processing (Task 5)

Turns a raw audio file into sample-aligned **vocals / drums / bass / instrumental**
stems. `instrumental` is everything that isn't vocals, drums or bass (Demucs's "other").
Each track also gets its BPM and beat grid, title/artist from the file's tags, and
timestamped lyrics from [LRCLIB](https://lrclib.net) when they exist.

## How it fits in

```
Task 1 (audio engine)                    Task 5 (this)                        
  user picks a song file ──POST file──►  separation_server.py (localhost:8765)
                                           Demucs → align → level → BPM/beat grid
  loadTrack() ◄──── manifest + stems ───   public/stems/<track-id>/
  4 AudioBuffers, same length
  one gain node per stem ◄── AudioCommands from the spatial AR layer (Tasks 2 + 4 gestures)
```

From the app this is one call (from [`src/stems/`](../../src/stems/)):

```ts
import { separateAndLoad } from './stems';

const track = await separateAndLoad(audioContext, file, {
  onProgress: (job) => showProgress(job.state, job.progress), // queued → separating → done
});
// track.buffers.vocals / .drums / .bass / .instrumental: same length, start them together
// track.manifest.bpm, .firstBeatSec, .title; fetchWaveform(track) for waveform peaks

const lyrics = await fetchLyrics(track);            // null if none were found
if (lyrics?.synced) {
  const i = lyricLineAt(lyrics, playbackPositionSec); // current line, -1 before the first
  showLine(lyrics.lines[i]?.text ?? '');
} else if (lyrics) {
  showFullText(lyrics.plain);                       // text only, no timing
}
```

- A 3-minute song takes about **50 s** on CPU (M3 Pro). Show the progress. Pass
  `startSec` / `durationSec` to separate only part of a song: it's faster and uses less memory.
- **Re-uploading the same audio returns instantly.** Results are cached by content hash,
  even across server restarts. Separate the demo songs once before going on stage.
- Title and artist come from the file's tags (purchased files have them) unless you pass
  `title` / `artist`.
- Accepts WAV, FLAC, MP3 and OGG. On macOS it also takes M4A/AAC, and with ffmpeg
  installed, anything ffmpeg reads.
- Failures throw a `SeparationError` with a readable message: unreadable file, under
  5 s long, Demucs missing, or server not running.

## Setup (once)

```sh
python3 -m venv .venv
.venv/bin/pip install -r tools/stems/requirements.txt

# Demucs needs torch, which isn't available for every Python; use 3.12 in its own venv.
python3.12 -m venv .venv-demucs
.venv-demucs/bin/pip install -r tools/stems/requirements-demucs.txt
```

The first separation downloads the Demucs model (about 80 MB).

## Running the separation server

```sh
.venv/bin/python tools/stems/separation_server.py      # http://127.0.0.1:8765
```

Keep it running alongside the web app's dev server. It only accepts requests from
pages on this machine (`localhost` / `127.0.0.1`, any port), and it separates one song
at a time while others wait in a queue.

| Endpoint | |
|---|---|
| `POST /separate?filename=&title=&artist=&start=&duration=` | body = raw file. Returns a job (202, or 200 if already done) |
| `GET /jobs/<id>` | `{id, trackId, state, progress, manifestUrl, error}` |
| `GET /tracks` | every prepared track (`index.json`) |
| `GET /stems/<track-id>/manifest.json`, `waveform.json`, `*.wav` | prepared files |
| `GET /health` | `{ok, demucs, queued}` |

## Command line (same pipeline, no server)

```sh
P=".venv/bin/python tools/stems/prepare_stems.py"

$P demo                     # two synthetic copyright-free tracks (120 / 128 BPM), no Demucs needed
$P separate song.mp3 --title "Song" --artist "Artist" --start 30 --duration 150
$P import --mix song.wav --vocals acapella.wav --drums d.wav --bass b.wav --instrumental other.wav
$P verify                   # re-check every prepared track
$P index                    # rebuild index.json after deleting a track folder
```

`$P lyrics <track-id> --artist "Original Artist"` re-fetches lyrics for a prepared track,
e.g. when the tags are wrong or for a cover version (you get plain text only, since the
original's timing won't match). `--no-lyrics` on `separate` skips the online lookup.

`import` is for stems you already have. `--mix` aligns each stem to the full song and
lets you omit one stem. `--bpm` / `--first-beat` override the beat-grid estimate.

## Output

```
public/stems/                 (gitignored; served by the server and by a Vite-style dev server)
  index.json
  <track-id>/manifest.json    sampleRate, frames, bpm, firstBeatSec, gainDb, stem files
  <track-id>/waveform.json    per-stem peaks, 50 buckets/s, 0-255
  <track-id>/lyrics.json      lyrics, when found (manifest "lyrics" is null otherwise)
  <track-id>/{vocals,drums,bass,instrumental}.wav
```

Guarantees:
- All stems of a track share the same sample rate, stereo layout and exact frame count,
  and start on the same timeline. Start every stem with the same `when` and `offset`.
- One gain per track: stems keep their balance, tracks play at similar loudness (about
  -14 dB RMS), and nothing peaks above -1 dBFS.
- Lossless output. Don't convert stems to MP3/AAC: encoder delay breaks alignment.
- Beats fall at `firstBeatSec + k * 60 / bpm` (constant tempo). Accuracy is about 2 ms on
  test material. Spot-check real songs, since half- or double-time BPM is possible. Songs
  recorded without a click track (live bands) drift, so `bpm` is their average.
- Synced lyric timestamps are on the stems' timeline (trimmed clips are shifted). They're
  only used when LRCLIB's recording is within 3 s of the file's length; otherwise
  `synced` is false and only `plain` is set.

## Gotchas

- Decoded audio uses about 21 MB per stem-minute in the browser. Two 4-minute songs is
  about 680 MB.
- Separation quality depends on the song. Clear vocals over a steady beat work best.
  The server log prints "stems vs. original mix" SNR; above about 15 dB is good.
- `--device mps` crashes with htdemucs (torch limitation). Use the default `cpu`, or
  `cuda` on NVIDIA.
- Lyrics need internet during separation. LRCLIB is free but has brief outages (503).
  Lookups retry once, then the track is prepared without lyrics. Use `$P lyrics` to fill
  them in later.
- Don't commit real songs or their stems.
