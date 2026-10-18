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
| …then **let go** (open your hand) once it says BUILD (≥ 25%) | same hand | DROP, landing on the next beat: the energy ball falls from your hand into the wave at the bottom, which surges out | `drop` |
| …let go with a small build, or lower it slowly | same hand | Cancel: the build glides back to 0 | `setBuild 0` |
| Hand leaves frame | anywhere | Releases after a 400 ms grace; controls cancel rather than commit | `release` / none |

Position is **never** mapped to audio. Moving a stem only changes the layout.

### Avoiding accidents

These rules keep gestures from triggering by mistake:

- **Drop:**
  - Only the lift pose builds. Detection lives in perception (`HandState.lift`, in `src/perception/gestures.ts`). The pose counts when the fingers hang **together** (index/middle/ring tips within 0.55 palm lengths; the thumb can pinch them or be tucked away), the wrist → fingertips direction points down the image, and the fingers aren't curled: either they **reach** well past the knuckles (≥ 1.3 wrist-to-knuckle lengths along the hand) or they're **straight but bent down at the knuckles** (knuckle → tip ≥ 0.72 palm lengths, e.g. wrist up beside the knuckles with the fingers hanging). That keeps a **fist pointing down** (the tempo fist, fingertips curled back to the palm) from reading as the lift pose. Once engaged, the pose holds while the hand tilts. A fist never builds, and the lift pose never grabs stems.
  - Only **letting go** drops, once the build is ≥ 0.25 (the label says BUILD). Below that, letting go cancels. Moving the hand down never drops by itself; to cancel, lower the hand (the build falls with it) and then let go.
  - A hand that's **lost** while the build is up (raised out of the frame, blurred by opening fast), or whose pose ends at the top edge, counts as **letting go**: past 0.25 it drops, below that it cancels. There's no holding.
  - **Pull length:** full build is 0.55 view heights above where the lift pose started. Starting high, it shortens (to 0.25 at least) so full build stays reachable 0.12 below the top of the frame.
  - Has a 1.5 s cooldown.
  - Fires at most once per grab.
- **Build:** falls back at most 0.9/s, so dipping the hand just before letting go doesn't drain it.
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
  │              │                                       open hand (≥ 0.5) ▼
  └──────────────┴──────────── open hand ◄──────────── DROP_PENDING ◄──┘
