# Spatial performance workstation (Monitor 2)

Owner: Ruhi (Perception + Spatial AR). This doc covers:

- what the spatial monitor does
- how each gesture works
- what each gesture does to the audio
- what the spatial monitor expects from the shared audio engine and from Monitor 1

## Layout

```
 BEATDROP // SPATIAL MIX                       ▶ 120 BPM  3.2 ○●○○ · DEMO SONG
 ◯[ DRUMS  ~~~~~~~~ ]◐                          ◯[ BASS  ~~~~~~~~ ]◐
                    (open space: you, and build/drop)
 ◯[ VOCALS ~~~~~~~~ ]◐
              hint line (until you press start) · H = debug HUD
```

- **Stems:** drums upper-left, vocals lower-left, bass upper-right.
- **Build/drop:** no button. Use the **lift pose** anywhere: hand upside down, fingertips (thumb, index, middle) bunched together and pointing down, as if holding the beat up by a string.
- **Center:** kept clear so the stems don't cover your face.
- **Moving and resetting:** stems can be dragged and flicked anywhere. `R` eases them back to the default layout.
- **Sizing:** everything is sized in view-height units, so it scales with the window.

Each stem has two end caps:

- **◯ left cap = LOOP.**
- **◐ right cap = FILTER.**

Caps only work on stems that nobody is holding.

## Gestures

Every gesture uses a **closed fist** (the calibrated grab, see below). New controls get their own targets, so they never overload dragging.

| Gesture | Where | Effect | Audio command |
| --- | --- | --- | --- |
| Fist + move up/down | deck stem (locked in its column) | Volume, like the decks screen's vertical stem faders: 0.02 dead zone, then 0.4 view-height = full range, rate-limited. The stem fills like a bar and shows `VOL n` | `setVolume` |
| Fist + move | loop clip | Reposition (clips float freely; deck stems never move) | none |
| Quick fist-tap (< 280 ms, no movement) | stem body | Toggle mute | `setMute` |
| Release while moving fast | stem body | Flick: the stem glides, bounces, never overlaps | none |
| Second fist on a held stem, then pull apart or push together **vertically** | stem body | Stretch: the stem grows taller (echo FX); persists after release. Sideways spread does nothing on deck stems | `setFx` |
| One stem per hand, then pull apart or bring together | two stems | Isolate the pair: other stems duck, then restore | `setVolume` (others) |
| Fist on the **loop cap**, move up/down, then open | ◯ left cap | Choose OFF → 1 → 2 → 4 → 8 beats (one step per 0.06 view-height); the loop engages on release | `setLoop` |
| Tap on the loop cap | ◯ left cap | Toggle a 4-beat loop on / off | `setLoop` |
| Fist on the loop cap, **drag it out sideways** (> 0.14) and open the hand | ◯ left cap → open space | Pull out a **floating loop clip**. The last 1/2/4/8 beats you heard (the ladder length, 4 if OFF) repeat as a new hologram where you let go, starting on the next beat. The source stem steps aside ("CLIP OUT"). Drag back in before opening to loop in place instead | `createClip` |
| Drop or **throw** a clip back onto its stem | clip | The clip goes back in on the next beat and the source stem returns | `removeClip` |
| Fist on a stem, **twist your wrist** | stem body | Filter sweep like a knob: clockwise = highpass, counterclockwise = lowpass. Kicks in past ~17°, full sweep over another ~52°. Holds on release | `setFilter` |
| Fist on the **filter cap**, move up/down | ◐ right cap | Up = highpass, down = lowpass, relative to where you grabbed; detent at 0; the value holds on release | `setFilter` |
| Tap on the filter cap | ◐ right cap | Reset the filter to off | `setFilter 0` |
| **Lift pose**, raise it | anywhere | Build 0 → 1 over 0.35 view-height above where the pose started. A meter and energy ball follow the hand | `setBuild` |
| …then **let go** (open the fingers) with build ≥ 50%, **or pull down** (≥ 0.07 within 300 ms) | same hand | DROP, landing on the next bar; the shockwave comes from your hand | `drop` |
| …let go with a small build, or lower it slowly | same hand | Cancel: the build glides back to 0 | `setBuild 0` |
| Hand leaves frame | anywhere | Releases after a 400 ms grace; controls cancel rather than commit | `release` / none |

