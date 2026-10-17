import { HAND_CONNECTIONS, viewToPixels, type GrabGesture, type PerceptionFrame } from '../perception';

const HAND_COLORS = { Left: '#4fc3f7', Right: '#ffb74d' } as const;

/** Debug visualization of a PerceptionFrame: skeletons, labels, grab cursor. */
export function drawHandOverlay(
  ctx: CanvasRenderingContext2D,
  frame: PerceptionFrame,
  gesture: GrabGesture = 'grab',
): void {
  const { width: w, height: h } = ctx.canvas;
  const scale = w / 1000; // keep line widths sane across resolutions

  for (const hand of frame.hands) {
    const color = HAND_COLORS[hand.id];
    const pts = hand.landmarks.map((p) => viewToPixels(p, w, h));
    ctx.globalAlpha = hand.tracked ? 1 : 0.35;

    ctx.strokeStyle = color;
    ctx.lineWidth = 2 * scale;
    ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.moveTo(pts[a].x, pts[a].y);
      ctx.lineTo(pts[b].x, pts[b].y);
    }
    ctx.stroke();

    ctx.fillStyle = '#fff';
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3 * scale, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.font = `${16 * scale}px system-ui, sans-serif`;
    ctx.fillStyle = color;
    ctx.fillText(hand.id, pts[0].x + 10 * scale, pts[0].y + 20 * scale);

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
  }
  ctx.globalAlpha = 1;
}
