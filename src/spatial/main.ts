/// <reference types="vite/client" />
import { syncClips } from '../ar/clips';
import { DeckControlsRenderer } from '../ar/DeckControlsRenderer';
import { crossfadeZone, deckPositions, syncDeckStems, syncPlatters } from '../ar/decks';
import { DriftField } from '../ar/DriftField';
import { stemView, type HoloObject } from '../ar/HoloObject';
import { InteractionController } from '../ar/InteractionController';
import { NeonScene } from '../ar/NeonScene';
import { WaveformRenderer } from '../ar/WaveformRenderer';
import { beatAt, wallNow, type AudioStateSource } from '../audio/AudioCommands';
import { createStemAudioBridge } from '../bridge/stemAudioBridge';
import { Task1Adapter } from '../bridge/task1Adapter';
import { createTask1Waveforms } from '../bridge/task1Waveforms';
import { drawHandOverlay } from '../debug/handOverlay';
import { InteractionRecorder } from '../debug/recorder';
import { searchLibrary } from '../library/api';
import { DECK_IDS, type AudioEngineState, type DeckId } from '../shared/types';
import { createSearchBar } from '../ui/SearchBar';
import { EngineHandle } from './engineHandle';
import { drawCalibrationCard } from './calibrationCard';
import { CalibrationStage } from './calibrationStage';
import {
  GrabClassifier,
  PerceptionPipeline,
  type GrabGesture,
  type GrabModel,
  type HandState,
  type PerceptionFrame,
  type Point2,
} from '../perception';

/** 'grab' = closed fist (pinch optional via grabIncludesPinch), aimed at the fingertips. */
const GRAB_GESTURE: GrabGesture = 'grab';

const stage = document.getElementById('stage') as HTMLDivElement;
const video = document.getElementById('webcam') as HTMLVideoElement;
const canvas = document.getElementById('overlay') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;
const startButton = document.getElementById('start') as HTMLButtonElement;
const fullscreenButton = document.getElementById('fullscreen') as HTMLButtonElement;

/** Full screen for the camera view (button, or F); the label follows the actual state. */
function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen().catch(() => undefined);
}
fullscreenButton.addEventListener('click', (e) => {
  toggleFullscreen();
  fullscreenButton.blur(); // so Space / keys keep going to the page
  e.stopPropagation();
});
document.addEventListener('fullscreenchange', () => {
  fullscreenButton.textContent = document.fullscreenElement ? '⛶ EXIT FULLSCREEN' : '⛶ FULLSCREEN';
});
const hint = document.getElementById('hint') as HTMLDivElement;
const status = document.getElementById('status') as HTMLDivElement;
const searchBox = document.getElementById('search') as HTMLDivElement;
const ctx = canvas.getContext('2d')!;

function fitStage(): void {
  if (!video.videoWidth) return;
  // Letterbox the stage to the video's aspect so overlay coords line up 1:1.
  const aspect = video.videoWidth / video.videoHeight;
  const w = Math.min(window.innerWidth, window.innerHeight * aspect);
  const h = w / aspect;
  stage.style.width = `${w}px`;
  stage.style.height = `${h}px`;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
}

function describe(hand: HandState | undefined): string {
  if (!hand) return '—';
  const status = hand.tracked ? '' : ' (lost)';
  const ok = (b: boolean | undefined) => (b ? '✓' : '✗');
  // Live gesture checks, for tuning. Scratch = open palm ✓ (needs > 1.00) with fingers not hanging down.
  const open = hand.palm ? 2 - hand.palm.ratio : 0;
  return (
    `palm ${open.toFixed(2)}${ok(hand.palm?.active)}  fingers-down ${ok(hand.fingersDown)}  ` +
    `pinch ${hand.pinch.ratio.toFixed(2)}${ok(hand.pinch.active)}  fingers-up ${ok(hand.twoUp?.active)}  ` +
    `lift ${ok(hand.lift?.active)}  fist ${ok(hand.grip.active)}${status}`
  );
}

/**
 * Copy authoritative engine state into each object's read-only mirror. When
 * nobody is stretching it, the visual stretch follows the engine's FX value,
 * so changes made elsewhere (e.g. the DJ monitor) show up here too.
 */
