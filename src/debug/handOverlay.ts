import { HAND_CONNECTIONS, viewToPixels, type PerceptionFrame } from '../perception';

const HAND_COLORS = { Left: '#4fc3f7', Right: '#ffb74d' } as const;

/** Debug visualization of a PerceptionFrame: skeletons, labels, pinch cursor. */
export function drawHandOverlay(ctx: CanvasRenderingContext2D, frame: PerceptionFrame): void {
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

    // Pinch cursor: hollow ring when open, filled when pinching.
    const c = viewToPixels(hand.pinch.point, w, h);
    ctx.beginPath();
    ctx.arc(c.x, c.y, (hand.pinch.active ? 12 : 9) * scale, 0, Math.PI * 2);
    if (hand.pinch.active) {
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      ctx.lineWidth = 2 * scale;
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}
