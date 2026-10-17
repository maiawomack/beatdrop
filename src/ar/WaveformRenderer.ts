import { viewToPixels } from '../perception';
import type { HoloObject } from './HoloObject';
import { ProceduralWaveforms, type WaveformSource } from './waveforms';

/** Per-stem mix values, used only for readouts and mute/level visuals. */
export interface StemMix {
  pan: number;
  volume: number;
}

export interface RenderOptions {
  mix?: ReadonlyMap<string, StemMix>;
  /** Webcam video, used to draw a frosted-glass backing behind each waveform. */
  backdrop?: HTMLVideoElement;
}

const HAND_COLORS = { Left: '#4fc3f7', Right: '#ffb74d' } as const;
const SAMPLES = 128;
/** Volume at or below this counts as muted. */
const MUTE_BELOW = 0.05;
/** Playhead sweeps across the waveform this many times per second. */
const PLAYHEAD_SPEED = 0.25;

interface VisualState {
  hover: number;
  grab: number;
  mute: number;
  /** Smoothed grab intent (how far the targeting hand has closed). */
  intent: number;
  lastT: number;
  wasHeld: boolean;
  /** Time (ms) of the last grab / release, for the snap flash. */
  grabAt: number;
  releaseAt: number;
}

/** Duration of the grab/release flash (ms). */
const FLASH_MS = 380;

interface BodyFrame {
  cx: number;
  cy: number;
  W: number;
  H: number;
  angle: number;
}

type RGB = [number, number, number];

/**
 * Draws stems as floating holographic waveforms: a frosted glass capsule with
 * a neon mirrored-envelope waveform, HUD brackets, label and mix readout.
 * Pure visuals: reads HoloObject state, never mutates it.
 */
export class WaveformRenderer {
  private visuals = new Map<string, VisualState>();
  private peaks = new Float32Array(SAMPLES);
  private filterSupported: boolean | null = null;

  constructor(private source: WaveformSource = new ProceduralWaveforms()) {}

  render(ctx: CanvasRenderingContext2D, objects: HoloObject[], timeMs: number, opts: RenderOptions = {}): void {
    if (this.filterSupported === null) this.filterSupported = detectFilter(ctx);
    const t = timeMs / 1000;

    const entries = objects.map((obj, index) => ({ obj, index, vis: this.animate(obj, opts, timeMs) }));
    // Held objects draw on top.
    entries.sort((a, b) => a.vis.grab - b.vis.grab);

    for (const { obj, index, vis } of entries) {
      const frame = this.bodyFrame(ctx, obj, vis);
      this.drawTethers(ctx, obj, frame, vis, t);
      this.drawBody(ctx, obj, index, frame, vis, t, opts);
      if (obj.stretch) this.drawStretchNodes(ctx, obj, frame);
    }
  }

  private animate(obj: HoloObject, opts: RenderOptions, timeMs: number): VisualState {
    const vis =
      this.visuals.get(obj.id) ??
      { hover: 0, grab: 0, mute: 0, intent: 0, lastT: timeMs, wasHeld: false, grabAt: -1e9, releaseAt: -1e9 };
    const dt = Math.min(0.1, Math.max(0, (timeMs - vis.lastT) / 1000));
    vis.lastT = timeMs;
    const k = 1 - Math.exp(-dt * 14);
    const muted = (opts.mix?.get(obj.id)?.volume ?? 1) <= MUTE_BELOW;
    vis.hover += (obj.hover - vis.hover) * k;
    vis.grab += ((obj.holders.length > 0 ? 1 : 0) - vis.grab) * k;
    vis.mute += ((muted ? 1 : 0) - vis.mute) * k;
    // Intent responds faster: it should track the fingers closely.
    vis.intent += (obj.intent - vis.intent) * (1 - Math.exp(-dt * 25));
    const held = obj.holders.length > 0;
    if (held && !vis.wasHeld) vis.grabAt = timeMs;
    if (!held && vis.wasHeld) vis.releaseAt = timeMs;
    vis.wasHeld = held;
    this.visuals.set(obj.id, vis);
    return vis;
  }