function syncFromEngine(objects: HoloObject[], engine: AudioStateSource, interaction: InteractionController): void {
  for (const obj of objects) {
    const s = engine.stems.get(obj.id);
    if (!s) continue;
    obj.audio = stemView(s);
    if (!obj.stretch) obj.stretchAmount = s.fx;
  }
  interaction.perfView = { dropPending: engine.perf.dropPending, crossfader: engine.perf.crossfader, tempo: engine.perf.tempo };
}

/** Compact musical status: each deck's song and tempo, plus the lead deck's bar.beat lights. */
function statusText(engine: AudioStateSource, state: AudioEngineState): string {
  const decks = DECK_IDS.map((id) => {
    const d = state.decks[id];
    if (d.status === 'loading') return `${id} loading…`;
    if (d.status === 'error') return `${id} ⚠ ${d.error ?? 'error'}`;
    if (d.status !== 'ready' || !d.track) return `${id} —`;
    const bpm = d.bpm ? `${Math.round(d.bpm * d.playbackRate)}${d.bpmSource === 'estimated' ? '~' : ''} BPM` : 'no BPM';
    return `${id} ${d.playing ? '▶' : '❚❚'} ${truncate(d.track.title, 18)} · ${bpm}`;
  });
  const t = engine.transport;
  const beat = beatAt(t);
  let pos = '';
  if (beat !== null) {
    const inBar = ((Math.floor(beat) % t.beatsPerBar) + t.beatsPerBar) % t.beatsPerBar;
    pos = '   ' + Array.from({ length: t.beatsPerBar }, (_, i) => (i === inBar ? '●' : '○')).join('');
  }
  return decks.join('   ') + pos;
}

/** Where the audio lives, and anything the performer needs to do about it. */
function connectionText(engine: EngineHandle, justSwitched: boolean): string {
  if (engine.mode === 'standalone') return 'STANDALONE · NO DECKS SCREEN   ';
  if (!engine.connected) return '⚠ DECKS SCREEN CLOSED   ';
  if (engine.audioState === 'suspended') return '🔇 CLICK THE DECKS SCREEN ONCE TO ENABLE AUDIO   ';
  return justSwitched ? '⇄ CONNECTED TO DECKS SCREEN   ' : '⇄ DECKS   ';
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function cameraErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError') return 'Camera access was blocked. Allow the camera for this site and reload.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No usable camera found. Connect a webcam and reload.';
  if (name === 'NotReadableError') return 'The camera is in use by another app. Close it and reload.';
  return `Error: ${err instanceof Error ? err.message : String(err)}`;
}

