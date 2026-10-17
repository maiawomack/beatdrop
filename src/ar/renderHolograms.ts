import { viewToPixels } from '../perception';
import type { HoloObject } from './HoloObject';

const GRAB_COLORS = { Left: '#4fc3f7', Right: '#ffb74d' } as const;

/** Simple glowing-orb rendering for holographic objects. */
export function renderHolograms(ctx: CanvasRenderingContext2D, objects: HoloObject[], time: number): void {
  const { width: w, height: h } = ctx.canvas;

  for (const obj of objects) {
    const c = viewToPixels({ x: obj.position.x + obj.drift.x, y: obj.position.y + obj.drift.y }, w, h);
    const pulse = 1 + 0.04 * Math.sin(time / 300);
    const r = obj.radius * h * (obj.grabbedBy ? 1.1 : pulse);
    const ring = obj.grabbedBy ? GRAB_COLORS[obj.grabbedBy] : obj.color;

    const glow = ctx.createRadialGradient(c.x, c.y, r * 0.2, c.x, c.y, r * 1.6);
    glow.addColorStop(0, withAlpha(obj.color, 0.55));
    glow.addColorStop(0.6, withAlpha(obj.color, 0.2));
    glow.addColorStop(1, withAlpha(obj.color, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r * 1.6, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = ring;
    ctx.lineWidth = Math.max(2, r * 0.06);
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = '#fff';
    ctx.font = `600 ${Math.round(r * 0.32)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(obj.label, c.x, c.y);
  }
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}

/** '#rrggbb' -> 'rgba(r, g, b, a)' */
function withAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
