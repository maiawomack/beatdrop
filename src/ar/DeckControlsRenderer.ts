import { viewToPixels } from '../perception';
import type { CrossfadeZone, Platter, TempoStrip } from './HoloObject';
import { TEMPO_RANGE } from './InteractionController';

const DECK_A = '#4fd9d2';
const DECK_B = '#c47be8';
/** 33⅓ rpm, in turns per second of audio. */
const TURNS_PER_SEC = 33.333 / 60;

/**
 * Open-palm controls: each deck's record (scratch) and the crossfader.
 * Pure visuals; reads the controller's platters / zone and live positions.
 */
export class DeckControlsRenderer {
  /** Record angle at the moment a scratch started, per deck (so the disc follows the hand). */
  private frozen = new Map<string, number>();

  render(
    ctx: CanvasRenderingContext2D,
    platters: readonly Platter[],
    zone: CrossfadeZone | null,
    crossfader: number,
    positionOf: (deck: 'A' | 'B') => number,
    strips: readonly TempoStrip[] = [],
    tempoOf: (deck: 'A' | 'B') => { rate: number; bpm: number | null } = () => ({ rate: 1, bpm: null }),
  ): void {
    for (const pl of platters) this.drawPlatter(ctx, pl, positionOf(pl.deck));
    for (const st of strips) this.drawTempo(ctx, st, tempoOf(st.deck));
    if (zone) this.drawCrossfader(ctx, zone, crossfader);
  }