  private bodyFrame(ctx: CanvasRenderingContext2D, obj: HoloObject, vis: VisualState): BodyFrame {
    const { width: cw, height: ch } = ctx.canvas;
    const flash = Math.max(0, 1 - (vis.lastT - vis.grabAt) / FLASH_MS);
    // Slight squeeze as the hand closes, then a springy pop on grab.
    const scale = 1 + 0.035 * vis.hover - 0.03 * vis.intent * (1 - vis.grab) + 0.06 * vis.grab + 0.05 * flash * flash;
    const baseW = obj.halfSize.x * 2 * ch;
    const baseH = obj.halfSize.y * 2 * ch;

    if (obj.stretch) {
      const a = viewToPixels(obj.stretch.ends[0], cw, ch);
      const b = viewToPixels(obj.stretch.ends[1], cw, ch);
      let angle = Math.atan2(b.y - a.y, b.x - a.x);
      // Keep text upright.
      if (angle > Math.PI / 2) angle -= Math.PI;
      if (angle < -Math.PI / 2) angle += Math.PI;
      const H = baseH * scale * (1 - 0.25 * obj.stretch.amount);
      const span = Math.hypot(b.x - a.x, b.y - a.y);
      return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, W: Math.max(span + H * 0.6, baseW * 0.5), H, angle };
    }