Position is **never** mapped to audio. Moving a stem only changes the layout.

### Avoiding accidents

These rules keep gestures from triggering by mistake:

- **Drop:**
  - Only the lift pose builds. Detection lives in perception (`HandState.lift`, in `src/perception/gestures.ts`). The pose counts when the fingertips are bunched, meaning the thumb/index/middle spread is under 0.55 palm lengths, and the wrist → fingertips direction points down the image. Once engaged, the pose holds while the hand tilts. A fist never builds, and the lift pose never grabs stems.
  - Pulling down needs build ≥ 0.25 first, and letting go needs build ≥ 0.5. Below that, letting go cancels.
  - A deliberate pull-down. It doesn't need to be a hard slam, because a hard slam blurs the camera and loses tracking.
  - Has a 1.5 s cooldown.
  - Fires at most once per grab.
- **Build:** falls back at most 0.9/s, so the slam itself doesn't drain it before the drop.
- **Losing the hand never drops.** That covers both a hand lost mid-slam and an arm dropping out of frame. It cancels the build instead.
- **Filter:** rate-limited to 4 per second, and it freezes while tracking is shaky. A one-frame glitch can't slam it.
- **Loop choice:** only applies when you deliberately open your hand. Losing tracking cancels it.
- **Locked stems:** a stem whose cap is being held can't be dragged by the other hand.
- **Stretch vs. loop:** a second hand joining a held stem always stretches. It never hits the loop cap.
- **Mixer is untouched:** build/drop, filter, loop and clips never change a stem's volume, mute or solo. A muted stem stays muted through a drop. A clip silences its source on a separate gain node (`ducked`).
- **Twist vs. dragging:** the twist filter latches only after a ~17° turn from where you grabbed, so the small wrist motions you make while dragging don't filter. The roll angle (`HandState.roll`) uses wrist → middle knuckle, which is stable in a fist. It's rate-limited like the cap.
- **Clips are their own stems:** tap a clip to mute it, twist it or use its ◐ cap to filter it, and stretch it for FX. Clips have no loop cap.

### Hand state machine (`HandMode` in `src/ar/InteractionController.ts`)

Each hand is in exactly one state per frame. At any time a hand owns at most one thing (a stem, a cap, or the build), and each stem has at most one owner. The only exception is a stretch, where both hands hold the same stem.

```
                 ┌──────────── hand lost (grace) ────────────► TRACKING_LOST ──► (release / cancel)
                 │
IDLE ──near──► HOVER ──fist──┬─ on stem body ─► GRABBING ──moves─► REPOSITIONING
  ▲              │           │                      │  └─2nd hand joins─► STRETCHING
  │              │           │                      └─other hand holds another stem─► BLENDING
  │              │           ├─ on loop cap ───► LOOP_SELECTING ──open─► setLoop (or cancel)
  │              │           ├─ on filter cap ─► FILTER_CONTROL ──open─► value held
  │   lift pose (anywhere) ────────────────────► BUILD_ARMED ──raise ≥ 0.25─► BUILDING
  │              │                                       let go / pull down ▼
  └──────────────┴──────────── open hand ◄──────────── DROP_PENDING ◄──┘
```

`interaction.handModes` exposes the current state of each hand. The cursor label shows it (MOVE, LOOP, FILTER, BUILD, DROP, LOST), and so does the debug HUD (`H`).

### Grab calibration

Press `C` to teach the app your own grab poses: about 5 s of open/relaxed hands, then about 6 s of fists.

- **Model:** a k-nearest-neighbour classifier (`src/perception/grabClassifier.ts`) on rotation- and mirror-invariant joint-distance features. It then decides grabs.
- **Storage:** the model is saved in localStorage. `Shift+C` clears it.

#### Perceptron check (optional)

Samples are labeled by the on-screen prompt, so frames where the hand was still closing,
half-open or out of view would be learned with the wrong label. With the check on, the page
takes a small snapshot about twice a second during each step. When calibration ends,
Perceptron (`perceptron-mk1.5`) names the pose in each snapshot, and hand samples recorded
near a snapshot that doesn't show the requested pose are dropped before training.

