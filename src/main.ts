import { DriftField } from './ar/DriftField';
import { createHoloObject } from './ar/HoloObject';
import { InteractionController } from './ar/InteractionController';
import { renderHolograms } from './ar/renderHolograms';
import { MockAudioEngine } from './audio/MockAudioEngine';
import { createStemAudioBridge } from './bridge/stemAudioBridge';
import { drawHandOverlay } from './debug/handOverlay';
import { PerceptionPipeline, type HandState } from './perception';

const stage = document.getElementById('stage') as HTMLDivElement;
const video = document.getElementById('webcam') as HTMLVideoElement;
const canvas = document.getElementById('overlay') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;
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
  const { phase, ratio } = hand.pinch;
  const status = hand.tracked ? '' : ' (lost)';
  return `${phase.padEnd(5)} ratio ${ratio.toFixed(2)}${status}`;
}

async function main(): Promise<void> {
  hud.textContent = 'Starting camera + loading hand model…';
  const pipeline = await PerceptionPipeline.create(video);
  fitStage();
  window.addEventListener('resize', fitStage);

  const stems = [
    createHoloObject({ id: 'drums', label: 'Drums', position: { x: 0.25, y: 0.5 }, radius: 0.09, color: '#ff5252' }),
    createHoloObject({ id: 'vocals', label: 'Vocals', position: { x: 0.5, y: 0.5 }, radius: 0.09, color: '#b388ff' }),
    createHoloObject({ id: 'bass', label: 'Bass', position: { x: 0.75, y: 0.5 }, radius: 0.09, color: '#69f0ae' }),
  ];

  const audio = new MockAudioEngine();
  const interaction = new InteractionController(
    stems,
    video.videoWidth / video.videoHeight,
    createStemAudioBridge(audio),
  );
  const drift = new DriftField(video.videoWidth / video.videoHeight);

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
    renderHolograms(ctx, interaction.objects, frame.timestamp);
    drawHandOverlay(ctx, frame);

    frames++;
    if (frame.timestamp - fpsWindowStart >= 1000) {
      fps = (frames * 1000) / (frame.timestamp - fpsWindowStart);
      frames = 0;
      fpsWindowStart = frame.timestamp;
    }
    const byId = (id: string) => frame.hands.find((h) => h.id === id);
    const stemLines = stems.map((obj) => {
      const s = audio.stems.get(obj.id);
      const held = obj.grabbedBy ? `held by ${obj.grabbedBy}` : 'free';
      const mix = s ? `  pan ${s.pan.toFixed(2)}  vol ${s.volume.toFixed(2)}` : '';
      return `${obj.label.padEnd(6)}: ${held.padEnd(13)}${mix}`;
    });
    hud.textContent =
      `tracking ${fps.toFixed(0)} fps\n` +
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
