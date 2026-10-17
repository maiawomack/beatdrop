import { DriftField } from './ar/DriftField';
import { createHoloObject } from './ar/HoloObject';
import { InteractionController } from './ar/InteractionController';
import { DEFAULT_STEMS, defaultStemLayout } from './ar/layout';
import { WaveformRenderer } from './ar/WaveformRenderer';
import { WebAudioEngine } from './audio/WebAudioEngine';
import { createEngineWaveforms } from './bridge/engineWaveforms';
import { createStemAudioBridge } from './bridge/stemAudioBridge';
import { drawHandOverlay } from './debug/handOverlay';
import { PerceptionPipeline, type GrabGesture, type HandState } from './perception';

/** 'grab' = pinch OR whole-hand grip; 'pinch' / 'grip' = only that gesture. */
const GRAB_GESTURE: GrabGesture = 'grab';

const stage = document.getElementById('stage') as HTMLDivElement;
const video = document.getElementById('webcam') as HTMLVideoElement;
const canvas = document.getElementById('overlay') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;
const startButton = document.getElementById('start') as HTMLButtonElement;
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

async function main(): Promise<void> {
  hud.textContent = 'Starting camera + loading hand model + preparing audio…';
  const [pipeline, audio] = await Promise.all([
    PerceptionPipeline.create(video),
    WebAudioEngine.create(DEFAULT_STEMS.map((s) => s.id)),
  ]);
  fitStage();
  window.addEventListener('resize', fitStage);

  const aspect0 = video.videoWidth / video.videoHeight;
  const stems = defaultStemLayout(aspect0).map(createHoloObject);

  const bridge = createStemAudioBridge(audio);
  // Push initial pan/volume so the engine (and readouts) start in sync.
  for (const obj of stems) bridge({ type: 'move', object: obj });

  const interaction = new InteractionController(stems, aspect0, bridge, GRAB_GESTURE);
  const drift = new DriftField(aspect0, GRAB_GESTURE);
  const waveforms = new WaveformRenderer(createEngineWaveforms(audio));

  // Browsers only allow audio to start from a user gesture.
  startButton.hidden = false;
  startButton.addEventListener('click', () => {
    void audio.start();
    startButton.hidden = true;
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'h' || e.key === 'H') hud.classList.toggle('hidden');
    if (e.key === ' ') {
      e.preventDefault();
      startButton.hidden = true;
      void audio.togglePause();
    }
  });

  let frames = 0;
  let fps = 0;
  let fpsWindowStart = performance.now();

  pipeline.onFrame((frame) => {
    const aspect = video.videoWidth / video.videoHeight;
    interaction.setAspect(aspect);
    interaction.update(frame);
    drift.setAspect(aspect);
    drift.step(interaction.objects, frame);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    waveforms.render(ctx, interaction.objects, frame.timestamp, { mix: audio.stems, backdrop: video });
    drawHandOverlay(ctx, frame, GRAB_GESTURE);

    frames++;
    if (frame.timestamp - fpsWindowStart >= 1000) {
      fps = (frames * 1000) / (frame.timestamp - fpsWindowStart);
      frames = 0;
      fpsWindowStart = frame.timestamp;
    }
    const byId = (id: string) => frame.hands.find((h) => h.id === id);
    const stemLines = stems.map((obj) => {
      const s = audio.stems.get(obj.id);
      const held = obj.holders.length ? `held by ${obj.holders.join('+')}` : 'free';
      const mix = s ? `  pan ${s.pan.toFixed(2)}  vol ${s.volume.toFixed(2)}  stretch ${s.stretch.toFixed(2)}` : '';
      return `${obj.label.padEnd(6)}: ${held.padEnd(19)}${mix}`;
    });
    hud.textContent =
      `tracking ${fps.toFixed(0)} fps   audio: ${audio.sourceKind === 'files' ? 'stem files' : 'demo song'} ${audio.playing ? '▶' : '❚❚'}   [space] play/pause  [H] hide\n` +
      `Left : ${describe(byId('Left'))}\n` +
      `Right: ${describe(byId('Right'))}\n` +
      stemLines.join('\n');
  });

  pipeline.start();
}

main().catch((err) => {
  console.error(err);
  hud.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
});