/** Big centered instruction banner (calibration). */
function drawBanner(title: string, detail: string): void {
  const u = canvas.height / 720;
  ctx.save();
  ctx.fillStyle = 'rgba(8, 10, 20, 0.72)';
  ctx.fillRect(0, canvas.height * 0.36, canvas.width, canvas.height * 0.26);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 ${u * 44}px ui-monospace, Menlo, monospace`;
  ctx.fillText(title, canvas.width / 2, canvas.height * 0.44);
  ctx.font = `500 ${u * 17}px ui-monospace, Menlo, monospace`;
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  detail.split('\n').forEach((line, i) => ctx.fillText(line, canvas.width / 2, canvas.height * 0.52 + i * u * 26));
  ctx.restore();
}

/** Red "REC" dot in the top-right corner while the debug recorder runs. */
function drawRecIndicator(seconds: number, label?: string): void {
  const u = canvas.height / 720;
  ctx.save();
  ctx.fillStyle = '#ff3b3b';
  ctx.beginPath();
  ctx.arc(canvas.width - u * 162, u * 22, u * 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = `600 ${u * 13}px ui-monospace, Menlo, monospace`;
  ctx.textBaseline = 'middle';
  ctx.fillText(`REC ${seconds.toFixed(0)}s${label ? ` · ${label.toUpperCase()}` : ''}`, canvas.width - u * 150, u * 22);
  ctx.restore();
}

/** v2: fist-only. Older models were trained with pincers too, so they're ignored. */
const MODEL_KEY = 'beatdrop.grabModel.v2';
/** Display easing toward the tracked position (1/s): ~25 ms lag, removes camera-rate stepping. */
const DISPLAY_RATE = 40;

function loadGrabModel(): GrabClassifier | null {
  try {
    const raw = localStorage.getItem(MODEL_KEY);
    if (!raw) return null;
    const c = GrabClassifier.fromModel(JSON.parse(raw) as GrabModel);
    return c.ready ? c : null;
  } catch {
    return null;
  }
}

function saveGrabModel(c: GrabClassifier): void {
  try {
    localStorage.setItem(MODEL_KEY, JSON.stringify(c.toModel()));
  } catch {
    /* storage unavailable: the model still works for this session */
  }
}

/** Personal build/drop lift thresholds from gesture calibration (calibrationStage.ts). */
const LIFT_KEY = 'beatdrop.liftThresholds.v1';

function loadLift(): { on: number; off: number } | null {
  try {
    const t = JSON.parse(localStorage.getItem(LIFT_KEY) ?? 'null') as { on?: unknown; off?: unknown } | null;
    return t && typeof t.on === 'number' && typeof t.off === 'number' && t.on < t.off ? { on: t.on, off: t.off } : null;
  } catch {
    return null;
  }
}

function store(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: settings last for this session */
  }
}

/** The latest error from the frame or draw loop, shown in the status line so it can be reported. */
let lastError: { text: string; at: number } | null = null;
const reported = new Set<string>();
function reportError(stage: string, err: unknown): void {
  const text = `${stage}: ${err instanceof Error ? err.message : String(err)}`;
  lastError = { text, at: performance.now() };
  if (reported.has(text)) return; // log each distinct error once
  reported.add(text);
  console.error(`[spatial] ${stage}`, err);
}

async function main(): Promise<void> {
  hud.textContent = 'Starting camera + loading hand model + preparing audio…';
  // The shared two-deck engine (Task 1), owned by the decks screen (Monitor 1)
  // and mirrored here; standalone if no decks screen is open. Gestures reach it
  // through the adapter, so every hand interaction changes the actual songs.
  const [engine, pipeline] = await Promise.all([EngineHandle.create(), PerceptionPipeline.create(video)]);
  const audio = new Task1Adapter(engine);
  let switchedAt = -Infinity;
  engine.onSwitch = () => (switchedAt = performance.now());
  fitStage();
  window.addEventListener('resize', fitStage);
  window.addEventListener('pagehide', () => {
    audio.close();
    pipeline.dispose();
    engine.close();
  });

  const aspect0 = video.videoWidth / video.videoHeight;
  // Holograms appear as songs load (one per stem, or one for a full mix).
  const stems: HoloObject[] = [];
  const titleOf = (deck: DeckId) => audio.state.decks[deck].track?.title ?? null;

  // Song search: "/" opens it; Enter loads deck A, Shift+Enter deck B.
  let autoplay: DeckId | null = null;
  const search = createSearchBar({
    search: (q, signal) => searchLibrary(q, signal),
    onSelect: (track, deck) => {
      const other = audio.state.decks[deck === 'A' ? 'B' : 'A'];
      autoplay = other.playing ? null : deck; // start it if nothing else is playing
      void engine.dispatch({ type: 'LOAD_TRACK', deck, track });
      closeSearch();
    },
    placeholder: 'Search songs…  Enter → deck A · Shift+Enter → deck B',
    minChars: 0,
  });
  searchBox.appendChild(search.element);
  const openSearch = () => {
    searchBox.hidden = false;
    search.focus();
  };
  const closeSearch = () => {
    searchBox.hidden = true;
    (document.activeElement as HTMLElement | null)?.blur();
  };
  audio.subscribe(() => {
    if (autoplay && audio.state.decks[autoplay].status === 'ready') {
      void engine.dispatch({ type: 'PLAY', deck: autoplay });
      autoplay = null;
    }
  });

  // spatial.html?recalibrate: forget saved calibration and offer it again at Start session.
  const params = new URLSearchParams(location.search);
  if (params.has('recalibrate')) {
    for (const key of [MODEL_KEY, LIFT_KEY]) store(key, null);
    params.delete('recalibrate');
    history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}${location.hash}`);
  }
  pipeline.gestures.classifier = loadGrabModel();
  let calibDone: { at: number; text: string } | null = null;
  const defaultLift = pipeline.gestures.liftThresholds;
  const savedLift = loadLift();
  if (savedLift) pipeline.gestures.setLiftThresholds(savedLift);

  // Gesture calibration stage (press C, or offered at the first session start): the
  // user demonstrates each gesture and Perceptron AI confirms when it was performed.
  let searchAfterCalibration = false;
  const calibration = new CalibrationStage({
    video,
    gestures: pipeline.gestures,
    saveGrab: saveGrabModel,
    saveLift: (t) => store(LIFT_KEY, JSON.stringify(t)),
    onClose: () => {
      if (searchAfterCalibration && !DECK_IDS.some((d) => audio.state.decks[d].status !== 'empty')) openSearch();
      searchAfterCalibration = false;
    },
  });

  const recorder = new InteractionRecorder({ aspect: aspect0, gesture: GRAB_GESTURE, userAgent: navigator.userAgent });
  const interaction = new InteractionController(
    stems,
    aspect0,
    recorder.tap(createStemAudioBridge(audio)),
    GRAB_GESTURE,
  );
  syncFromEngine(stems, audio, interaction);
  // Dev only: poke the session from the console (e.g. __beatdrop.engine.dispatch({ type: 'DROP' })).
  if (import.meta.env.DEV) Object.assign(window, { __beatdrop: { engine, audio, interaction, stems, calibration } });
  const drift = new DriftField(aspect0, GRAB_GESTURE);
  const waveSource = createTask1Waveforms(engine, audio);
  const waveforms = new WaveformRenderer(waveSource);
  const neon = new NeonScene();
  const deckControls = new DeckControlsRenderer();
  interaction.crossfadeZone = crossfadeZone(aspect0);

  // Browsers only allow audio to start from a user gesture.
  startButton.hidden = false;
  startButton.addEventListener('click', () => {
    engine.resume();
    startButton.hidden = true;
    hint.hidden = true;
    // Every session starts with the gesture calibration (Perceptron AI); N skips it.
    searchAfterCalibration = true;
    void calibration.open();
  });

  const togglePlay = (deck: DeckId) => {
    if (audio.state.decks[deck].status === 'ready') void engine.dispatch({ type: 'TOGGLE_PLAY', deck });
  };

  window.addEventListener('keydown', (e) => {
    // Typing in the search box: only Escape is ours.
    if (e.target instanceof HTMLInputElement) {
      if (e.key === 'Escape') closeSearch();
      return;
    }
    const key = e.key.toLowerCase();
    if (calibration.handleKey(key, performance.now())) {
      e.preventDefault();
      return;
    }
    if (key === '/') {
      e.preventDefault();
      engine.resume();
      startButton.hidden = true;
      hint.hidden = true;
      openSearch();
      return;
    }
    if (key === 'a' && !e.repeat) togglePlay('A');
    if (key === 'b' && !e.repeat) togglePlay('B');
    if (key === 'arrowleft' || key === 'arrowright') {
      const xf = audio.state.mixer.crossfader + (key === 'arrowleft' ? -0.1 : 0.1);
      void engine.dispatch({ type: 'SET_CROSSFADER', value: Math.max(-1, Math.min(1, xf)) });
    }
    if (key === 'h') hud.classList.toggle('hidden');
    if (key === 'c' && !e.repeat) {
      if (e.shiftKey) {
        pipeline.gestures.clearCalibration();
        try {
          localStorage.removeItem(MODEL_KEY);
        } catch {
          /* ignore */
        }
        pipeline.gestures.setLiftThresholds(defaultLift);
        store(LIFT_KEY, null);
        calibDone = { at: performance.now(), text: 'Calibration cleared: default fist grip and lift. Press C to calibrate.' };
      } else {
        void calibration.open();
      }
    }
    if (key === 'd') recorder.toggle();
    // While recording, hold O / P / F to label frames open / pinch / fist for tuning.
    if (!e.repeat && recorder.recording) {
      if (key === 'o') recorder.label = 'open';
      if (key === 'p') recorder.label = 'pinch';
      if (key === 'f') recorder.label = 'fist';
    }
    if (key === 'f' && !e.repeat && !recorder.recording) toggleFullscreen();
    if (key === 'r') {
      const ids = stems.filter((o) => !o.clipOf).map((o) => o.id);
      interaction.resetLayout(deckPositions(video.videoWidth / video.videoHeight, ids));
    }
    if (key === ' ') {
      e.preventDefault();
      startButton.hidden = true;
      hint.hidden = true;
      engine.resume();
      // Pause everything if anything plays, otherwise play every loaded deck.
      const ready = DECK_IDS.filter((d) => audio.state.decks[d].status === 'ready');
      const anyPlaying = ready.some((d) => audio.state.decks[d].playing);
      for (const deck of ready) void engine.dispatch({ type: anyPlaying ? 'PAUSE' : 'PLAY', deck });
    }

  });

  window.addEventListener('keyup', (e) => {
    if (['o', 'p', 'f'].includes(e.key.toLowerCase())) recorder.label = undefined;
  });

  let frames = 0;
  let fps = 0;
  let fpsWindowStart = performance.now();

  // Tracking runs at camera rate (~24-30 fps); drawing runs at display rate.
  // Between camera frames, each stem glides toward its real position, so
  // motion looks continuous instead of stepping with the camera.
  let lastFrame: PerceptionFrame | null = null;
  let banner: { title: string; detail: string } | null = null;
  const shown = new Map<string, Point2>();
  let lastDraw = performance.now();
  const draw = (now: number) => {
    requestAnimationFrame(draw);
    try {
      drawFrame(now);
    } catch (err) {
      reportError('draw', err);
    }
  };
  const drawFrame = (now: number) => {
    const dt = Math.min(0.1, (now - lastDraw) / 1000);
    lastDraw = now;
    const k = 1 - Math.exp(-DISPLAY_RATE * dt);
    const display = interaction.objects.map((obj) => {
      const prev = shown.get(obj.id) ?? obj.position;
      const p = { x: prev.x + (obj.position.x - prev.x) * k, y: prev.y + (obj.position.y - prev.y) * k };
      shown.set(obj.id, p);
      return { ...obj, position: p };
    });
    const pair = interaction.blendPair;
    const find = (o: HoloObject) => display.find((d) => d.id === o.id) ?? o;
    const scene = {
      t: now / 1000,
      dt,
      beat: waveSource.beat?.() ?? null,
      level: (id: string) => waveSource.level?.(id) ?? 0,
      blend: pair ? { a: find(pair[0]), b: find(pair[1]), isolation: interaction.isolation } : null,
      nowMs: wallNow(),
      build: interaction.build,
      perf: audio.perf,
    };
    neon.update(display, scene, canvas.width, canvas.height);
    // The drop hits: the whole stage (camera and overlay together) shakes for a moment.
    const shake = Math.max(0, neon.impact - 0.55) / 0.45;
    const jolt = (px: number) => `${((Math.random() * 2 - 1) * px * shake).toFixed(1)}px`;
    stage.style.translate = shake > 0 ? `${jolt(16)} ${jolt(11)}` : '';
    waveforms.pulse = neon.pulse;
    waveforms.energy = neon.energy;
    waveforms.impact = neon.impact;
    const error = lastError && now - lastError.at < 6000 ? `⚠ ${lastError.text}   ` : '';
    const line = error + connectionText(engine, now - switchedAt < 4000) + statusText(audio, audio.state);
    if (status.textContent !== line) status.textContent = line;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    neon.drawBackground(ctx);
    waveforms.render(ctx, display, now, { backdrop: video });
    deckControls.render(
      ctx,
      interaction.platters,
      interaction.crossfadeZone,
      interaction.crossfadeValue ?? audio.perf.crossfader,
      (d) => engine.getPositionSec(d),
      interaction.tempoStrips,
      (d) => {
        const s = audio.state.decks[d];
        const beats = s.bpm && s.playing ? ((engine.getPositionSec(d) - s.firstBeatSec) * s.bpm) / 60 : null;
        return { rate: s.playbackRate, bpm: s.bpm, beatPhase: beats === null ? null : beats - Math.floor(beats) };
      },
    );
    neon.drawForeground(ctx, scene);
    if (lastFrame) drawHandOverlay(ctx, lastFrame, GRAB_GESTURE, interaction.handModes);
    const card = calibration.view(now);
    if (card) drawCalibrationCard(ctx, card, now);
    else if (banner) drawBanner(banner.title, banner.detail);
    if (recorder.recording) drawRecIndicator(recorder.seconds, recorder.label);
  };
  requestAnimationFrame(draw);

  pipeline.onError = (err) => reportError('tracking', err);
  pipeline.onFrame((frame) => {
    const aspect = video.videoWidth / video.videoHeight;
    syncDeckStems(audio, interaction, aspect, titleOf);
    syncPlatters(audio, interaction, aspect);
    syncClips(audio, interaction);
    syncFromEngine(stems, audio, interaction);
    interaction.setAspect(aspect);
    // While calibrating, the demonstrated gestures (open palm, fist, lift) must not scratch,
    // grab or build: the controls see no hands, so anything held is released.
    const controlFrame = calibration.active ? { ...frame, hands: [] } : frame;
    interaction.update(controlFrame);
    drift.setAspect(aspect);
    drift.step(interaction.objects, controlFrame);

    lastFrame = frame;
    calibration.update(frame);
    // The calibration card is drawn from calibration.view(); this banner is for notices only.
    if (calibDone && frame.timestamp - calibDone.at < 2500) {
      banner = { title: calibDone.text, detail: '' };
    } else {
      banner = null;
    }
    recorder.capture(frame, stems);

    frames++;
    if (frame.timestamp - fpsWindowStart >= 1000) {
      fps = (frames * 1000) / (frame.timestamp - fpsWindowStart);
      frames = 0;
      fpsWindowStart = frame.timestamp;
    }
    if (hud.classList.contains('hidden')) return;
    const byId = (id: string) => frame.hands.find((h) => h.id === id);
    const stemLines = stems.map((obj) => {
      const s = audio.stems.get(obj.id);
      const owner = obj.levelHand ? `level:${obj.levelHand}` : obj.holders.length ? `held:${obj.holders.join('+')}` : 'free';
      const mix = s
        ? `vol ${s.volume.toFixed(2)}  fx ${s.fx.toFixed(2)}  filt ${s.filter.toFixed(2)}${s.loop ? `  loop ${s.loop.beats}${s.loop.engaged ? '' : '…'}` : ''}${s.muted ? '  MUTE' : ''}${s.solo ? '  SOLO' : ''}`
        : '';
      return `${obj.label.padEnd(18)}: ${owner.padEnd(14)}${mix}`;
    });
    const modes = [...interaction.handModes].map(([h, m]) => `${h}: ${m}`).join('   ') || 'no hands';
    const perf = audio.perf;
    const perfLine = `build ${perf.build.toFixed(2)}${perf.dropPending ? '  DROP PENDING' : ''}  drops ${perf.drops}`;
    hud.textContent =
      `tracking ${fps.toFixed(0)} fps   grab: ${pipeline.gestures.classifier ? 'calibrated' : 'default (press C to calibrate)'}   engine: ${engine.mode}${engine.connected ? '' : ' (lost)'}   audio: ${engine.audioState}\n` +
      `[/] search  [space] play/pause  [A]/[B] deck  [←/→] crossfader  [R] reset layout  [C] calibrate gestures (Perceptron)  [⇧C] reset  [D] record  [H] hide\n` +
      `modes  ${modes}\n${perfLine}\n` +
      `Left : ${describe(byId('Left'))}\n` +
      `Right: ${describe(byId('Right'))}\n` +
      stemLines.join('\n');
  });

  pipeline.start();
}

main().catch((err) => {
  console.error(err);
  hud.classList.remove('hidden');
  hud.textContent = cameraErrorMessage(err);
});
