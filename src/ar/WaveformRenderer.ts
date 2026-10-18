import { viewToPixels, type Point2 } from '../perception';
import {
  CAP_GAP,
  CAP_RADIUS,
  capCenter,
  effectiveHalfHeight,
  effectiveHalfWidth,
  hasCap,
  LEVEL_HANDLE_ENABLED,
  levelHandle,
  type HoloObject,
  type StemControl,
} from './HoloObject';
import { ProceduralWaveforms, type LoopView, type WaveformSource } from './waveforms';

export interface RenderOptions {
  /** Webcam video, used to draw a faint frosted backing behind each waveform. */
  backdrop?: HTMLVideoElement;
}

const HAND_COLORS = { Left: '#4fc3f7', Right: '#ffb74d' } as const;
/** Ghost size while pulling a clip out (matches CLIP_HALF_SIZE). */
const CLIP_GHOST = { x: 0.11, y: 0.045 };
const SAMPLES = 128;
/** Playhead sweeps across the waveform this many times per second (fallback data only). */
const PLAYHEAD_SPEED = 0.25;
/** Duration of the grab flash (ms). */
const FLASH_MS = 380;
/** Motion trail length (frames). */
const TRAIL = 6;
/** Deck fader bars' opacity while no hand is on or near them. */
const BAR_IDLE_ALPHA = 0.8;

interface VisualState {
  hover: number;
  handle: number;
  grab: number;
  /** 1 when not audible (muted, or silenced by another stem's solo). */
  silent: number;
  intent: number;
  lastT: number;
  dt: number;
  wasHeld: boolean;
  grabAt: number;
  /** 1 while this stem is being manipulated (it grows); 0 otherwise. */
  focus: number;
  /** 1 while another stem is being manipulated (this one steps back). */
  recede: number;
  /** 0 -> 1 as a returned clip merges back into its stem. */
  ret: number;
  /** Rendered rotation; follows the hands while stretching, eases flat after. */
  angle: number;
  /** Recent on-screen centers, oldest first. */
  trail: Point2[];
}

interface BodyFrame {
  cx: number;
  cy: number;
  W: number;
  H: number;
  angle: number;
}

type RGB = [number, number, number];

/**
 * Draws stems as floating holographic waveforms with a level fader.
 * Pure visuals: reads HoloObject state (including its mirror of the engine's
 * authoritative audio state) and never mutates it.
 *
 * Visual states:
 *   idle      faint layered waveform, no outline
 *   hover     thin outline appears, readout fades in
 *   targeted  outline brightens and tightens as the hand closes
 *   grabbed   lifts, outline + badge in the owning hand's color
 *   stretched outline split between both hands' colors, FX readout
 *   level     fader lights up with a large VOL readout
 *   silent    dimmed and desaturated (muted, or another stem is soloed)
 */
export class WaveformRenderer {
  /** Opacity of the object being drawn (dim idle fader bars). */
  private dim = 1;
  private visuals = new Map<string, VisualState>();
  private peaks = new Float32Array(SAMPLES);
  private filterSupported: boolean | null = null;
  /** Beat pulse, 1 on the beat decaying to 0 (set by the scene each frame). */
  pulse = 0;
  /** Build energy 0..1 (engine's build amount): waveforms charge up and shiver. */
  energy = 0;
  /** Drop impact 1 -> 0 over a moment after the drop lands: waveforms burst outward. */
  impact = 0;
  private smoothed = new Float32Array(SAMPLES);

  constructor(private source: WaveformSource = new ProceduralWaveforms()) {}

  render(ctx: CanvasRenderingContext2D, objects: HoloObject[], timeMs: number, opts: RenderOptions = {}): void {
    if (this.filterSupported === null) this.filterSupported = detectFilter(ctx);
    const t = timeMs / 1000;

    const active = (o: HoloObject) => o.holders.length > 0 || o.control !== null;
    const anyActive = objects.some(active);
    const entries = objects.map((obj) => {
      const vis = this.animate(obj, timeMs);
      const k = 1 - Math.exp(-vis.dt * 10);
      vis.focus += ((active(obj) ? 1 : 0) - vis.focus) * k;
      vis.recede += ((anyActive && !active(obj) ? 1 : 0) - vis.recede) * k;
      vis.ret += ((obj.returning ? 1 : 0) - vis.ret) * (1 - Math.exp(-vis.dt * 6));
      return { obj, vis };
    });
    // Held objects draw on top.
    entries.sort((a, b) => a.vis.grab - b.vis.grab);

    for (const { obj, vis } of entries) {
      // Deck fader bars stay dim in the background until a hand is on or near one.
      this.dim = obj.vertical ? BAR_IDLE_ALPHA + (1 - BAR_IDLE_ALPHA) * Math.max(vis.focus, vis.hover) : 1;
      ctx.save();
      ctx.globalAlpha = this.dim;
      const frame = this.bodyFrame(ctx, obj, vis);
      if (!this.source.peaks(obj.id, this.peaks, t)) this.peaks.fill(0.05);
      this.shapeForFilter(obj.audio.filter);
      if (!obj.locked) this.drawTrail(ctx, obj, frame, vis);
      if (!obj.vertical) this.drawReflection(ctx, obj, frame, vis);
      this.drawBody(ctx, obj, frame, vis, t, opts);
      if (!obj.stretch && !obj.returning) {
        if (hasCap(obj, 'loop')) this.drawCap(ctx, obj, frame, vis, 'loop', t);
        if (hasCap(obj, 'filter')) this.drawCap(ctx, obj, frame, vis, 'filter', t);
      }
      if (obj.clipPreview) this.drawClipGhost(ctx, obj, vis);
      if (obj.twist !== null) this.drawTwistDial(ctx, obj);
      if (LEVEL_HANDLE_ENABLED) this.drawLevelHandle(ctx, obj, frame, vis);
      if (obj.stretch) this.drawStretchNodes(ctx, obj, frame);
      ctx.restore();
    }
    this.dim = 1;
  }

