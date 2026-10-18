import type { HandMode } from '../ar/InteractionController';
import { HAND_CONNECTIONS, viewToPixels, type GrabGesture, type HandId, type PerceptionFrame } from '../perception';

const HAND_COLORS = { Left: '#4fc3f7', Right: '#ffb74d' } as const;

/** Short label under the cursor for what the hand is doing (idle / hover show nothing). */
const MODE_LABELS: Partial<Record<HandMode, string>> = {
  repositioning: 'MOVE',
  stretching: 'STRETCH FX',
  blending: 'BLEND',
  loopSelecting: 'LOOP',
  clipPulling: 'PULL OUT LOOP',
  filterControl: 'FILTER',
  volume: 'VOLUME ↕',
  scratching: 'SCRATCH',
  scratchArming: 'SCRATCH…',
  tempo: 'TEMPO ↕',
  crossfading: 'CROSSFADE',
  buildArmed: 'BUILD',
  building: 'BUILD',
  dropPending: 'DROP',
  trackingLost: 'LOST',
};

/** Debug visualization of a PerceptionFrame: skeletons, labels, grab cursor. */
export function drawHandOverlay(
  ctx: CanvasRenderingContext2D,
  frame: PerceptionFrame,
  gesture: GrabGesture = 'grab',
  modes?: ReadonlyMap<HandId, HandMode>,
): void {
  const { width: w, height: h } = ctx.canvas;
  const scale = w / 1000; // keep line widths sane across resolutions

  for (const hand of frame.hands) {
    const color = HAND_COLORS[hand.id];
    const pts = hand.landmarks.map((p) => viewToPixels(p, w, h));
    // Faint skeleton: enough to see tracking, without competing with the waveforms.
    ctx.globalAlpha = hand.tracked ? 0.4 : 0.15;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2 * scale;
    ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.moveTo(pts[a].x, pts[a].y);
      ctx.lineTo(pts[b].x, pts[b].y);
    }
    ctx.stroke();
    ctx.globalAlpha = hand.tracked ? 1 : 0.35;

    // Grab cursor: a progress arc fills as the hand closes, solid dot once engaged.
    const g = hand[gesture];
    const c = viewToPixels(g.point, w, h);
    const r = (14 - 5 * g.strength) * scale;
    ctx.lineWidth = 2 * scale;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.stroke();
    if (g.active) {
      ctx.beginPath();
      ctx.arc(c.x, c.y, r * 0.75, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    } else if (g.strength > 0.02) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 3 * scale;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, -Math.PI / 2, -Math.PI / 2 + g.strength * Math.PI * 2);
      ctx.stroke();
    }

    const label = modes && MODE_LABELS[modes.get(hand.id) ?? 'idle'];
    if (label) {
      ctx.font = `700 ${11 * scale}px ui-monospace, "SF Mono", Menlo, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = color;
      ctx.fillText(label, c.x, c.y + r + 6 * scale);
    }
  }
  ctx.globalAlpha = 1;
}