  /** Tempo strip: notch at ×1.00, knob at the current rate (±TEMPO_RANGE spans the strip), readout below. */
  private drawTempo(ctx: CanvasRenderingContext2D, st: TempoStrip, t: { rate: number; bpm: number | null }): void {
    const { width: cw, height: ch } = ctx.canvas;
    const u = ch / 720;
    const c = viewToPixels(st.position, cw, ch);
    const half = st.halfHeight * ch;
    const rate = st.value ?? t.rate;
    const held = st.hand !== null;
    const glow = Math.max(st.hover, held ? 1 : 0);
    const k = Math.max(-1, Math.min(1, (rate - 1) / TEMPO_RANGE));
    const ky = c.y - k * half;
    ctx.save();
    ctx.globalAlpha = 0.5 + 0.5 * glow;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = u * 3;
    ctx.beginPath();
    ctx.moveTo(c.x, c.y - half);
    ctx.lineTo(c.x, c.y + half);
    ctx.stroke();
    // ×1.00 notch, and the stretch from it to the knob in the deck color.
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = u * 1.5;
    ctx.beginPath();
    ctx.moveTo(c.x - u * 7, c.y);
    ctx.lineTo(c.x + u * 7, c.y);
    ctx.stroke();
    ctx.strokeStyle = st.color;
    ctx.lineWidth = u * 3;
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(c.x, ky);
    ctx.stroke();
    ctx.beginPath();
    ctx.roundRect(c.x - u * 9, ky - u * 4, u * 18, u * 8, u * 3);
    ctx.fillStyle = 'rgba(240,244,255,0.95)';
    if (glow > 0.05) {
      ctx.shadowColor = st.color;
      ctx.shadowBlur = u * 12 * glow;
    }
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    // One line above the strip: change and resulting BPM (the record's own label sits below it).
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const pct = (rate - 1) * 100;
    const pctText = Math.abs(pct) < 0.05 ? '±0.0%' : `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
    ctx.font = `700 ${u * 10}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.fillStyle = 'rgba(235,242,255,0.9)';
    ctx.fillText(t.bpm ? `${pctText} · ${(t.bpm * rate).toFixed(1)} BPM` : pctText, c.x, c.y - half - u * 22);
    ctx.font = `600 ${u * 8}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.fillStyle = 'rgba(235,242,255,0.55)';
    ctx.fillText(held ? 'TEMPO ↕' : 'PINCH ↕ TEMPO', c.x, c.y - half - u * 10);
    ctx.restore();
  }

  private drawPlatter(ctx: CanvasRenderingContext2D, pl: Platter, positionSec: number): void {
    const { width: cw, height: ch } = ctx.canvas;
    const u = ch / 720;
    const c = viewToPixels(pl.position, cw, ch);
    const r = pl.radius * ch;
    const held = pl.hand !== null;
    if (held && !this.frozen.has(pl.deck)) this.frozen.set(pl.deck, positionSec);
    if (!held) this.frozen.delete(pl.deck);
    const turns = held ? this.frozen.get(pl.deck)! + pl.offsetSec : positionSec;
    const angle = turns * TURNS_PER_SEC * Math.PI * 2;
    const glow = Math.max(pl.hover, held ? 1 : 0);

    ctx.save();
    ctx.translate(c.x, c.y);
    // Disc.
    ctx.globalAlpha = 0.55 + 0.4 * glow;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(8,8,14,0.72)';
    ctx.fill();
    ctx.lineWidth = u * (1.2 + 1.5 * glow);
    ctx.strokeStyle = pl.color;
    if (glow > 0.05) {
      ctx.shadowColor = pl.color;
      ctx.shadowBlur = u * 16 * glow;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
    // Grooves.
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = u * 0.8;
    for (let k = 0.45; k < 0.97; k += 0.09) {
      ctx.beginPath();
      ctx.arc(0, 0, r * k, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Spinning sheen and marker so rotation (and scratching) is visible.
    ctx.rotate(angle);
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = u * 3;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.72, -0.5, 0.5);
    ctx.stroke();
    ctx.strokeStyle = pl.color;
    ctx.lineWidth = u * 2;
    ctx.beginPath();
    ctx.moveTo(r * 0.38, 0);
    ctx.lineTo(r * 0.95, 0);
    ctx.stroke();
    // Label.
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.32, 0, Math.PI * 2);
    ctx.fillStyle = pl.color;
    ctx.fill();
    ctx.rotate(-angle);
    ctx.fillStyle = 'rgba(8,8,14,0.9)';
    ctx.font = `800 ${r * 0.34}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(pl.deck, 0, u);

    // What to do.
    ctx.globalAlpha = 1;
    ctx.font = `600 ${u * 10}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.fillStyle = 'rgba(235,242,255,0.8)';
    const text = held ? '◀ SCRATCH ▶' : pl.hover > 0.05 ? 'HOLD…' : 'OPEN PALM = SCRATCH';
    ctx.globalAlpha = held || pl.hover > 0.05 ? 1 : 0.45;
    ctx.fillText(text, 0, r + u * 14);
    ctx.restore();
  }

  private drawCrossfader(ctx: CanvasRenderingContext2D, zone: CrossfadeZone, value: number): void {
    const { width: cw, height: ch } = ctx.canvas;
    const u = ch / 720;
    const held = zone.hand !== null;
    // Top center, between the two records.
    const y = ch * 0.085;
    const x0 = zone.x0 * cw + u * 30;
    const x1 = zone.x1 * cw - u * 30;
    const knob = x0 + ((value + 1) / 2) * (x1 - x0);
    const glow = Math.max(zone.arming, held ? 1 : 0);

    ctx.save();
    ctx.globalAlpha = 0.5 + 0.5 * glow;
    // Track with A / B ends.
    const g = ctx.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, DECK_A);
    g.addColorStop(1, DECK_B);
    ctx.strokeStyle = g;
    ctx.lineCap = 'round';
    ctx.lineWidth = u * (3 + 2 * glow);
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
    ctx.font = `800 ${u * 13}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = DECK_A;
    ctx.fillText('A', x0 - u * 14, y);
    ctx.fillStyle = DECK_B;
    ctx.fillText('B', x1 + u * 14, y);
    // Knob.
    ctx.beginPath();
    ctx.roundRect(knob - u * 7, y - u * 11, u * 14, u * 22, u * 4);
    ctx.fillStyle = 'rgba(240,244,255,0.95)';
    if (glow > 0.05) {
      ctx.shadowColor = 'rgba(200,220,255,1)';
      ctx.shadowBlur = u * 14 * glow;
    }
    ctx.fill();
    ctx.shadowBlur = 0;
    // Arming ring while two fingers up are being held.
    if (zone.arming > 0.02 && !held) {
      ctx.strokeStyle = 'rgba(240,244,255,0.9)';
      ctx.lineWidth = u * 2;
      ctx.beginPath();
      ctx.arc(knob, y, u * 18, -Math.PI / 2, -Math.PI / 2 + zone.arming * Math.PI * 2);
      ctx.stroke();
    }
    ctx.font = `600 ${u * 10}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.fillStyle = 'rgba(235,242,255,0.8)';
    ctx.globalAlpha = held || zone.arming > 0.02 ? 1 : 0.45;
    ctx.fillText(held ? '◀ CROSSFADE ▶' : '1–2 FINGERS UP + SLIDE = CROSSFADE', (x0 + x1) / 2, y + u * 26);
    ctx.restore();
  }
}