- **What Perceptron decides:** only the pose name per snapshot, as validated JSON. Which poses
  count for each step, and the model itself, stay local: thresholds still come from MediaPipe.
- **Consent:** the first time you press `C` with Perceptron set up, you're asked once (`Y`/`N`).
  `N` keeps calibration on this computer. `Shift+C` resets the answer.
- **Privacy:** snapshots (384 px JPEGs, not video) are kept in memory only until the check finishes.
  The API key never reaches the browser.
- **Fallback:** no key, service offline, slow or bad answer → trains on every sample, as before.
  Live performance never calls Perceptron.
- **Setup:** `pip install "perceptron>=0.4.0"` (in `tools/stems/requirements.txt`), put
  `PERCEPTRON_API_KEY=...` in `.env.local` at the repo root (git-ignored), and run
  `tools/stems/separation_server.py`, which serves `POST /gesture/assess`
  ([`tools/perceptron/gesture_check.py`](../tools/perceptron/gesture_check.py)).
- **Code:** `src/spatial/perceptronCalibration.ts` (snapshots, consent, sample matching; tested in
  `perceptronCalibration.test.ts`). The browser console logs what Perceptron saw.

### Keyboard

| Key | Action |
| --- | --- |
| `Space` | Play/pause |
| `1` / `2` / `3` | Mute Drums / Vocals / Bass |
| `Shift+1..3` | Solo |
| `R` | Reset layout |
| `C` | Calibrate grab |
| `H` | Debug HUD (hand states, engine values) |
| `D` | Record a debug session |

In dev builds, `window.__beatdrop` exposes `{ audio, interaction, stems }` for console testing. For example, `__beatdrop.audio.dispatch({ type: 'drop' })`.

## What is real audio vs. visual

| Feature | Audible? | How |
| --- | --- | --- |
| Mute / solo / isolate (blend) | ✅ | Mute gain / fader |
| Stretch FX | ✅ | Lowpass sweep, resonance and dotted-eighth echo (`setFx`). **Not** time-stretching. |
| Filter | ✅ | Per-stem DJ filter: lowpass (20 kHz → 160 Hz) or highpass (10 Hz → 5 kHz), resonant toward the extremes. Separate from stretch FX. |
| Loop | ✅ | Beat-quantized slip loop (details below) |
| Build | ✅ | Master-bus effect (details below) |
| Drop | ✅ | Bar-quantized release plus impact (details below) |
| Waveforms, playhead, level meter | real data | Peaks come from the decoded buffers around the actual playhead. Level comes from an analyser after the fader. |
| Loop region on the waveform | real data | Engine loop state plus the actual playback position |
| Beat pulse, grid speed, status bar.beat | real data | Engine transport (`bpm`, `anchorMs`) |
| Build energy / drop shockwave | real data | Engine `perf.build` and `perf.dropAtMs` (timed to when the drop reaches the speakers) |
| Particles, grid, reflections | decorative | Driven by the real level and beat; they don't represent any parameter |

**Loop details.** On the next beat, the engine starts a new buffer source at the exact sample position the old one would have reached, with `loopStart`/`loopEnd` set to the loop region. The switch is seamless and phase-locked.

- **Exiting** also happens on a beat, and the stem rejoins the song where it would have been (slip mode). The other stems keep playing the song.
- **Verified** in headless Chrome: playback stays inside the region, and the stem rejoins the timeline exactly on exit.

**Build details.** A master-bus effect, kept separate from the mix:

- highpass sweep, 12 Hz → 1.4 kHz with rising resonance
- bass ducked by up to 85% and drums by up to 30%, on separate "perf" gain nodes
- echo wash
- band-passed noise riser

All of it uses `setTargetAtTime` automation, so there are no clicks.

**Drop details.** The engine schedules the drop on the **next bar downbeat** (`DROP_QUANTUM_BEATS = 4`). Until then, tension keeps rising. On the downbeat:

- the highpass releases
- the ducking and riser cut
- the echo tails out
- a sub boom and noise crash play

## Driving the real songs: the Task 1 engine

The spatial page (`/spatial.html`, entry `src/spatial/main.ts`) hosts the shared two-deck engine (`src/audio/AudioEngine.ts`, Task 1). Every gesture changes the songs playing on it.

