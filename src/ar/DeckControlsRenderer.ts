import { viewToPixels } from '../perception';
import type { CrossfadeZone, Platter, TempoStrip } from './HoloObject';

/** A deck's tempo for its edge pulse: rate, base BPM, and where it is in the beat (0..1, null if unknown or stopped). */
export interface TempoInfo {
  rate: number;
  bpm: number | null;
  beatPhase: number | null;
}

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
    tempoOf: (deck: 'A' | 'B') => TempoInfo = () => ({ rate: 1, bpm: null, beatPhase: null }),
  ): void {
    for (const pl of platters) this.drawPlatter(ctx, pl, positionOf(pl.deck));
    for (const st of strips) this.drawTempo(ctx, st, tempoOf(st.deck));
    if (zone) this.drawCrossfader(ctx, zone, crossfader);
  }

  /**
   * Tempo at a screen edge (left = A, right = B), level with the hand: a clean solid line
   * in the deck's colour along the edge that thickens on each beat (so it quickens as the
   * song speeds up), with plain text beside it. Dim while a hand is at the edge, solid while
   * a fist holds the tempo. No blur or glow.
   */
  private drawTempo(ctx: CanvasRenderingContext2D, st: TempoStrip, t: TempoInfo): void {
    const held = st.hand !== null;
    const vis = held ? 1 : st.hover;
    if (vis <= 0) return;
    const { width: cw, height: ch } = ctx.canvas;
    const u = ch / 720;
    const left = st.deck === 'A';
    const y = st.position.y * ch;
    const rate = st.value ?? t.rate;
    const beat = t.beatPhase === null ? 0 : Math.exp(-t.beatPhase * 6);
    const w = u * (held ? 5 : 3) * (1 + 0.8 * beat);
    const half = ch * 0.1;
    ctx.save();
    ctx.globalAlpha = vis * (held ? 1 : 0.55);
    ctx.fillStyle = st.color;
    ctx.fillRect(left ? 0 : cw - w, y - half, w, half * 2);
    // Readout beside the line.
    ctx.textAlign = left ? 'left' : 'right';
    ctx.textBaseline = 'middle';
    const tx = left ? u * 16 : cw - u * 16;
    ctx.fillStyle = 'rgba(240,246,255,0.95)';
    if (held) {
      const pct = (rate - 1) * 100;
      ctx.font = `700 ${u * 15}px ui-monospace, "SF Mono", Menlo, monospace`;
      ctx.fillText(Math.abs(pct) < 0.05 ? '±0.0%' : `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`, tx, y - u * 9);
      ctx.font = `600 ${u * 10}px ui-monospace, "SF Mono", Menlo, monospace`;
      ctx.fillStyle = 'rgba(235,242,255,0.7)';
      ctx.fillText(t.bpm ? `${(t.bpm * rate).toFixed(1)} BPM ↕` : 'TEMPO ↕', tx, y + u * 9);
    } else {
      ctx.font = `600 ${u * 10}px ui-monospace, "SF Mono", Menlo, monospace`;
      ctx.fillText('FIST ↕ TEMPO', tx, y);
    }
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
    const text = held ? '↺ SCRATCH ↻' : pl.hover > 0.05 ? 'HOLD…' : 'OPEN PALM ↻ = SCRATCH';
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