  private animate(obj: HoloObject, timeMs: number): VisualState {
    const vis: VisualState = this.visuals.get(obj.id) ?? {
      hover: 0, handle: 0, grab: 0, silent: 0, intent: 0, focus: 0, recede: 0, ret: 0, lastT: timeMs, dt: 0,
      wasHeld: false, grabAt: -1e9, angle: 0, trail: [],
    };
    const dt = Math.min(0.1, Math.max(0, (timeMs - vis.lastT) / 1000));
    vis.lastT = timeMs;
    vis.dt = dt;
    const k = 1 - Math.exp(-dt * 14);
    const held = obj.holders.length > 0;
    vis.hover += (obj.hover - vis.hover) * k;
    vis.handle += ((obj.levelHand ? 1 : obj.handleHover * 0.6) - vis.handle) * k;
    vis.grab += ((held ? 1 : 0) - vis.grab) * k;
    // Inaudible stems go fully dim; quiet ones dim partway, so volume reads at a glance.
    const quiet = 0.6 * (1 - Math.min(1, Math.max(0, obj.audio.volume)));
    vis.silent += ((obj.audio.ducked ? 0.85 : obj.audio.audible ? quiet : 1) - vis.silent) * k;
    vis.intent += (obj.intent - vis.intent) * (1 - Math.exp(-dt * 25));
    if (held && !vis.wasHeld) vis.grabAt = timeMs;
    vis.wasHeld = held;
    this.visuals.set(obj.id, vis);
    return vis;
  }

  private bodyFrame(ctx: CanvasRenderingContext2D, obj: HoloObject, vis: VisualState): BodyFrame {
    const { width: cw, height: ch } = ctx.canvas;
    const flash = Math.max(0, 1 - (vis.lastT - vis.grabAt) / FLASH_MS);
    // Slight squeeze as the hand closes, then a springy pop on grab.
    // The stem you're working with grows; the others step back.
    // Fader bars hold their shape (no hover / grab / focus wobble); they react with glow and fill instead.
    const scale = obj.locked
      ? 1
      : (1 + 0.03 * vis.hover - 0.03 * vis.intent * (1 - vis.grab) + 0.05 * flash * flash + 0.12 * this.impact) *
        (1 + 0.12 * vis.focus - 0.1 * vis.recede) *
        (1 - 0.8 * vis.ret);
    const W = effectiveHalfWidth(obj) * 2 * ch * scale;
    // Locked stems stretch taller; free ones stretch wider (and get a little thinner).
    const H = obj.locked
      ? effectiveHalfHeight(obj) * 2 * ch * scale
      : obj.halfSize.y * 2 * ch * scale * (1 - 0.25 * obj.stretchAmount);

    if (obj.stretch && !obj.locked) {
      const a = viewToPixels(obj.stretch.ends[0], cw, ch);
      const b = viewToPixels(obj.stretch.ends[1], cw, ch);
      let angle = Math.atan2(b.y - a.y, b.x - a.x);
      if (angle > Math.PI / 2) angle -= Math.PI; // keep text upright
      if (angle < -Math.PI / 2) angle += Math.PI;
      vis.angle = angle;
    } else {
      vis.angle *= Math.exp(-vis.dt * 8);
    }

    const c = viewToPixels({ x: obj.position.x + obj.drift.x, y: obj.position.y + obj.drift.y }, cw, ch);
    // Charged stems shiver slightly with the build.
    if (this.energy > 0.05 && !obj.locked) {
      const amp = (ch / 720) * 2.2 * this.energy * this.energy;
      c.x += amp * Math.sin(vis.lastT * 0.061 + obj.id.length * 1.7);
      c.y += amp * Math.cos(vis.lastT * 0.073 + obj.id.length);
    }
    vis.trail.push(c);
    if (vis.trail.length > TRAIL) vis.trail.shift();
    return { cx: c.x, cy: c.y, W, H, angle: vis.angle };
  }