- **Loading songs:** `/` opens the song search (the library in `mp3/`). Enter loads deck A and Shift+Enter loads deck B. A song you load starts playing by itself if nothing else is.
- **Holograms per deck:** each deck's stems stand as vertical bars, the way the decks screen shows its stem faders: deck A on the left, deck B on the right, in the decks screen's order (Vocals, Drums, Bass, Inst) and its colours (`STEM_COLORS` from `src/decks/theme.ts`, so a stem looks the same on both monitors). A full mix (every library song until it's split) is one bar in its deck's colour, labelled with the song title. Each bar has its filter knob above and its loop ring below. Bars are locked in place: grab and move up/down for volume (the bar fills like a fader), two hands apart vertically for echo.
- **Adapter:** `src/bridge/task1Adapter.ts` translates spatial commands into engine commands, and engine state back into the spatial view (ids `A:vocals`, `A:full`, clips `A:full~1`).

| Spatial gesture | Engine command | Scope |
| --- | --- | --- |
| Volume (blend/isolate) | `SET_STEM_GAIN` · full mix: `SET_DECK_GAIN` · clip: `SET_CLIP_GAIN` | stem / deck / clip |
| Tap = mute | `SET_STEM_MUTE` · full mix: deck gain 0 and restore · clip: `SET_CLIP_MUTE` | stem / deck / clip |
| Filter cap, twist | `SET_CHANNEL_FILTER` · clip: `SET_CLIP_FILTER` | per channel (new) |
| Stretch | `SET_ECHO` | **whole deck** |
| Loop cap | `SET_LOOP_BEATS` | **whole deck** (the engine loops decks) |
| Pull out / return a clip | `CREATE_CLIP` / `REMOVE_CLIP` | per channel (new) |
| Lift / drop | `SET_BUILD` / `DROP` | master (new) |
| Solo, pan | not supported by the engine | — |

### Engine additions (`src/shared/types.ts`, `AudioEngine.ts`, `DeckChannel.ts`)

These are additive: existing commands and state behave exactly as before. **Siyona (Task 1) should review them.**

- **Commands:**
  - `SET_CHANNEL_FILTER`, `SET_LOOP_BEATS`
  - `CREATE_CLIP` / `REMOVE_CLIP` / `SET_CLIP_GAIN` / `SET_CLIP_MUTE` / `SET_CLIP_FILTER`
  - `SET_BUILD` / `DROP`
- **State:**
  - `DeckState` gains `firstBeatSec`, `bpmSource`, `channelFilter` and `clips`. `LoopState` gains an optional `beats`.
  - `MixerState` gains `build`, `dropPending`, `dropAtMs`, `dropQuantized` and `drops`.
- **Graph:**
  - Each channel gets a "lane" between its stem gain and the deck input: a filter pair, a duck for clips, a build-duck gain, and a level meter.
  - Clips are extra buffer sources. They stay phase-locked to the deck through play, pause, seek and rate changes.
  - The master runs through a build high-pass, plus an echo wash and a noise riser.
- **Getters:** `getEnvelope`, `getChannelLevel`, `getClipLevel` and `getClipPositionSec`, for the holograms.
- **Tempo:** a library song loaded as a full mix has no BPM, so the engine estimates BPM and beat phase on load (`src/audio/tempo.ts`, about 0.2 s). It found 128 for "Summer" and 87 for "Rude Boy". Bars are counted from the first detected beat; downbeats aren't detected. The status bar marks estimated BPMs with `~`. With no BPM, loops and clips are refused and drops fire immediately ("NO BEAT GRID").

### Both monitors share one engine (`src/integration/engineSync.ts`)

- **The decks screen (`/`, Monitor 1) owns the audio.** It calls `hostEngine(engine)` in `src/decks/main.tsx`.
- **The spatial page (`/spatial.html`, Monitor 2) mirrors it.** It uses a `RemoteEngine`, so no audio plays in the spatial window and nothing plays twice.
- **What travels between them:**
  - Commands go from the spatial page to the decks screen.
  - The decks screen sends back engine state on every change.
  - About 30 times a second while playing, it sends positions and levels.
  - Waveform envelopes are sent once per track, on request.
- **Both directions work.** Load a song or move a fader on the decks screen and the holograms follow. Grab, twist, loop, clip or drop on the spatial page and the decks screen's engine (and its UI) changes.
- **Standalone fallback.** If no decks screen answers within about 1.2 s, the spatial page runs its own engine (status: STANDALONE · NO DECKS SCREEN), so you can test gestures alone. It hands over automatically when the decks screen opens; songs loaded in standalone mode stop at that point.
- **Status indicators** (top right of the spatial page):
  - `⇄ DECKS`: connected.
  - `🔇 CLICK THE DECKS SCREEN ONCE TO ENABLE AUDIO`: browsers only start audio after a click or key press in the window that plays it.
  - `⚠ DECKS SCREEN CLOSED`: the decks screen has gone away.

**Running both:** open both pages in the **same browser** from the **same address**: `http://127.0.0.1:5173/` and `http://127.0.0.1:5173/spatial.html`. Note that `localhost` and `127.0.0.1` count as different sites, so the pages can't talk across them. Then drag each window to its own monitor.

## Tests

`npm test` runs:

- `src/ar/InteractionController.test.ts`: move/tap/flick/stretch/blend, ownership, reset.
- `src/ar/performanceControls.test.ts`:
  - build/drop: drops exactly once; mixer restored; open-mid-slam; slow-lower cancels; not enough build; tracking loss; cooldown; no drop while dragging; drop pending; independent hands
  - loop: select/commit; tap toggle; cancel on loss; stretch never loops; locked stems
  - filter: bounds; hold; tap reset; glitch rate limit; untracked freeze
  - hand state machine
- `src/audio/transport.test.ts`: beat/bar boundaries, wrap-around, loop regions, loop positions.
- `src/integration/engineSync.test.ts`:
  - spatial ↔ decks screen state and commands, in both directions
  - live positions and levels, and waveform envelopes on request
  - starting audio from the other window
  - standalone fallback
  - duplicate host detection
- `src/bridge/task1Adapter.test.ts`: the gesture → engine command mapping.
- `src/audio/tempo.test.ts`: BPM and beat-phase estimation.

Replay a debug recording through the current controller:

    REPLAY=~/Downloads/beatdrop-recording-....json npx vitest run src/debug/replay.test.ts

### Manual test (spatial monitor)

1. `npm run dev`. Open `http://127.0.0.1:5173/` (decks screen) and click anywhere on it once. Then open `http://127.0.0.1:5173/spatial.html` in the same browser, allow the camera, click **START SESSION**, and pick a song (Enter → deck A). It shows up on both screens.
2. **Loop:** fist on the ◯ cap left of DRUMS. Raise your hand two steps until the cap shows "2", then open it.
   - Within a beat, the drums repeat a half-second phrase.
   - The waveform shows repeating loop marks.
   - The status row reads `LOOP 2`.
   - Tap the cap to exit. The drums rejoin in time.
3. **Filter:** fist on the ◐ cap right of BASS and move down. The bass gets darker (LP), and its waveform smooths out. Move up for a thin highpass. Open your hand to keep the value; tap to reset.
4. **Build:** bunch your fingertips pointing down, as in "holding it by a string", and lift slowly. The meter fills, the grid speeds up and the waveforms shiver. You hear the highpass, the riser and the bass ducking.
5. **Drop:** let go (open your fingers), or pull your hand down.
   - The countdown at your fist shows the beats left ("DROP IN n · ON THE BAR").
   - On the downbeat the full mix slams back in with a sub hit, a shockwave and a flash.
6. Mute a stem (tap it), then build and drop. It stays muted.
7. **Clip:** grab the vocals ◯ cap and drag it toward the middle. A dashed ghost follows your hand; open your hand to drop it. The vocal phrase now loops from the new hologram and the vocals stem reads CLIP OUT. Throw the clip back at the vocals to end it.
8. **Twist:** grab the bass and turn your wrist clockwise. A dial appears at your fist, and the bass thins out (HP). Turn the other way for LP.
9. **Sync:** press `H` to watch hand states and engine values.

## Next (not implemented)

- A second effect (reverb/delay throw)
- Pan control
- Two decks / two songs: blend pairs across decks, and `deckId` in commands
- Monitor 1 display of loop / filter / build state (Task 3)