    const c = viewToPixels({ x: obj.position.x + obj.drift.x, y: obj.position.y + obj.drift.y }, cw, ch);
    return { cx: c.x, cy: c.y, W: baseW * scale, H: baseH * scale, angle: 0 };
  }

  private drawBody(
    ctx: CanvasRenderingContext2D,
    obj: HoloObject,
    index: number,
    f: BodyFrame,
    vis: VisualState,
    t: number,
    opts: RenderOptions,
  ): void {
    const u = ctx.canvas.height / 720; // design px -> canvas px
    const { W, H } = f;
    const base = desaturate(hexToRgb(obj.color), 0.65 * vis.mute);
    const bright = mixRgb(base, [255, 255, 255], 0.35);
    const accent = obj.holders.length === 1 ? hexToRgb(HAND_COLORS[obj.holders[0]]) : base;
    const live = this.source.level?.(obj.id) ?? 0;
    const glow = (0.35 + 0.4 * vis.hover + 0.4 * vis.intent + 0.65 * vis.grab + 0.5 * live) * (1 - 0.6 * vis.mute);
    const mix = opts.mix?.get(obj.id);

    ctx.save();
    ctx.globalAlpha = 1 - 0.6 * vis.mute;
    ctx.translate(f.cx, f.cy);
    ctx.rotate(f.angle);

    // --- Glass backing -------------------------------------------------------
    this.frost(ctx, f, opts.backdrop);
    capsulePath(ctx, W, H);
    const tint = ctx.createLinearGradient(0, -H / 2, 0, H / 2);
    const tintAlpha = this.filterSupported && opts.backdrop ? 0.38 : 0.5;
    tint.addColorStop(0, `rgba(255,255,255,${0.07 + 0.04 * vis.hover})`);
    tint.addColorStop(0.35, `rgba(6,8,20,${tintAlpha})`);
    tint.addColorStop(1, rgba(base, 0.12 + 0.08 * vis.grab));
    ctx.fillStyle = tint;
    ctx.fill();

    ctx.save();
    ctx.shadowColor = rgba(base, 0.9);
    ctx.shadowBlur = u * 12 * glow;
    ctx.strokeStyle = rgba(accent, 0.22 + 0.45 * vis.hover + 0.55 * vis.grab);
    ctx.lineWidth = u * (1 + 0.6 * vis.grab);
    ctx.stroke();
    ctx.restore();

    // Snap flash: an expanding outline on grab (bright) and release (soft).
    for (const [at, strength] of [[vis.grabAt, 1], [vis.releaseAt, 0.45]] as const) {
      const age = (vis.lastT - at) / FLASH_MS;
      if (age < 0 || age >= 1) continue;
      const grow = 1 + 0.35 * easeOut(age);
      ctx.save();
      ctx.scale(grow, 1 + (grow - 1) * 2.2);
      capsulePath(ctx, W, H);
      ctx.strokeStyle = rgba(accent, strength * (1 - age));
      ctx.lineWidth = (u * 2) / grow;
      ctx.shadowColor = rgba(accent, 1);
      ctx.shadowBlur = u * 14;
      ctx.stroke();
      ctx.restore();
    }

    // Glass sheen along the top edge.
    ctx.beginPath();
    ctx.moveTo(-W / 2 + H / 2, -H / 2 + u * 1.5);
    ctx.lineTo(W / 2 - H / 2, -H / 2 + u * 1.5);
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = u;
    ctx.stroke();

    // --- HUD corner brackets -------------------------------------------------
    // Brackets lock onto the body as the hand closes.
    const off = u * Math.max(1, 5 + 6 * vis.hover - 9 * vis.intent * (1 - vis.grab) - 2 * vis.grab);
    const len = H * 0.22;
    ctx.strokeStyle = rgba(accent, 0.35 + 0.5 * Math.max(vis.hover, vis.grab));
    ctx.lineWidth = u * 1.2;
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const x = sx * (W / 2 + off);
        const y = sy * (H / 2 + off);
        ctx.beginPath();
        ctx.moveTo(x - sx * len, y);
        ctx.lineTo(x, y);
        ctx.lineTo(x, y - sy * len * 0.7);
        ctx.stroke();
      }
    }

    // --- Waveform ------------------------------------------------------------
    const x0 = -W / 2 + H * 0.45;
    const x1 = W / 2 - H * 0.45;
    const level = 0.3 + 0.7 * (mix?.volume ?? 1);
    const amp = H * 0.34 * level;
    if (!this.source.peaks(obj.id, this.peaks, t)) this.peaks.fill(0.05);
    const xs = (i: number) => x0 + ((x1 - x0) * i) / (SAMPLES - 1);

    // Filled envelope.
    ctx.beginPath();
    for (let i = 0; i < SAMPLES; i++) ctx.lineTo(xs(i), -this.peaks[i] * amp);
    for (let i = SAMPLES - 1; i >= 0; i--) ctx.lineTo(xs(i), this.peaks[i] * amp);
    ctx.closePath();
    const fill = ctx.createLinearGradient(0, -amp, 0, amp);
    fill.addColorStop(0, rgba(base, 0.04));
    fill.addColorStop(0.5, rgba(base, 0.22 + 0.15 * vis.grab));
    fill.addColorStop(1, rgba(base, 0.04));
    ctx.fillStyle = fill;
    ctx.fill();

    // Neon outline: wide soft bloom pass, then thin bright core.
    const p = this.source.playhead?.(obj.id) ?? fract(t * PLAYHEAD_SPEED);
    const line = ctx.createLinearGradient(x0, 0, x1, 0);
    line.addColorStop(0, rgba(base, 0.55));
    line.addColorStop(Math.max(0, p - 0.12), rgba(base, 0.75));
    line.addColorStop(p, rgba(bright, 1));
    line.addColorStop(Math.min(1, p + 0.015), rgba(base, 0.65));
    line.addColorStop(1, rgba(base, 0.5));

    const contour = (sign: number) => {
      ctx.beginPath();
      for (let i = 0; i < SAMPLES; i++) {
        const x = xs(i);
        const y = sign * this.peaks[i] * amp;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    };

    ctx.save();
    ctx.shadowColor = rgba(base, 1);
    ctx.shadowBlur = u * 16 * glow;
    ctx.strokeStyle = rgba(base, 0.25 * glow + 0.1);
    ctx.lineWidth = u * 3.2;
    for (const s of [-1, 1]) {
      contour(s);
      ctx.stroke();
    }
    ctx.restore();

    ctx.strokeStyle = line;
    ctx.lineWidth = u * (1.1 + 0.4 * vis.grab);
    for (const s of [-1, 1]) {
      contour(s);
      ctx.stroke();
    }

    // Center line + playhead.
    ctx.beginPath();
    ctx.moveTo(x0, 0);
    ctx.lineTo(x1, 0);
    ctx.strokeStyle = rgba(base, 0.18);
    ctx.lineWidth = u * 0.8;
    ctx.stroke();

    const px = x0 + (x1 - x0) * p;
    ctx.beginPath();
    ctx.moveTo(px, -H * 0.4);
    ctx.lineTo(px, H * 0.4);
    ctx.strokeStyle = rgba(bright, 0.45);
    ctx.lineWidth = u;
    ctx.stroke();

    // --- Labels --------------------------------------------------------------
    const fs = Math.max(u * 10, H * 0.15);
    const ty = -H / 2 - off - fs * 0.6;
    ctx.font = `600 ${fs}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.textBaseline = 'middle';
    setLetterSpacing(ctx, `${(fs * 0.12).toFixed(1)}px`);

    ctx.beginPath();
    ctx.arc(-W / 2 + H * 0.3, ty, fs * 0.22, 0, Math.PI * 2);
    ctx.fillStyle = rgba(base, 1);
    ctx.fill();

    ctx.textAlign = 'left';
    ctx.fillStyle = rgba(bright, 0.95);
    const idx = String(index + 1).padStart(2, '0');
    ctx.fillText(`${idx} ${obj.label.toUpperCase()}`, -W / 2 + H * 0.3 + fs * 0.55, ty);

    ctx.textAlign = 'right';
    ctx.fillStyle = `rgba(230,236,255,${0.55 + 0.3 * vis.hover})`;
    ctx.fillText(readout(obj, mix, vis.mute > 0.5), W / 2 - H * 0.3, ty);

    setLetterSpacing(ctx, '0px');
    ctx.restore();
  }

  /** Frosted glass: blurred, darkened copy of the camera feed clipped to the capsule. */
  private frost(ctx: CanvasRenderingContext2D, f: BodyFrame, video?: HTMLVideoElement): void {
    if (!video || !this.filterSupported || !video.videoWidth) return;
    const { width: cw, height: ch } = ctx.canvas;
    const pad = 16;
    const c = Math.abs(Math.cos(f.angle));
    const s = Math.abs(Math.sin(f.angle));
    const ex = (c * f.W) / 2 + (s * f.H) / 2 + pad;
    const ey = (s * f.W) / 2 + (c * f.H) / 2 + pad;
    const bx = Math.max(0, f.cx - ex);
    const by = Math.max(0, f.cy - ey);
    const bw = Math.min(cw, f.cx + ex) - bx;
    const bh = Math.min(ch, f.cy + ey) - by;
    if (bw <= 0 || bh <= 0) return;

    ctx.save();
    capsulePath(ctx, f.W, f.H);
    ctx.clip();
    ctx.setTransform(-1, 0, 0, 1, cw, 0); // mirror, matching the CSS-flipped video
    ctx.filter = `blur(${Math.round(ch / 90)}px) brightness(0.7) saturate(1.2)`;
    const dx = cw - (bx + bw);
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    ctx.drawImage(video, (dx / cw) * vw, (by / ch) * vh, (bw / cw) * vw, (bh / ch) * vh, dx, by, bw, bh);
    ctx.restore();
  }

  /** Animated dashed link from each holding hand's grab point to the waveform. */
  private drawTethers(ctx: CanvasRenderingContext2D, obj: HoloObject, f: BodyFrame, vis: VisualState, t: number): void {
    if (obj.stretch || obj.holders.length !== 1 || vis.grab < 0.05) return;
    const { width: cw, height: ch } = ctx.canvas;
    const u = ch / 720;
    const hand = viewToPixels(obj.holdPoints[0], cw, ch);
    const color = hexToRgb(HAND_COLORS[obj.holders[0]]);

    // Nearest point on the capsule's core.
    const tx = clamp(hand.x, f.cx - f.W / 2 + f.H / 2, f.cx + f.W / 2 - f.H / 2);
    const ty = clamp(hand.y, f.cy - f.H / 2, f.cy + f.H / 2);
    const dist = Math.hypot(hand.x - tx, hand.y - ty);

    ctx.save();
    ctx.globalAlpha = vis.grab;
    if (dist > u * 6) {
      ctx.beginPath();
      ctx.moveTo(hand.x, hand.y);
      ctx.lineTo(tx, ty);
      ctx.setLineDash([u * 4, u * 5]);
      ctx.lineDashOffset = -t * u * 40;
      ctx.strokeStyle = rgba(color, 0.75);
      ctx.lineWidth = u * 1.4;
      ctx.shadowColor = rgba(color, 1);
      ctx.shadowBlur = u * 8;
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.beginPath();
      ctx.arc(tx, ty, u * 3, 0, Math.PI * 2);
      ctx.fillStyle = rgba(color, 0.9);
      ctx.fill();
    }

    // Diamond at the grab point.
    const d = u * 6;
    ctx.beginPath();
    ctx.moveTo(hand.x, hand.y - d);
    ctx.lineTo(hand.x + d, hand.y);
    ctx.lineTo(hand.x, hand.y + d);
    ctx.lineTo(hand.x - d, hand.y);
    ctx.closePath();
    ctx.strokeStyle = rgba(color, 1);
    ctx.lineWidth = u * 1.5;
    ctx.stroke();
    ctx.restore();
  }

  /** Glowing anchor nodes where each hand holds a stretched waveform. */
  private drawStretchNodes(ctx: CanvasRenderingContext2D, obj: HoloObject, f: BodyFrame): void {
    const { width: cw, height: ch } = ctx.canvas;
    const u = ch / 720;
    obj.holders.forEach((hand, i) => {
      const p = viewToPixels(obj.holdPoints[i] ?? obj.stretch!.ends[i], cw, ch);
      const color = hexToRgb(HAND_COLORS[hand]);
      ctx.save();
      ctx.shadowColor = rgba(color, 1);
      ctx.shadowBlur = u * 12;
      ctx.beginPath();
      ctx.arc(p.x, p.y, f.H * 0.16, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(color, 1);
      ctx.lineWidth = u * 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, p.y, f.H * 0.06, 0, Math.PI * 2);
      ctx.fillStyle = rgba(color, 1);
      ctx.fill();
      ctx.restore();
    });
  }
}

function readout(obj: HoloObject, mix: StemMix | undefined, muted: boolean): string {
  if (muted) return 'MUTED';
  if (obj.stretch) return `STRETCH ${Math.round(obj.stretch.amount * 100)}%`;
  if (!mix) return '';
  const pan = Math.round(mix.pan * 100);
  const panText = Math.abs(pan) < 3 ? 'C' : pan < 0 ? `L${-pan}` : `R${pan}`;
  return `PAN ${panText}  VOL ${Math.round(mix.volume * 100)}`;
}

/** Pill-shaped path centered on the origin. */
function capsulePath(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  const r = H / 2;
  ctx.beginPath();
  ctx.moveTo(-W / 2 + r, -r);
  ctx.lineTo(W / 2 - r, -r);
  ctx.arc(W / 2 - r, 0, r, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(-W / 2 + r, r);
  ctx.arc(-W / 2 + r, 0, r, Math.PI / 2, (3 * Math.PI) / 2);
  ctx.closePath();
}

function detectFilter(ctx: CanvasRenderingContext2D): boolean {
  if (!('filter' in ctx)) return false;
  ctx.save();
  ctx.filter = 'blur(2px)';
  const ok = ctx.filter === 'blur(2px)';
  ctx.restore();
  return ok;
}

function setLetterSpacing(ctx: CanvasRenderingContext2D, value: string): void {
  const c = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  if ('letterSpacing' in c) c.letterSpacing = value;
}

function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function desaturate(c: RGB, t: number): RGB {
  const g = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
  return mixRgb(c, [g, g, g], t);
}

function rgba(c: RGB, a: number): string {
  return `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${Math.min(1, Math.max(0, a)).toFixed(3)})`;
}

function easeOut(x: number): number {
  return 1 - (1 - x) ** 3;
}

function fract(x: number): number {
  return x - Math.floor(x);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

