/// <reference types="vite/client" />
import { syncClips } from '../ar/clips';
import { deckPositions, syncDeckStems } from '../ar/decks';
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
  const { phase } = hand[GRAB_GESTURE];
  const status = hand.tracked ? '' : ' (lost)';
  return `${phase.padEnd(5)} grip ${hand.grip.ratio.toFixed(2)}  pinch ${hand.pinch.ratio.toFixed(2)}${status}`;
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
  interaction.perfView = { dropPending: engine.perf.dropPending };
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

/**
 * Grab calibration (press C): a few seconds of open hands, then a few seconds
 * of grab poses (pincer, fist, wrap-around). The perception layer learns
 * the user's own poses from these samples.
 */
interface CalibrationStep {
  label: 0 | 1 | null;
  ms: number;
  title: string;
  detail: string;
}
const CALIBRATION: CalibrationStep[] = [
  { label: null, ms: 1500, title: 'Get ready: OPEN hands', detail: 'Next: hands open or relaxed — anything that is NOT a grab' },
  { label: 0, ms: 5000, title: 'OPEN', detail: 'Relaxed, spread, half-curled, pointing, pinching. Move around. Both hands.' },
  { label: null, ms: 1500, title: 'Get ready: FIST', detail: 'Next: close your hand into a fist' },
  { label: 1, ms: 6000, title: 'FIST', detail: 'Close your hand into a fist (loose or tight). Move around. Both hands.' },
];

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

  pipeline.gestures.classifier = loadGrabModel();
  let calib: { step: number; stepStart: number } | null = null;
  let calibDone: { at: number; text: string } | null = null;

  const recorder = new InteractionRecorder({ aspect: aspect0, gesture: GRAB_GESTURE, userAgent: navigator.userAgent });
  const interaction = new InteractionController(
    stems,
    aspect0,
    recorder.tap(createStemAudioBridge(audio)),
    GRAB_GESTURE,
  );
  syncFromEngine(stems, audio, interaction);
  // Dev only: poke the session from the console (e.g. __beatdrop.engine.dispatch({ type: 'DROP' })).
  if (import.meta.env.DEV) Object.assign(window, { __beatdrop: { engine, audio, interaction, stems } });
  const drift = new DriftField(aspect0, GRAB_GESTURE);
  const waveSource = createTask1Waveforms(engine, audio);
  const waveforms = new WaveformRenderer(waveSource);
  const neon = new NeonScene();

  // Browsers only allow audio to start from a user gesture.
  startButton.hidden = false;
  startButton.addEventListener('click', () => {
    engine.resume();
    startButton.hidden = true;
    hint.hidden = true;
    if (!DECK_IDS.some((d) => audio.state.decks[d].status !== 'empty')) openSearch();
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
        calibDone = { at: performance.now(), text: 'Calibration cleared: using default fist grip' };
      } else {
        calib = { step: 0, stepStart: performance.now() };
        pipeline.gestures.collect(null);
      }
    }
    if (key === 'd') recorder.toggle();
    // While recording, hold O / P / F to label frames open / pinch / fist for tuning.
    if (!e.repeat && recorder.recording) {
      if (key === 'o') recorder.label = 'open';
      if (key === 'p') recorder.label = 'pinch';
      if (key === 'f') recorder.label = 'fist';
    }
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
    // 1-9 mute holograms in order (e.code so Shift doesn't turn "1" into "!").
    const digit = /^Digit([1-9])$/.exec(e.code);
    const obj = digit ? stems[Number(digit[1]) - 1] : undefined;
    if (obj) audio.dispatch({ type: 'setMute', stemId: obj.id, value: !audio.stems.get(obj.id)?.muted });
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
    waveforms.pulse = neon.pulse;
    waveforms.energy = neon.energy;
    waveforms.impact = neon.impact;
    const line = connectionText(engine, now - switchedAt < 4000) + statusText(audio, audio.state);
    if (status.textContent !== line) status.textContent = line;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    neon.drawBackground(ctx);
    waveforms.render(ctx, display, now, { backdrop: video });
    neon.drawForeground(ctx, scene);
    if (lastFrame) drawHandOverlay(ctx, lastFrame, GRAB_GESTURE, interaction.handModes);
    if (banner) drawBanner(banner.title, banner.detail);
    if (recorder.recording) drawRecIndicator(recorder.seconds, recorder.label);
  };
  requestAnimationFrame(draw);

  pipeline.onFrame((frame) => {
    const aspect = video.videoWidth / video.videoHeight;
    syncDeckStems(audio, interaction, aspect, titleOf);
    syncClips(audio, interaction);
    syncFromEngine(stems, audio, interaction);
    interaction.setAspect(aspect);
    interaction.update(frame);
    drift.setAspect(aspect);
    drift.step(interaction.objects, frame);

    lastFrame = frame;
    if (calib) {
      const step = CALIBRATION[calib.step];
      if (frame.timestamp - calib.stepStart >= step.ms) {
        calib.step++;
        calib.stepStart = frame.timestamp;
        if (calib.step >= CALIBRATION.length) {
          const c = pipeline.gestures.finishCalibration();
          const { open, grab } = c.counts;
          calibDone = c.ready
            ? { at: frame.timestamp, text: `Calibrated ✓  (${open} open / ${grab} grab samples)` }
            : { at: frame.timestamp, text: 'Not enough hand samples: press C to try again' };
          if (c.ready) saveGrabModel(c);
          calib = null;
        } else {
          pipeline.gestures.collect(CALIBRATION[calib.step].label);
        }
      }
    }
    if (calib) {
      const step = CALIBRATION[calib.step];
      const left = Math.max(0, step.ms - (frame.timestamp - calib.stepStart)) / 1000;
      const n = pipeline.gestures.sampleCounts;
      banner = { title: step.title, detail: `${step.detail}\n${left.toFixed(1)}s   ·   ${n.open} open / ${n.grab} grab` };
    } else if (calibDone && frame.timestamp - calibDone.at < 2500) {
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
      `tracking ${fps.toFixed(0)} fps   grab: ${pipeline.gestures.classifier ? 'calibrated' : 'default (press C)'}   engine: ${engine.mode}${engine.connected ? '' : ' (lost)'}   audio: ${engine.audioState}\n` +
      `[/] search  [space] play/pause  [A]/[B] deck  [←/→] crossfader  [1-9] mute  [R] reset layout  [C] calibrate grab  [⇧C] clear  [D] record  [H] hide\n` +
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
