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
| Fist + move | stem body | Reposition (layout only) | none |
| Quick fist-tap (< 280 ms, no movement) | stem body | Toggle mute | `setMute` |
| Release while moving fast | stem body | Flick: the stem glides, bounces, never overlaps | none |
| Second fist on a held stem, then pull apart or push together | stem body | Stretch FX; persists after release | `setFx` |
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

## Audio contract (`src/audio/AudioCommands.ts`): needs Task 1 sign-off

The spatial side only talks to audio through `AudioCommandSink` and `AudioStateSource`. These are the additions, and the Task 1 engine needs to implement them (the stand-in `src/audio/WebAudioEngine.ts` is a working reference):

- **Commands:**
  - `setFilter {stemId, value -1..1}`
  - `setLoop {stemId, beats: 1|2|4|8|null}`
  - `setBuild {value 0..1}`
  - `drop {}`
  - `createClip {stemId, clipId, beats}` / `removeClip {stemId: clipId}`: loop clips are extra voices that loop a region of their source's buffer. They show up in `stems` with `clipOf` set and accept every stem command. Monitor 1 should expect stems to appear and disappear.

  Build and drop have no `stemId`: they target the master bus.
- **`StemState`** gains `filter`, `loop: {beats, startSec, endSec, engaged} | null`, `clipOf` and `ducked`.
- **`AudioStateSource`** gains:
  - `perf: {build, dropPending, dropAtMs, dropQuantized, drops}`
  - `transport: {playing, bpm, beatsPerBar, anchorMs, durationSec}`
- **`subscribe(listener)`:** the listener now takes no arguments. Read `stems`, `perf` and `transport` from the source.
- **Times** (`anchorMs`, `dropAtMs`) are wall-clock ms (`performance.timeOrigin + performance.now()`), so they mean the same instant in every window. `beatAt(transport)` gives the current beat anywhere.
- **Tempo:**
  - Demo song: 120 BPM.
  - Flat stem files in `/stems/`: the engine reads `bpm` and `firstBeatSec` from an optional `/stems/manifest.json` (the same fields as the Task 5 `TrackManifest`).
  - **No tempo:** loops are refused, and drops fire immediately. The label then says "NO BEAT GRID", so the app never pretends to be beat-synced.
- **One deck for now.** When the two-deck engine lands, we need to agree on a `deckId` for stem commands. Build/drop could then target a deck or the master.

## Cross-window sync (`src/integration/broadcastSync.ts`)

- **Host:** exactly one window hosts the engine (`hostAudioEngine`). Today that's the spatial window. It applies commands from other windows and broadcasts `{stems, perf, transport}` snapshots at up to 30 Hz, plus a 2 s heartbeat.
- **Clients:** other windows call `connectToAudioHost()`. They get the same `dispatch` / `stems` / `perf` / `transport` / `subscribe` interface as a local engine, and they never play audio.
- **Duplicate hosts:** if a second window also hosts, both hosts get `onConflict`. The spatial window then shows "⚠ ANOTHER WINDOW IS ALSO PLAYING AUDIO" in its status bar.
- **Monitor 1 doesn't exist in this repo yet.** The sync tests use a mock engine to stand in for both sides.
- **For Monitor 1 to show spatial changes**, it needs to:
  - render `stems[*].filter`
  - render `stems[*].loop` (with `engaged`)
  - render `perf.build` / `perf.dropPending`
  - flash on `perf.drops` changing

## Tests

`npm test` runs:

- `src/ar/InteractionController.test.ts`: move/tap/flick/stretch/blend, ownership, reset.
- `src/ar/performanceControls.test.ts`:
  - build/drop: drops exactly once; mixer restored; open-mid-slam; slow-lower cancels; not enough build; tracking loss; cooldown; no drop while dragging; drop pending; independent hands
  - loop: select/commit; tap toggle; cancel on loss; stretch never loops; locked stems
  - filter: bounds; hold; tap reset; glitch rate limit; untracked freeze
  - hand state machine
- `src/audio/transport.test.ts`: beat/bar boundaries, wrap-around, loop regions, loop positions.
- `src/integration/broadcastSync.test.ts`:
  - initial state sync
  - Monitor 1 → engine → Monitor 1 round trip
  - spatial → Monitor 1 mirroring
  - duplicate host detection

Replay a debug recording through the current controller:

    REPLAY=~/Downloads/beatdrop-recording-....json npx vitest run src/debug/replay.test.ts

### Manual test (spatial monitor)

1. `npm run dev`, open the page, allow the camera, then click **START SESSION**.
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
