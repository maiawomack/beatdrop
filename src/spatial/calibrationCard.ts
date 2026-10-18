/**
 * The gesture calibration card (spatial screen), in BeatDrop's colours (deck teal and lilac,
 * orange accents): a plain dark card over the camera with one dot per gesture, the current
 * gesture and what it's for, a progress bar (hold / countdown / recording / checking) and
 * the results. Pure drawing; the content comes from CalibrationStage.view().
 */

import { LILAC, ORANGE, TEAL, YELLOW } from '../decks/theme';
import type { CalibrationView } from './calibrationStage';

const INK = '#f4f1ea';
const DIM = 'rgba(244, 241, 234, 0.62)';
const LINE = 'rgba(255, 255, 255, 0.14)';
const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';

export function drawCalibrationCard(ctx: CanvasRenderingContext2D, v: CalibrationView, now: number): void {
  const { width: cw, height: ch } = ctx.canvas;
  const u = ch / 720;
  const w = Math.min(cw * 0.86, u * 900);
  const pad = u * 30;
  const lineH = u * 24;
  const textW = w - pad * 2;

  // Content, wrapped to the card's width (result lines leave room for the big mark).
  ctx.save();
  const instr = wrapAll(ctx, v.instruction ? v.instruction.split('\n') : [], `500 ${u * 16}px ${MONO}`, textW);
  const lines = wrapAll(ctx, v.lines ?? [], `500 ${u * 15}px ${MONO}`, v.mode === 'result' ? textW - u * 42 : textW, true);
  ctx.restore();
  let h = pad * 2 + u * 34 /* header */ + u * 64 /* title */;
  if (v.use && v.mode !== 'offer') h += u * 6;
  h += instr.length * lineH;
  if (v.mode === 'offer') h += u * 96; // gesture chips
  if (v.status || v.mode === 'checking') h += u * 56;
  if (lines.length) h += u * 14 + lines.length * lineH * (v.mode === 'summary' ? 1.15 : 1);
  if (v.keys.length) h += u * 52;
  const x = (cw - w) / 2;
  const y = Math.max(u * 20, (ch - h) / 2);

  ctx.save();
  // Backdrop dim, so the card reads over a busy camera image.
  ctx.fillStyle = 'rgba(4, 6, 14, 0.35)';
  ctx.fillRect(0, 0, cw, ch);

  // Card: plain and dark, a thin line around it, a deck-coloured strip along the top.
  roundRect(ctx, x, y, w, h, u * 18);
  ctx.fillStyle = 'rgba(22, 22, 26, 0.94)';
  ctx.fill();
  ctx.strokeStyle = LINE;
  ctx.lineWidth = u * 1.2;
  ctx.stroke();
  ctx.save();
  roundRect(ctx, x, y, w, h, u * 18);
  ctx.clip();
  ctx.fillStyle = TEAL;
  ctx.fillRect(x, y, w / 2, u * 4);
  ctx.fillStyle = LILAC;
  ctx.fillRect(x + w / 2, y, w / 2, u * 4);
  ctx.restore();

  let cy = y + pad;
  const left = x + pad;
  const right = x + w - pad;

  // Header: badge left, step dots right.
  drawBadge(ctx, left, cy, u, v.perceptron);
  drawSteps(ctx, right, cy + u * 12, u, v);
  cy += u * 34;

  // Title (and countdown number).
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = INK;
  ctx.font = `800 ${u * 40}px ${MONO}`;
  const title = v.mode === 'recording' ? `● ${v.title}` : v.title;
  if (v.mode === 'recording') {
    ctx.fillStyle = Math.sin(now / 180) > 0 ? ORANGE : withAlpha(ORANGE, 0.5);
    ctx.fillText('●', left, cy + u * 44);
    ctx.fillStyle = INK;
    ctx.fillText(v.title, left + ctx.measureText('● ').width, cy + u * 44);
  } else ctx.fillText(title, left, cy + u * 44);
  if (v.mode === 'countdown' && v.count !== undefined) {
    ctx.textAlign = 'right';
    ctx.fillStyle = ORANGE;
    ctx.font = `800 ${u * 52}px ${MONO}`;
    ctx.fillText(String(v.count), right, cy + u * 48);
    ctx.textAlign = 'left';
  }
  if (v.use && v.mode !== 'offer' && v.mode !== 'summary') {
    ctx.font = `700 ${u * 12}px ${MONO}`;
    ctx.fillStyle = ORANGE;
    ctx.fillText(`USED FOR  ${v.use.toUpperCase()}`, left, cy + u * 64);
    cy += u * 6;
  }
  cy += u * 64;

  // Instruction.
  ctx.font = `500 ${u * 16}px ${MONO}`;
  ctx.fillStyle = DIM;
  for (const line of instr) {
    cy += lineH;
    ctx.fillText(line, left, cy - u * 6);
  }

  // Offer: the five gestures, with what each is for.
  if (v.mode === 'offer') {
    cy += u * 18;
    const gap = u * 10;
    const cw5 = (right - left - gap * (v.steps.length - 1)) / v.steps.length;
    v.steps.forEach((s, i) => {
      const bx = left + i * (cw5 + gap);
      roundRect(ctx, bx, cy, cw5, u * 62, u * 12);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.fill();
      ctx.strokeStyle = LINE;
      ctx.lineWidth = u;
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.fillStyle = INK;
      ctx.font = `700 ${u * 14}px ${MONO}`;
      ctx.fillText(s.title, bx + cw5 / 2, cy + u * 27);
      ctx.fillStyle = i < 2 ? TEAL : i < 4 ? LILAC : ORANGE;
      ctx.font = `600 ${u * 11}px ${MONO}`;
      ctx.fillText(s.use.toUpperCase(), bx + cw5 / 2, cy + u * 47);
    });
    ctx.textAlign = 'left';
    cy += u * 78;
  }

  // Status: progress bar (while checking, a plain segment moving across).
  if (v.status || v.mode === 'checking') {
    cy += u * 18;
    const barY = cy;
    const barH = u * 8;
    roundRect(ctx, left, barY, right - left, barH, barH / 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.09)';
    ctx.fill();
    if (v.mode === 'checking') {
      const t = (now / 1400) % 1;
      const bw = (right - left) * 0.22;
      const bx = left + t * (right - left - bw);
      roundRect(ctx, bx, barY, bw, barH, barH / 2);
      ctx.fillStyle = LILAC;
      ctx.fill();
    } else if (v.progress !== undefined) {
      const color = v.mode === 'ready' ? TEAL : ORANGE;
      roundRect(ctx, left, barY, Math.max(barH, (right - left) * v.progress), barH, barH / 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
    ctx.font = `600 ${u * 14}px ${MONO}`;
    ctx.fillStyle = INK;
    ctx.fillText(v.status ?? '', left, barY + u * 34);
    cy += u * 38;
  }

  // Result / summary lines, coloured by outcome.
  if (lines.length) {
    cy += u * 14;
    if (v.mode === 'result') {
      // Big mark, then the text.
      ctx.font = `800 ${u * 30}px ${MONO}`;
      ctx.fillStyle = v.ok ? TEAL : ORANGE;
      ctx.fillText(v.ok ? '✓' : '✗', left, cy + u * 16);
    }
    const tx = v.mode === 'result' ? left + u * 42 : left;
    let color = DIM;
    lines.forEach((line, i) => {
      const ly = cy + (i + 0.7) * lineH * (v.mode === 'summary' ? 1.15 : 1);
      ctx.font = `${i === 0 && v.mode === 'result' ? 700 : 500} ${u * 15}px ${MONO}`;
      // A wrapped continuation keeps its line's colour and is indented.
      const cont = line.startsWith(CONT);
      if (!cont) color = lineColor(line, v.mode === 'result' && i === 0 ? (v.ok ? TEAL : ORANGE) : DIM);
      ctx.fillStyle = color;
      ctx.fillText(cont ? line.slice(CONT.length) : line.trim(), cont ? tx + u * 24 : tx, ly);
    });
    cy += lines.length * lineH * (v.mode === 'summary' ? 1.15 : 1);
  }

  // Keys.
  if (v.keys.length) {
    cy += u * 22;
    let kx = left;
    for (const [key, label] of v.keys) {
      ctx.font = `700 ${u * 13}px ${MONO}`;
      const kw = ctx.measureText(key).width + u * 18;
      roundRect(ctx, kx, cy, kw, u * 26, u * 7);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
      ctx.lineWidth = u;
      ctx.stroke();
      ctx.fillStyle = INK;
      ctx.textAlign = 'center';
      ctx.fillText(key, kx + kw / 2, cy + u * 18);
      ctx.textAlign = 'left';
      kx += kw + u * 8;
      ctx.font = `500 ${u * 13}px ${MONO}`;
      ctx.fillStyle = DIM;
      ctx.fillText(label, kx, cy + u * 18);
      kx += ctx.measureText(label).width + u * 22;
    }
  }
  ctx.restore();
}

/** Small plain label: "GESTURE SETUP · CHECKED BY PERCEPTRON" (or "· ON THIS COMPUTER"). */
function drawBadge(ctx: CanvasRenderingContext2D, x: number, y: number, u: number, on: boolean): void {
  ctx.font = `700 ${u * 11}px ${MONO}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = DIM;
  const head = 'GESTURE SETUP  ·  ';
  ctx.fillText(head, x, y + u * 12);
  ctx.fillStyle = on ? TEAL : DIM;
  ctx.fillText(on ? 'CHECKED BY PERCEPTRON' : 'ON THIS COMPUTER', x + ctx.measureText(head).width, y + u * 12);
  ctx.textBaseline = 'alphabetic';
}

/** One dot per gesture, right-aligned: done ✓ (teal), skipped –, current (orange), to do. */
function drawSteps(ctx: CanvasRenderingContext2D, right: number, cy: number, u: number, v: CalibrationView): void {
  const r = u * 8;
  const gap = u * 10;
  const n = v.steps.length;
  let x = right - r - (n - 1) * (2 * r + gap);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const s of v.steps) {
    ctx.beginPath();
    ctx.arc(x, cy, r, 0, Math.PI * 2);
    if (s.state === 'done') {
      ctx.fillStyle = TEAL;
      ctx.fill();
      ctx.fillStyle = '#16161a';
      ctx.font = `800 ${u * 11}px ${MONO}`;
      ctx.fillText('✓', x, cy + u * 0.5);
    } else if (s.state === 'current') {
      ctx.fillStyle = ORANGE;
      ctx.fill();
    } else {
      ctx.strokeStyle = s.state === 'skipped' ? 'rgba(255, 255, 255, 0.35)' : 'rgba(255, 255, 255, 0.22)';
      ctx.lineWidth = u * 1.4;
      ctx.stroke();
      if (s.state === 'skipped') {
        ctx.fillStyle = DIM;
        ctx.font = `700 ${u * 11}px ${MONO}`;
        ctx.fillText('–', x, cy);
      }
    }
    x += 2 * r + gap;
  }
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
}

/** Summary lines: ✗ orange, ⚠ yellow, ✓ plain, the Perceptron line lilac. */
function lineColor(line: string, fallback: string): string {
  if (line.includes('✗')) return ORANGE;
  if (line.includes('⚠')) return YELLOW;
  if (line.includes('✓')) return INK;
  if (/Perceptron AI checked|Perceptron checked/.test(line)) return LILAC;
  return fallback;
}

/** Marks a wrapped continuation line (drawn indented, in its line's colour). */
const CONT = '\u0000';

/** Word-wrap each line to `maxW` at `font`; continuations are marked with CONT when `mark`. */
function wrapAll(ctx: CanvasRenderingContext2D, lines: string[], font: string, maxW: number, mark = false): string[] {
  ctx.font = font;
  const out: string[] = [];
  for (const line of lines) {
    const words = line.trim().split(/(\s+)/);
    let cur = '';
    let first = true;
    for (const word of words) {
      const next = cur + word;
      const indent = first ? 0 : maxW * 0.04;
      if (cur && ctx.measureText(next.trimEnd()).width > maxW - indent) {
        out.push((first || !mark ? '' : CONT) + cur.trimEnd());
        first = false;
        cur = word.trimStart();
      } else cur = next;
    }
    out.push((first || !mark ? '' : CONT) + cur.trimEnd());
  }
  return out;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function withAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