```

`interaction.handModes` exposes the current state of each hand. The cursor label shows it (MOVE, LOOP, FILTER, BUILD, DROP, LOST), and so does the debug HUD (`H`).

### Gesture calibration (Perceptron AI)

Everyone grabs and lifts a little differently. The calibration stage personalizes the two
gestures with tunable thresholds, using **Perceptron AI** (DubHacks Perception track) to make
sure BeatDrop only learns from demonstrations that actually show the gesture.

It's offered once when you first click **Start session**, and opened any time with `C`.
`Shift+C` resets everything to the defaults.

1. **Demonstrate:** open hand, then fist, then the lift pose. Each one is about 4 s, after a
   countdown that starts once a hand is steadily in view.
2. **Perceptron finds the moments.** The demo goes to Perceptron's `perceptron-mk1.5` model as a
   short video (`video_frames`, 5 fps), and two capabilities are cross-checked:
   - **video event finding:** clip annotations mark *when* the gesture is held;
   - **image understanding:** a strict-JSON pose label for frames across the demo.

   A moment counts only where both agree. Neither was reliable alone in testing: on a video
   with no hand, event finding still returned an interval.
3. **Feedback:** confirmed for at least 1.2 s gives **✓**. Otherwise, *"Perceptron saw no fist in
   that demo. R = try again · S = skip"*.
4. **Personal profile:** built only from MediaPipe data inside the confirmed moments.
   - **Grab:** the per-user k-NN classifier (`src/perception/grabClassifier.ts`), trained on
     confirmed open and fist samples.
   - **Build/drop:** a personal lift threshold, set just above the user's 90th-percentile
     fingertip bunch (bounded to 0.35–0.95, release 0.25 higher, like the default).
5. **Before/after:** the summary reports how the defaults did on *your* confirmed demos. For
   example, *"lift threshold 0.55 → 0.67: the default caught 0% of your lift frames, yours catches
   100%"*, or how often the default fist rule caught your fist and misfired on your open hand.

**Principles:**
- **Perceptron never sets a threshold.** It decides *when* the gesture happened; the numbers come
  from MediaPipe landmarks.
- **Optional, with consent.** The offer screen asks first: `Y` = with Perceptron, `L` = locally
  (nothing uploaded), `N` = skip. Frames are small 384 px JPEGs, held in memory for the request
  and never stored. The API key stays in the local service and never reaches the browser.
- **Fallback.** If Perceptron is offline or errors, the demo is used as recorded (the old
  behavior) and the summary says so.
- **No live latency.** Live performance never calls Perceptron.

**Storage:** grab model `beatdrop.grabModel.v2`, lift thresholds `beatdrop.liftThresholds.v1`
(localStorage).

**Setup:** run `pip install "perceptron>=0.4.0"` (it's in `tools/stems/requirements.txt`), put
`PERCEPTRON_API_KEY=...` in `.env.local` at the repo root (git-ignored), and run
`tools/stems/separation_server.py`, which serves `POST /gesture/segments`.

**Code:**
- `tools/perceptron/gesture_check.py`: Perceptron calls and validation.
- `src/spatial/calibrationStage.ts`: the stage, tested in `calibrationStage.test.ts`.
- `src/spatial/perceptronCalibration.ts`: recording and the client.

The browser console logs what Perceptron confirmed for each demo.

### Keyboard

| Key | Action |
| --- | --- |
| `Space` | Play/pause |
| `1` / `2` / `3` | Mute Drums / Vocals / Bass |
| `Shift+1..3` | Solo |
| `R` | Reset layout |
| `C` | Calibrate gestures (Perceptron AI) · `Shift+C` reset |
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
| Drop | ✅ | Beat-quantized release plus impact (details below) |
| Waveforms, playhead, level meter | real data | Peaks come from the decoded buffers around the actual playhead. Level comes from an analyser after the fader. |
| Loop region on the waveform | real data | Engine loop state plus the actual playback position |
| Beat pulse, grid speed, status bar.beat | real data | Engine transport (`bpm`, `anchorMs`) |
| Build energy / drop shockwave | real data | Engine `perf.build` and `perf.dropAtMs` (timed to when the drop reaches the speakers) |
| Particles, grid, reflections | decorative | Driven by the real level and beat; they don't represent any parameter |

**Loop details.** On the next beat, the engine starts a new buffer source at the exact sample position the old one would have reached, with `loopStart`/`loopEnd` set to the loop region. The switch is seamless and phase-locked.

- **Exiting** also happens on a beat, and the stem rejoins the song where it would have been (slip mode). The other stems keep playing the song.
- **Verified** in headless Chrome: playback stays inside the region, and the stem rejoins the timeline exactly on exit.

**Build details.** A master-bus effect in `AudioEngine.applyBuild`, kept separate from the mix, following the hand's height continuously (raise slowly = slow build, quickly = fast build):

- **High-pass:** two cascaded filters (24 dB/oct), 10 Hz → 1.3 kHz, so the kick and bass really leave. Resonance at the cutoff whistles and strains as it climbs (high enough by then that it never booms).
- **Stereo:** the image narrows to 25% width, so the drop can snap it wide again.
- **Level:** the mix dips to 85%, so the drop lands louder without needing more headroom.
- **Stems:** bass ducked by up to 85% and drums by up to 30%, on separate "perf" gain nodes.
- **Echo wash:** repeats on the lead deck's dotted eighth (3/4 beat) when it has a tempo.
- **Riser:** band-passed noise, 400 Hz → 11 kHz, getting narrower and louder, swaying between the speakers faster as the build rises.
- **Echo wash grows:** its feedback climbs from 0.4 to 0.72 and it brightens (3.5 → 7 kHz), then rings out long after the drop.
- **Rhythmic gate:** from 50% build, the music chops in time with the snare roll (open on each hit, dipping for the second half of the step), up to 90% deep at the top.
- **Snare roll:** from 35% build, a synthesized snare on the lead deck's beat grid that speeds up with the build (beats → 8ths → 16ths → 32nds) and gets louder and brighter. Scheduled sample-accurately 120 ms ahead. No beat grid, no roll: it never invents a tempo.

All of it is `setTargetAtTime` automation (rise fast, fall gently), so there are no clicks. With nothing playing there's no build: pausing, a song ending, or loading a new song releases it, and cancels a drop that hasn't landed (roll and impact included).

**Drop details.** With a beat grid, the engine lands the drop on the lead deck's **next beat**, never more than a beat away. Without one, it lands immediately (it never pretends a grid exists). With at least 120 ms to wait, every playing deck **tape-stops** the moment you let go: the record winds down to a halt (through the scratch voice, while the song keeps running muted underneath, so the drop lands in sync), and the riser and roll cut. With less time, the mix takes a short **breath** of near-silence instead. On the beat:

- the high-pass, stereo width and level snap back, with a **bass punch** (+6 dB low shelf easing off over about a second) and a **stereo bloom** (130% width settling back to normal)
- the stem ducking lifts; the riser and snare roll stop
- the echo wash rings out
- the **impact**: a kick-like boom diving into an 808-style sub tail, saturated so it's audible on laptop speakers, a big snare crack, and a wide stereo crash
- the music **pumps** for two bars (8 beats): it ducks just after each kick and swells back, sidechain-style, easing off

A safety limiter (−1.5 dBFS) and a soft ceiling after it (transparent below 0.9) catch peaks (two loud decks, the impact), so nothing hard-clips.

**On screen:** while building, a shimmer rises along the bottom edge. When you let go, the energy ball falls from your hand (accelerating, with a streak) and lands in the wave exactly on the drop. A tall double crest surges out to both edges from there, the shockwave rings start at the landing point, and the floor keeps churning and swelling hard on the beat for about 4 s (`NeonScene.drawWave`). The whole stage (camera and overlay) shakes for the first ~0.4 s, with a bright flash.

Verified in headless Chrome on a real song: bass −12 dB at full build; roll hits exactly 1, ½, ¼, ⅛ beat apart; the gate dips the music to about a quarter of its level between hits at full build; a ~110 ms breath before the hit, or a ~300 ms tape stop when there's time, landing within 1 ms of the song's timeline; every parameter back to neutral after the drop and pump; peaks never reach full scale.

## Driving the real songs: the Task 1 engine

The spatial page (`/spatial.html`, entry `src/spatial/main.ts`) hosts the shared two-deck engine (`src/audio/AudioEngine.ts`, Task 1). Every gesture changes the songs playing on it.

- **Loading songs:** `/` opens the song search (the library in `mp3/`). Enter loads deck A and Shift+Enter loads deck B. A song you load starts playing by itself if nothing else is.
- **Holograms per deck:** each deck's stems are fader bars standing on the bottom edge of the screen, side by side, in the decks screen's order (Vocals, Drums, Bass, Inst) and its colours (`STEM_COLORS` from `src/decks/theme.ts`). Deck A is on the left and deck B on the right. A full mix (a song that hasn't been split) is one bar in its deck's colour, labelled with the song title.
  - **What a bar shows:** it fills from the bottom to its volume, and the waveform plays inside the filled part. A faint track shows the full range.
  - **The only bar gesture for now:** **pinch at the top of a bar's fill** (thumb and index together, e.g. sideways like gripping the edge; a little above or below the line is fine, a pinch deep inside the bar does nothing) and slide up or down, with either hand. You can grip and pull in one motion: the bar is chosen where the pinch started, and the slide counts from there, even while the pinch is still arming (0.15 s). The top follows your hand 1:1 from where you grabbed it, gliding slightly behind (60 ms) so it moves smoothly instead of jittering. No volume text pops up: the fill and its handle show the level, and Monitor 1's fader moves with it.
    - Over a bar a **pinch wins** over the lift pose and the open palm: reaching down to the bars with your fingers pointing down never starts a build or a scratch.
    - Fists don't grab bars (a fist is tempo, below).
- **Fist = tempo** (see Tempo below). Fists don't do anything else on the bars.
  - **Removed from bars for now** (pinch gestures to come): tap to mute, twist to filter, loop and filter caps, two-hand stretch, blend/isolate, and clip pull-out. The controller code is still there for free-floating stems and clips.
- **Records (scratch):** each loaded deck has a record above where its bars go, in the deck's colour, turning clockwise at 33⅓ rpm like the decks screen's records with the real playback position. The record is only a picture: touching, tapping or pinching it does nothing.
  - **To scratch:** hold an **open palm** anywhere (fingers up or sideways, not hanging down), **facing the camera and still**, for about 0.3 s, then **turn it like a steering wheel**. Moving restarts the hold, and a palm within 1.2 s of a lift pose or a drop never arms, so reaching for a drink or opening the hand to drop doesn't scratch. Where your hand is doesn't matter beyond the side: the left half of the screen scratches deck A, the right half deck B.
    - **What it follows:** whichever arc the hand makes each frame, with no double counting:
      - **The palm turning** (the wheel turning in your hand), from the hand's in-plane angle `HandState.roll`.
      - **The hand swinging around the wheel's centre,** just below where the hand started (`SCRATCH_VIRTUAL_RADIUS`). Plain side-to-side counts as this.
      - On a real wheel motion both happen by the same angle. The record turns **2.5× as far as your hand** (`SCRATCH_GAIN`), so a small twist of about 35° does what a quarter turn would.
    - **Mapping:** clockwise (as you see it) = forward. One full turn = one revolution at 33⅓ rpm (1.8 s of audio).
    - **How the audio follows the hand** (`src/audio/scratchVoice.ts`, an AudioWorklet with its own read head, so it really plays backwards):
      - The hand's speed comes from successive positions, extrapolated for up to 60 ms between camera frames.
      - **Response curve:** tracking jitter is ignored (dead zone 0.06×). Small movements stay subtle (power curve, exponent 1.35). Fast ones are soft-clamped at 3×.
      - **Weight:** the record's speed follows that curve through a little mass (18 ms), so pitch glides instead of jumping. A gentle pull keeps it near the hand's position; if the hand outruns the 3× limit, the record slips under it instead of racing to catch up.
      - **Catch and release:** grabbing a playing record brakes it from full speed. Letting go spins it back up like a turntable motor (70 ms) while the scratch fades and the live song fades back in.
      - **Sound:** level follows speed like a cartridge (a still record is silent). A speed-tracking low-pass prevents aliasing on fast scratches. Cubic interpolation.
    - **Both screens follow the scratch:** while a hand scratches a deck, `AudioEngine.getPositionSec()` reports the scratch position (what you hear), and the song keeps running underneath. So the decks screen's record (`src/decks/components/Vinyl.tsx`, which steers its spin animation from that position) and its waveform playhead turn with your hand, then carry on in time after you let go.
    - **Excluded:** fingers hanging down (the lift pose).
  - **To let go:** close your hand, or lose tracking.
  - **Stays in time:** it's slip mode. The song keeps running underneath, so it carries on exactly where it would have been. Verified in headless Chrome: 0.00 s off.
  - **Engine side:** `SCRATCH_START` / `SCRATCH_MOVE` / `SCRATCH_END` (Task 1 additions), played through the AudioWorklet scratch voice. `getPositionSec()` reports the voice's real record position while scratching.
- **Pinch** (held for about 0.15 s without closing into a fist) grabs what's under it:
  - **a bar (anywhere along it):** volume
  - **anywhere else:** nothing

  It keeps that target until the pinch opens.
- **Crossfader:** a small A–B fader at the top centre, between the records. Hold **one or two fingers up** (☝ or ✌) for about 0.3 s anywhere, then slide sideways. It's strict: the index has to be straight, point clearly up (within ~50° of vertical), have its tip well above the wrist (1.2 palm lengths), and stick out clearly further than the ring and pinky. So a claw (fingers hooked forward to grip a bar), a pinch, or a hand at your chin with a finger along your face never crossfade.
  - **The pose (forgiving):** the index is extended and roughly pointing up, the middle finger can be either way, and the ring and little fingers are mostly curled.
  - **Movement:** relative to where it started; 0.5 view-height of travel = A to B. Lowering the fingers lets go. It's the same crossfader as the decks screen's, through `SET_CROSSFADER`.
- **Tempo:** close a **fist out to your side** (left = deck A, right = deck B) and move it up (faster) or down (slower). The whole song (every stem) stretches together.
  - **Out to the side:** at least 2.5 of your apparent palm sizes from the middle of the screen (`tempoSideDistance`), so it adapts to distance. Up close it's near the screen edge; from across the room it's just beside you. It also always starts **beyond the outermost fader bar** (`tempoSideMin`): the bars' zone and the tempo zone meet at the bar's outer edge and never overlap. In front of your body a fist does nothing. This assumes you're roughly centred in the camera.
  - **Movement:** the deck's tempo is a line on that screen edge, **always where Monitor 1's tempo fader cap is**: the same scale (2× at the top of the track, ×1.00 in the middle with the same snap, ½× at the bottom, evenly spaced in octaves; track = view y 0.12–0.88, `tempoLineY`). Closing the fist doesn't move it; the fist then moves the line from there, up by as much as the fist goes up (1:1 at arm's length, more from across the room where your reach looks smaller, `tempoReachGain`). Opening the hand keeps the tempo. A quick fist (under 0.15 s, not moving) changes nothing.
  - **Elsewhere:** a fist away from the edges never touches the tempo, and pinching never does.
  - **Display:** a thin deck-coloured line on the very screen edge that **thickens on each beat**, with `+3.2%` and `132.1 BPM` beside it while a fist holds it. A hand out to the side (no fist) shows it dimly with `FIST ↕ TEMPO`. Monitor 1's tempo faders (and E/D, I/K) still work as before, and the line follows them.
  - **Engine side:** it's the decks screen's tempo (`SET_PLAYBACK_RATE`), so her tempo fader moves too. It's turntable-style, so pitch follows.
- **Stem bars are back, smaller and dimmer** (`SHOW_STEM_BARS` in `src/ar/decks.ts`): each deck's four bars stand close together near the middle of the screen, A just left of centre and B just right, mirrored with a small gap between, so they stay clear of the tempo lines at the edges, drawn at 80% opacity until a hand is on or near one (`BAR_IDLE_ALPHA` in `src/ar/WaveformRenderer.ts`). Records and crossfader keep their places. Hand gestures for them are next.
- **No mute on this screen for now:** tapping does nothing and the 1–9 keys are gone. Stems muted on the decks screen still show MUTED.
- **No wobble:** fader bars ignore the hand-drift effect and don't grow, squeeze or shiver. They react with glow and fill only.
- **Narrow frames:** on portrait or narrow camera frames, bars, records and spacing shrink sideways so both decks fit.
- **Open palm detection:** `HandState.palm` in perception (fingers extended, with hysteresis). The lift pose and a fist never count as a palm.
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
  - build/drop: letting go drops exactly once; mixer restored; open while moving down; pulling down alone never drops; slow-lower cancels; not enough build; tracking loss; cooldown; no drop while dragging; drop pending; independent hands
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