  /** Fading ghost outlines at recent positions while the waveform moves. */
  private drawTrail(ctx: CanvasRenderingContext2D, obj: HoloObject, f: BodyFrame, vis: VisualState): void {
    const u = ctx.canvas.height / 720;
    const base = hexToRgb(obj.color);
    const { x0, x1, amp } = this.waveGeometry(obj, f, 0);
    const n = vis.trail.length - 1;
    for (let i = 0; i < n; i++) {
      const p = vis.trail[i];
      if (Math.hypot(p.x - f.cx, p.y - f.cy) < u * 3) continue;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(f.angle);
      ctx.strokeStyle = rgba(base, 0.14 * ((i + 1) / n) * (1 - 0.6 * vis.silent));
      ctx.lineWidth = u;
      for (const s of [-1, 1]) {
        this.contour(ctx, x0, x1, amp, s);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  private waveGeometry(obj: HoloObject, f: BodyFrame, live: number): { x0: number; x1: number; amp: number } {
    // Height reflects the fader so level changes are visible at a glance (bars show it as their fill instead).
    const level = obj.vertical ? 1 : 0.3 + 0.7 * obj.audio.volume;
    const charge = 1 + 0.35 * this.energy + 0.3 * this.impact;
    return {
      x0: -f.W / 2 + f.H * 0.45,
      x1: f.W / 2 - f.H * 0.45,
      amp: f.H * 0.36 * level * (0.92 + 0.2 * live) * charge,
    };
  }

  private contour(ctx: CanvasRenderingContext2D, x0: number, x1: number, amp: number, sign: number, scale = 1): void {
    ctx.beginPath();
    for (let i = 0; i < SAMPLES; i++) {
      const x = x0 + ((x1 - x0) * i) / (SAMPLES - 1);
      const y = sign * this.peaks[i] * amp * scale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  }

  /** Soft glow pooled on the "floor" under each stem, flaring on the beat. */
  private drawReflection(ctx: CanvasRenderingContext2D, obj: HoloObject, f: BodyFrame, vis: VisualState): void {
    const base = desaturate(hexToRgb(obj.color), 0.7 * vis.silent);
    const rx = f.W * 0.55;
    const ry = f.H * 0.28;
    const a = (0.16 + 0.14 * this.pulse + 0.1 * vis.grab) * (1 - 0.7 * vis.silent);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(f.cx, f.cy + f.H * 0.95);
    ctx.scale(1, ry / rx);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    g.addColorStop(0, rgba(base, a));
    g.addColorStop(1, rgba(base, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawBody(
    ctx: CanvasRenderingContext2D,
    obj: HoloObject,
    f: BodyFrame,
    vis: VisualState,
    t: number,
    opts: RenderOptions,
  ): void {
    const u = ctx.canvas.height / 720; // design px -> canvas px
    const { W, H } = f;
    const base = desaturate(hexToRgb(obj.color), 0.7 * vis.silent);
    const bright = mixRgb(base, [255, 255, 255], 0.35);
    const holders = obj.holders.map((h) => hexToRgb(HAND_COLORS[h]));
    const live = this.source.level?.(obj.id) ?? 0;
    const glow = (0.35 + 0.35 * vis.hover + 0.35 * vis.intent + 0.6 * vis.grab + 0.5 * live + 0.3 * this.pulse + 0.6 * this.energy + 0.9 * this.impact) * (1 - 0.65 * vis.silent);
    const engaged = Math.max(vis.hover, vis.grab, vis.intent);

    ctx.save();
    ctx.globalAlpha = this.dim * (1 - 0.55 * vis.silent) * (1 - 0.3 * vis.recede) * (1 - vis.ret);
    ctx.translate(f.cx, f.cy);
    ctx.rotate(f.angle);

    // --- Faint backing: just enough contrast over the webcam -----------------
    this.frost(ctx, f, opts.backdrop);
    capsulePath(ctx, W, H);
    const tint = ctx.createLinearGradient(0, -H / 2, 0, H / 2);
    const tintAlpha = this.filterSupported && opts.backdrop ? 0.22 : 0.32;
    tint.addColorStop(0, `rgba(6,8,20,${tintAlpha * 0.6})`);
    tint.addColorStop(0.5, `rgba(6,8,20,${tintAlpha})`);
    tint.addColorStop(1, `rgba(6,8,20,${tintAlpha * 0.6})`);
    ctx.fillStyle = tint;
    ctx.fill();

    // Outline only when interacting: hover -> thin, grab -> owner's color.
    if (engaged > 0.02) {
      let stroke: string | CanvasGradient = rgba(base, 0.5 * engaged);
      if (holders.length === 1) stroke = rgba(holders[0], 0.35 + 0.6 * vis.grab);
      if (holders.length === 2) {
        const g = ctx.createLinearGradient(-W / 2, 0, W / 2, 0);
        g.addColorStop(0, rgba(holders[0], 0.95));
        g.addColorStop(1, rgba(holders[1], 0.95));
        stroke = g;
      }
      ctx.save();
      ctx.shadowColor = rgba(base, 0.9);
      ctx.shadowBlur = u * 10 * glow;
      capsulePath(ctx, W, H);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = u * (0.8 + 0.8 * vis.grab);
      ctx.stroke();
      ctx.restore();
    }

    // Subtle flash on grab.
    const age = (vis.lastT - vis.grabAt) / FLASH_MS;
    if (age >= 0 && age < 1 && holders.length && !obj.locked) {
      const grow = 1 + 0.15 * easeOut(age);
      ctx.save();
      ctx.scale(grow, 1 + (grow - 1) * 2);
      capsulePath(ctx, W, H);
      ctx.strokeStyle = rgba(holders[0], 0.6 * (1 - age));
      ctx.lineWidth = (u * 1.5) / grow;
      ctx.stroke();
      ctx.restore();
    }

    // --- Layered waveform -------------------------------------------------------
    // Bars draw the same waveform turned upright (time runs bottom to top).
    const wf = obj.vertical ? { ...f, W: H, H: W } : f;
    ctx.save();
    if (obj.vertical) {
      // Fader bar: the waveform only shows in the filled part, so it rises and falls with the volume.
      const vol = obj.volumeAdjust ?? obj.audio.volume;
      ctx.beginPath();
      ctx.rect(-W / 2, H / 2 - vol * H, W, vol * H);
      ctx.clip();
      ctx.rotate(-Math.PI / 2);
    }
    const { x0, x1, amp } = this.waveGeometry(obj, wf, live);

    // Depth layers: larger, fainter, slightly offset copies behind the main one.
    for (const [scale, dy, alpha] of [[1.35, wf.H * 0.06, 0.1], [1.15, wf.H * 0.03, 0.18]] as const) {
      ctx.save();
      ctx.translate(0, dy);
      ctx.strokeStyle = rgba(base, alpha * (0.6 + 0.6 * live));
      ctx.lineWidth = u;
      for (const s of [-1, 1]) {
        this.contour(ctx, x0, x1, amp, s, scale);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Filled envelope.
    ctx.beginPath();
    for (let i = 0; i < SAMPLES; i++) ctx.lineTo(x0 + ((x1 - x0) * i) / (SAMPLES - 1), -this.peaks[i] * amp);
    for (let i = SAMPLES - 1; i >= 0; i--) ctx.lineTo(x0 + ((x1 - x0) * i) / (SAMPLES - 1), this.peaks[i] * amp);
    ctx.closePath();
    const fill = ctx.createLinearGradient(0, -amp, 0, amp);
    fill.addColorStop(0, rgba(base, 0.03));
    fill.addColorStop(0.5, rgba(base, 0.2 + 0.15 * vis.grab + 0.15 * live));
    fill.addColorStop(1, rgba(base, 0.03));
    ctx.fillStyle = fill;
    ctx.fill();

    // Neon outline: soft bloom pass, then thin bright core lit at the playhead.
    const p = this.source.playhead?.(obj.id) ?? fract(t * PLAYHEAD_SPEED);
    const line = ctx.createLinearGradient(x0, 0, x1, 0);
    line.addColorStop(0, rgba(base, 0.5));
    line.addColorStop(Math.max(0, p - 0.12), rgba(base, 0.75));
    line.addColorStop(p, rgba(bright, 1));
    line.addColorStop(Math.min(1, p + 0.015), rgba(base, 0.6));
    line.addColorStop(1, rgba(base, 0.45));

    ctx.save();
    ctx.shadowColor = rgba(base, 1);
    ctx.shadowBlur = u * 14 * glow;
    ctx.strokeStyle = rgba(base, 0.22 * glow + 0.08);
    ctx.lineWidth = u * 3;
    for (const s of [-1, 1]) {
      this.contour(ctx, x0, x1, amp, s);
      ctx.stroke();
    }
    ctx.restore();

    ctx.strokeStyle = line;
    ctx.lineWidth = u * (1.1 + 0.4 * vis.grab);
    for (const s of [-1, 1]) {
      this.contour(ctx, x0, x1, amp, s);
      ctx.stroke();
    }

    // Playhead.
    const px = x0 + (x1 - x0) * p;
    ctx.beginPath();
    ctx.moveTo(px, -wf.H * 0.42);
    ctx.lineTo(px, wf.H * 0.42);
    ctx.strokeStyle = rgba(bright, 0.35);
    ctx.lineWidth = u;
    ctx.stroke();

    const loop = this.source.loop?.(obj.id) ?? null;
    if (loop) this.drawLoopRegion(ctx, loop, x0, x1, wf.H, base, u);
    else if (obj.loopPreview) this.drawLoopPreview(ctx, obj.loopPreview, x0, x1, wf.H, base, u);
    ctx.restore();

    if (obj.locked) this.drawVolumeFill(ctx, obj, W, H, base, u);

    if (obj.vertical) {
      this.drawBarLabels(ctx, obj, H, bright, u);
      ctx.restore();
      return;
    }

    // --- Labels ------------------------------------------------------------------
    // Label size follows the stem's base height, so stretching a locked stem taller doesn't blow up its text.
    const baseH = obj.locked ? H / (effectiveHalfHeight(obj) / obj.halfSize.y) : H;
    const fs = Math.max(u * 10, baseH * 0.14);
    const ty = -H / 2 - fs * 0.9;
    ctx.font = `600 ${fs}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.textBaseline = 'middle';
    setLetterSpacing(ctx, `${(fs * 0.12).toFixed(1)}px`);

    ctx.textAlign = 'left';
    const labelX = -W / 2 + H * 0.3;
    // Live level meter: five segments before the name (actual output level).
    const lit = Math.round(live * 5 * (obj.audio.audible ? 1 : 0));
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = rgba(i < lit ? bright : base, i < lit ? 0.9 : 0.18);
      ctx.fillRect(labelX + i * fs * 0.28, ty + fs * 0.35 - fs * 0.14 * (i + 1), fs * 0.18, fs * 0.14 * (i + 1));
    }
    const nameX = labelX + fs * 1.6;
    ctx.fillStyle = rgba(bright, 0.85);
    ctx.fillText(obj.label.toUpperCase(), nameX, ty);

    // Owner badges: which hand(s) hold this stem.
    let bx = nameX + ctx.measureText(obj.label.toUpperCase()).width + fs * 0.9;
    obj.holders.forEach((hand, i) => {
      ctx.beginPath();
      ctx.arc(bx, ty, fs * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = rgba(holders[i], 0.9);
      ctx.fill();
      ctx.fillStyle = 'rgba(6,8,20,0.95)';
      ctx.textAlign = 'center';
      setLetterSpacing(ctx, '0px');
      ctx.fillText(hand[0], bx, ty + fs * 0.04);
      bx += fs * 1.35;
    });

    // Readout: always for silent/solo stems, otherwise only while interacting.
    const status = statusText(obj);
    const persistent = status ?? performanceText(obj);
    const readoutAlpha = persistent ? 0.9 : Math.max(vis.hover, vis.grab, vis.handle) * 0.8;
    if (readoutAlpha > 0.02) {
      setLetterSpacing(ctx, `${(fs * 0.12).toFixed(1)}px`);
      ctx.textAlign = 'right';
      ctx.fillStyle = `rgba(230,236,255,${readoutAlpha.toFixed(3)})`;
      const text = [status, performanceText(obj) ?? readout(obj)].filter(Boolean).join(' · ');
      const right = W / 2 - H * 0.3;
      // Not enough room beside the name (long song titles): put it on its own line above.
      const fits = right - ctx.measureText(text).width > bx + fs * 0.4;
      ctx.fillText(text, right, fits ? ty : ty - fs * 1.3);
    }

    setLetterSpacing(ctx, '0px');
    ctx.restore();
  }

  /**
   * Make the waveform look like the filter sounds: lowpass smooths it out
   * (fewer transients), highpass leaves thin spiky transients.
   */
  private shapeForFilter(f: number): void {
    if (Math.abs(f) < 0.01) return;
    const w = Math.max(1, Math.round(1 + 9 * Math.abs(f)));
    const p = this.peaks;
    const sm = this.smoothed;
    for (let i = 0; i < SAMPLES; i++) {
      let sum = 0;
      let n = 0;
      for (let k = -w; k <= w; k++) {
        const j = i + k;
        if (j < 0 || j >= SAMPLES) continue;
        sum += p[j];
        n++;
      }
      sm[i] = sum / n;
    }
    for (let i = 0; i < SAMPLES; i++) {
      if (f < 0) p[i] = (p[i] + (sm[i] - p[i]) * -f) * (1 + 0.3 * f);
      else p[i] = Math.max(0.03, p[i] * (1 - 0.55 * f) + 1.2 * f * Math.max(0, p[i] - sm[i]));
    }
  }

  /** Engaged loop: current pass highlighted, boundaries marked, progress sweep. Pending: dashed region. */
  private drawLoopRegion(
    ctx: CanvasRenderingContext2D,
    loop: LoopView,
    x0: number,
    x1: number,
    H: number,
    base: RGB,
    u: number,
  ): void {
    const X = (f: number) => x0 + (x1 - x0) * Math.min(1, Math.max(0, f));
    const top = -H * 0.44;
    const bottom = H * 0.44;
    const bright = mixRgb(base, [255, 255, 255], 0.55);
    ctx.save();
    if (loop.engaged) {
      const [a, b] = loop.region;
      const band = ctx.createLinearGradient(0, top, 0, bottom);
      band.addColorStop(0, rgba(bright, 0.04));
      band.addColorStop(0.5, rgba(bright, 0.16));
      band.addColorStop(1, rgba(bright, 0.04));
      ctx.fillStyle = band;
      ctx.fillRect(X(a), top, X(b) - X(a), bottom - top);
      // Progress through the current pass.
      ctx.fillStyle = rgba(bright, 0.12);
      ctx.fillRect(X(a), bottom - u * 3, (X(b) - X(a)) * loop.progress, u * 3);
      ctx.strokeStyle = rgba(bright, 0.85);
      ctx.lineWidth = u * 1.2;
      for (const m of loop.marks) {
        ctx.beginPath();
        ctx.moveTo(X(m), top);
        ctx.lineTo(X(m), bottom);
        ctx.stroke();
      }
    } else {
      ctx.setLineDash([u * 3, u * 3]);
      ctx.strokeStyle = rgba(bright, 0.7);
      ctx.lineWidth = u;
      const [a, b] = loop.region;
      ctx.strokeRect(X(a), top, X(b) - X(a), bottom - top);
    }
    ctx.restore();
  }

  /** While choosing a loop length: the span it would cover, starting at the playhead. */
  private drawLoopPreview(ctx: CanvasRenderingContext2D, beats: number, x0: number, x1: number, H: number, base: RGB, u: number): void {
    const bpm = this.source.beat?.()?.bpm;
    const win = this.source.windowSeconds?.();
    if (!bpm || !win) return;
    const width = ((beats * 60) / bpm / win) * (x1 - x0);
    const px = x0 + (x1 - x0) * 0.5;
    ctx.save();
    ctx.setLineDash([u * 4, u * 3]);
    ctx.strokeStyle = rgba(mixRgb(base, [255, 255, 255], 0.6), 0.9);
    ctx.lineWidth = u * 1.2;
    ctx.strokeRect(px, -H * 0.44, Math.min(width, x1 - px), H * 0.88);
    ctx.restore();
  }

  /**
   * End-cap controls. Loop (left): ring with a return arrow; shows the
   * chosen / active length. Filter (right): knob whose arc shows the
   * filter: left half = lowpass, right half = highpass.
   */
  private drawCap(
    ctx: CanvasRenderingContext2D,
    obj: HoloObject,
    f: BodyFrame,
    vis: VisualState,
    kind: StemControl,
    t: number,
  ): void {
    const ch = ctx.canvas.height;
    const u = ch / 720;
    const r = CAP_RADIUS * ch;
    const c = capCenter(obj, kind);
    const k = obj.vertical ? f.H / (effectiveHalfHeight(obj) * 2 * ch) : f.W / (effectiveHalfWidth(obj) * 2 * ch);
    const x = c.dx * ch * k;
    const y = c.dy * ch * k;
    const base = desaturate(hexToRgb(obj.color), 0.7 * vis.silent);
    const bright = mixRgb(base, [255, 255, 255], 0.5);
    const held = obj.control?.kind === kind;
    const hover = obj.capHover[kind];
    const active = kind === 'loop' ? obj.audio.loop !== null : Math.abs(obj.audio.filter) > 0.01;
    const alpha = Math.min(1, 0.28 + 0.5 * hover + (held ? 0.6 : 0) + (active ? 0.35 : 0) + 0.2 * vis.hover);

    ctx.save();
    ctx.translate(f.cx, f.cy);
    ctx.rotate(f.angle);
    ctx.translate(x, y);
    ctx.globalAlpha = this.dim * alpha * (1 - 0.5 * vis.silent);
    const scale = 1 + 0.15 * hover + (held ? 0.25 : 0);
    ctx.scale(scale, scale);

    // Glass disc.
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(6,8,20,0.45)';
    ctx.fill();
    ctx.lineWidth = u * (held ? 2 : 1.2);
    ctx.strokeStyle = held && obj.control ? HAND_COLORS[obj.control.hand] : rgba(base, 0.9);
    if (held || hover > 0.9) {
      ctx.shadowColor = rgba(base, 1);
      ctx.shadowBlur = u * 12;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    const fs = r * 0.62;
    ctx.font = `700 ${fs}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Hints go under the cap, extending toward the screen center so they never clip at an edge.
    const inward: CanvasTextAlign = f.cx + x < ctx.canvas.width / 2 ? 'left' : 'right';
    // Bars: beside the cap (above/below is the label and status line).
    const hintX = obj.vertical ? (inward === 'left' ? r * 1.5 : -r * 1.5) : inward === 'left' ? -r * 0.2 : r * 0.2;
    const hintY = obj.vertical ? -fs * 0.55 : r * 1.7;
    const hint = (lines: [string, number][]) => {
      ctx.font = `600 ${fs * 0.8}px ui-monospace, "SF Mono", Menlo, monospace`;
      ctx.textAlign = inward;
      lines.forEach(([text, a], i) => {
        ctx.fillStyle = `rgba(235,242,255,${a})`;
        ctx.fillText(text, hintX, hintY + i * fs * 1.15);
      });
    };

    if (kind === 'loop') {
      const loop = obj.audio.loop;
      const shown = obj.loopPreview !== undefined ? obj.loopPreview : (loop?.beats ?? null);
      // Return arrow ring; spins while engaged.
      const spin = loop?.engaged ? t * 3 : 0;
      ctx.strokeStyle = rgba(bright, active || held ? 1 : 0.7);
      ctx.lineWidth = u * 1.6;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.62, spin + 0.4, spin + Math.PI * 1.75);
      ctx.stroke();
      const ax = Math.cos(spin + Math.PI * 1.75) * r * 0.62;
      const ay = Math.sin(spin + Math.PI * 1.75) * r * 0.62;
      ctx.beginPath();
      ctx.arc(ax, ay, u * 2, 0, Math.PI * 2);
      ctx.fillStyle = rgba(bright, 1);
      ctx.fill();
      ctx.fillStyle = rgba(bright, 1);
      ctx.fillText(shown === null ? '∞' : String(shown), 0, u * 0.5);
      if (held) {
        // What moving up / down will choose; applied on release.
        hint([
          [shown === null ? 'LOOP OFF' : `LOOP ${shown} BEAT${shown === 1 ? '' : 'S'}`, 0.95],
          ['▲ LONGER  ▼ OFF  · DRAG OUT = CLIP', 0.55],
        ]);
      } else if (loop && !loop.engaged) {
        hint([['ON NEXT BEAT', 0.8]]);
      } else if (hover > 0.9) {
        hint([['LOOP', 0.8]]);
      }
    } else {
      const v = obj.audio.filter;
      // Track arc (bottom-left = LP, bottom-right = HP), value arc from the top.
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = u * 2;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.7, Math.PI * 0.75, Math.PI * 2.25);
      ctx.stroke();
      if (Math.abs(v) > 0.01) {
        ctx.strokeStyle = rgba(v < 0 ? mixRgb(base, [255, 150, 90], 0.5) : mixRgb(base, [150, 220, 255], 0.5), 1);
        ctx.lineWidth = u * 2.6;
        ctx.beginPath();
        const mid = Math.PI * 1.5;
        ctx.arc(0, 0, r * 0.7, Math.min(mid, mid + v * Math.PI * 0.75), Math.max(mid, mid + v * Math.PI * 0.75));
        ctx.stroke();
      }
      const ang = Math.PI * 1.5 + v * Math.PI * 0.75;
      ctx.strokeStyle = rgba(bright, 1);
      ctx.lineWidth = u * 1.6;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(ang) * r * 0.5, Math.sin(ang) * r * 0.5);
      ctx.stroke();
      if (held) hint([[filterText(v), 0.95], ['▲ HIGHPASS  ▼ LOWPASS · TAP RESETS', 0.55]]);
      else if (hover > 0.9) hint([['FILTER', 0.8]]);
    }
    ctx.restore();
  }

  /** Bar labels: name centered above the filter cap, status centered below the loop cap. */
  private drawBarLabels(ctx: CanvasRenderingContext2D, obj: HoloObject, H: number, bright: RGB, u: number): void {
    const ch = ctx.canvas.height;
    const fs = u * 11;
    // Bars may still have caps later (pinch controls); leave room for them if so.
    const capSpan = hasCap(obj, 'filter') ? (CAP_GAP + 2 * CAP_RADIUS) * ch : 0;
    ctx.font = `600 ${fs}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    setLetterSpacing(ctx, `${(fs * 0.1).toFixed(1)}px`);
    ctx.fillStyle = rgba(bright, 0.9);
    const labelY = -H / 2 - capSpan - fs * 0.9;
    ctx.fillText(obj.label.toUpperCase(), 0, labelY);
    // Status (MUTED, loop/filter set from the decks screen) on a line above the name.
    const text = [statusText(obj), performanceText(obj)].filter(Boolean).join(' · ');
    if (text) {
      ctx.font = `600 ${fs * 0.85}px ui-monospace, "SF Mono", Menlo, monospace`;
      ctx.fillStyle = 'rgba(230,236,255,0.85)';
      ctx.fillText(text, 0, labelY - fs * 1.3);
    }
    setLetterSpacing(ctx, '0px');
  }

  /**
   * Locked stems are vertical faders, like the decks screen's stem bars: the
   * capsule fills from the bottom to the volume, with a level line. Brighter
   * (and labelled) while a hand is setting it.
   */
  private drawVolumeFill(ctx: CanvasRenderingContext2D, obj: HoloObject, W: number, H: number, base: RGB, u: number): void {
    const vol = obj.volumeAdjust ?? obj.audio.volume;
    const active = obj.volumeAdjust !== null;
    const top = H / 2 - H * vol;
    ctx.save();
    capsulePath(ctx, W, H);
    ctx.clip();
    const g = ctx.createLinearGradient(0, H / 2, 0, -H / 2);
    g.addColorStop(0, rgba(base, active ? 0.32 : 0.14));
    g.addColorStop(1, rgba(base, active ? 0.12 : 0.04));
    ctx.fillStyle = g;
    ctx.fillRect(-W / 2, top, W, H * vol);
    ctx.strokeStyle = rgba(mixRgb(base, [255, 255, 255], 0.5), active ? 0.9 : 0.35);
    ctx.lineWidth = u * (active ? 2 : 1);
    ctx.beginPath();
    ctx.moveTo(-W / 2, top);
    ctx.lineTo(W / 2, top);
    ctx.stroke();
    ctx.restore();
    if (obj.vertical) {
      // Grab handle: pinch here (it lights up when a hand is near).
      const hover = Math.max(obj.hover, active ? 1 : 0);
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(-W / 2 - u * 5, top - u * 4, W + u * 10, u * 8, u * 4);
      ctx.fillStyle = rgba(mixRgb(base, [255, 255, 255], 0.55), 0.35 + 0.6 * hover);
      if (hover > 0.05) {
        ctx.shadowColor = rgba(base, 1);
        ctx.shadowBlur = u * 12 * hover;
      }
      ctx.fill();
      ctx.restore();
    }
    // Lying stems show their volume while it's set; bars don't (their fill and handle show it).
    if (active && !obj.vertical) {
      const fs = Math.max(u * 12, H * 0.22);
      ctx.save();
      ctx.font = `700 ${fs}px ui-monospace, "SF Mono", Menlo, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(240,244,255,0.95)';
      ctx.shadowColor = rgba(base, 1);
      ctx.shadowBlur = u * 8;
      // Just above the fill line (bars), or centered (lying stems).
      const y = obj.vertical ? Math.max(-H / 2 + fs * 0.7, top - fs * 0.8) : 0;
      ctx.fillText(`VOL ${Math.round(vol * 100)}`, 0, y);
      ctx.restore();
    }
  }

  /** While pulling a loop out of a stem: a dashed ghost clip at the hand, tethered to the stem. */
  private drawClipGhost(ctx: CanvasRenderingContext2D, obj: HoloObject, vis: VisualState): void {
    const { width: cw, height: ch } = ctx.canvas;
    const u = ch / 720;
    const at = viewToPixels(obj.clipPreview!, cw, ch);
    const lc = capCenter(obj, 'loop');
    const cap = viewToPixels({ x: obj.position.x + lc.dx / (cw / ch), y: obj.position.y + lc.dy }, cw, ch);
    const base = desaturate(hexToRgb(obj.color), 0.7 * vis.silent);
    const bright = mixRgb(base, [255, 255, 255], 0.5);
    const W = CLIP_GHOST.x * 2 * ch;
    const H = CLIP_GHOST.y * 2 * ch;
    ctx.save();
    // Tether.
    ctx.setLineDash([u * 4, u * 4]);
    ctx.strokeStyle = rgba(base, 0.7);
    ctx.lineWidth = u * 1.5;
    ctx.beginPath();
    ctx.moveTo(cap.x, cap.y);
    ctx.lineTo(at.x, at.y);
    ctx.stroke();
    // Ghost capsule.
    ctx.translate(at.x, at.y);
    ctx.setLineDash([u * 5, u * 3]);
    capsulePath(ctx, W, H);
    ctx.fillStyle = 'rgba(6,8,20,0.35)';
    ctx.fill();
    ctx.shadowColor = rgba(base, 1);
    ctx.shadowBlur = u * 12;
    ctx.strokeStyle = rgba(bright, 0.95);
    ctx.lineWidth = u * 1.6;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
    const fs = u * 12;
    ctx.font = `700 ${fs}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = rgba(bright, 1);
    const beats = obj.loopPreview ?? 4;
    ctx.fillText(`⟲ ${beats} BEAT${beats === 1 ? '' : 'S'}`, 0, 0);
    ctx.font = `600 ${fs * 0.75}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.fillStyle = 'rgba(235,242,255,0.6)';
    ctx.fillText('OPEN TO DROP IT HERE', 0, H / 2 + fs);
    ctx.restore();
  }

  /** Knob dial around the fist while twisting a held stem's filter. */
  private drawTwistDial(ctx: CanvasRenderingContext2D, obj: HoloObject): void {
    const { width: cw, height: ch } = ctx.canvas;
    const u = ch / 720;
    const hold = obj.holdPoints[0];
    if (!hold) return;
    const c = viewToPixels(hold, cw, ch);
    const v = obj.twist ?? 0;
    const r = u * 30;
    const base = hexToRgb(obj.color);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = u * 3;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, Math.PI * 0.75, Math.PI * 2.25);
    ctx.stroke();
    const mid = Math.PI * 1.5;
    const end = mid + v * Math.PI * 0.75;
    ctx.strokeStyle = rgba(v < 0 ? mixRgb(base, [255, 150, 90], 0.5) : mixRgb(base, [150, 220, 255], 0.5), 1);
    ctx.shadowColor = rgba(base, 1);
    ctx.shadowBlur = u * 10;
    ctx.lineWidth = u * 4;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, Math.min(mid, end), Math.max(mid, end));
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.font = `700 ${u * 12}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(235,242,255,0.95)';
    ctx.fillText(filterText(v), c.x, c.y - r - u * 12);
    ctx.font = `600 ${u * 9}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.fillStyle = 'rgba(235,242,255,0.55)';
    ctx.fillText('↻ HP  ↺ LP', c.x, c.y + r + u * 12);
    ctx.restore();
  }

  /** Vertical fader right of the body: fill = volume, inner bar = live level. */
  private drawLevelHandle(ctx: CanvasRenderingContext2D, obj: HoloObject, f: BodyFrame, vis: VisualState): void {
    if (obj.stretch) return;
    const ch = ctx.canvas.height;
    const u = ch / 720;
    const { dx, halfLength, knobDy } = levelHandle(obj);
    const x = dx * ch;
    const L = halfLength * ch;
    const ky = knobDy * ch;
    const base = desaturate(hexToRgb(obj.color), 0.7 * vis.silent);
    const active = vis.handle;
    const live = this.source.level?.(obj.id) ?? 0;

    ctx.save();
    ctx.translate(f.cx, f.cy);
    ctx.rotate(f.angle);
    ctx.globalAlpha = this.dim * (0.55 + 0.45 * Math.max(active, vis.hover)) * (1 - 0.4 * vis.silent);

    // Track.
    ctx.lineCap = 'round';
    ctx.strokeStyle = `rgba(255,255,255,${0.16 + 0.2 * active})`;
    ctx.lineWidth = u * 3;
    ctx.beginPath();
    ctx.moveTo(x, -L);
    ctx.lineTo(x, L);
    ctx.stroke();

    // Fader fill (authoritative volume).
    ctx.strokeStyle = rgba(base, 0.85);
    ctx.beginPath();
    ctx.moveTo(x, L);
    ctx.lineTo(x, ky);
    ctx.stroke();

    // Live level meter beside it.
    if (live > 0.01) {
      ctx.strokeStyle = rgba(mixRgb(base, [255, 255, 255], 0.5), 0.7);
      ctx.lineWidth = u * 1.5;
      ctx.beginPath();
      ctx.moveTo(x + u * 5, L);
      ctx.lineTo(x + u * 5, L - 2 * L * live * obj.audio.volume);
      ctx.stroke();
    }

    // Knob.
    const r = u * (4 + 3 * active);
    ctx.beginPath();
    ctx.arc(x, ky, r, 0, Math.PI * 2);
    ctx.fillStyle = rgba(mixRgb(base, [255, 255, 255], 0.5), 1);
    if (active > 0.5) {
      ctx.shadowColor = rgba(base, 1);
      ctx.shadowBlur = u * 10;
    }
    ctx.fill();
    if (obj.levelHand) {
      ctx.strokeStyle = HAND_COLORS[obj.levelHand];
      ctx.lineWidth = u * 2;
      ctx.stroke();
    }

    // Big value readout while adjusting.
    if (active > 0.05) {
      const fs = u * (11 + 5 * active);
      ctx.shadowBlur = 0;
      ctx.font = `700 ${fs}px ui-monospace, "SF Mono", Menlo, monospace`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = `rgba(235,242,255,${active.toFixed(3)})`;
      ctx.fillText(`VOL ${Math.round(obj.audio.volume * 100)}`, x + u * 12, ky);
    }
    ctx.restore();
  }

  /** Faint frosted backing: blurred, darkened camera feed clipped to the capsule. */
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
    ctx.globalAlpha *= 0.7;
    ctx.setTransform(-1, 0, 0, 1, cw, 0); // mirror, matching the CSS-flipped video
    ctx.filter = `blur(${Math.round(ch / 90)}px) brightness(0.75)`;
    const dx = cw - (bx + bw);
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    ctx.drawImage(video, (dx / cw) * vw, (by / ch) * vh, (bw / cw) * vw, (bh / ch) * vh, dx, by, bw, bh);
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

/** Persistent status that should always be visible, or null. */
function statusText(obj: HoloObject): string | null {
  if (obj.audio.ducked) return 'CLIP OUT';
  if (obj.audio.muted) return 'MUTED';
  if (obj.audio.solo) return 'SOLO';
  if (!obj.audio.audible) return 'SOLO OFF';
  return null;
}

function filterText(v: number): string {
  if (Math.abs(v) < 0.01) return 'FILTER OFF';
  return `${v < 0 ? 'LP' : 'HP'} ${Math.round(Math.abs(v) * 100)}`;
}

/** Loop / filter state that stays visible while active. */
function performanceText(obj: HoloObject): string | null {
  const parts: string[] = [];
  // Clips always loop and say so in their name.
  if (obj.audio.loop && !obj.clipOf) parts.push(`LOOP ${obj.audio.loop.beats}`);
  if (Math.abs(obj.audio.filter) > 0.01) parts.push(filterText(obj.audio.filter));
  return parts.length ? parts.join(' · ') : null;
}

function readout(obj: HoloObject): string {
  const fx = Math.round(obj.audio.fx * 100);
  const fxText = fx > 0 ? `FX ${fx}` : '';
  if (!LEVEL_HANDLE_ENABLED) return fxText;
  const vol = `VOL ${Math.round(obj.audio.volume * 100)}`;
  return fxText ? `${vol} · ${fxText}` : vol;
}

/** Pill-shaped path centered on the origin. */
/** Pill centered on the origin; works lying (W > H) or standing (H > W). */
function capsulePath(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  const r = Math.min(W, H) / 2;
  const hw = W / 2 - r;
  const hh = H / 2 - r;
  ctx.beginPath();
  ctx.moveTo(-hw, -H / 2);
  ctx.lineTo(hw, -H / 2);
  ctx.arc(hw, -hh, r, -Math.PI / 2, 0);
  ctx.lineTo(W / 2, hh);
  ctx.arc(hw, hh, r, 0, Math.PI / 2);
  ctx.lineTo(-hw, H / 2);
  ctx.arc(-hw, hh, r, Math.PI / 2, Math.PI);
  ctx.lineTo(-W / 2, -hh);
  ctx.arc(-hw, -hh, r, Math.PI, (3 * Math.PI) / 2);
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
