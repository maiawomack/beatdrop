import { viewToPixels, type Point2 } from '../perception';
import { effectiveHalfWidth, type HoloObject } from './HoloObject';
import { BUILD_MIN, BUILD_TRAVEL, RELEASE_DROP_MIN, type BuildView } from './InteractionController';

/**
 * Neon holographic atmosphere around the stems: a color grade, a perspective
 * grid floor that scrolls with the beat, rising particles off loud waveforms,
 * a light beam between the two stems of a blend pair, and the build/drop
 * gesture: an energy ball and charge meter on the fist, and a shockwave
 * from where you slammed.
 *
 * Pure visuals. Reads stem state and beat info; never mutates anything.
 * Everything is drawn with additive blending and kept faint so hands and
 * grabbed stems stay the clearest things on screen.
 */

export interface NeonFrame {
  /** Seconds. */
  t: number;
  dt: number;
  /** Beat info from the audio engine, if known. */
  beat: { bpm: number; phase: number } | null;
  /** Live level per stem, 0..1. */
  level: (stemId: string) => number;
  /** Two stems currently held one-per-hand, and their isolation (0 = blended, 1 = isolated). */
  blend: { a: HoloObject; b: HoloObject; isolation: number } | null;
  /** Wall-clock ms (performance.timeOrigin based), comparable with dropAtMs. */
  nowMs: number;
  /** The live build gesture (requested value), if a hand holds the core. */
  build: BuildView | null;
  /** Engine's authoritative build state. */
  perf: { build: number; dropPending: boolean; dropAtMs: number | null; dropQuantized: boolean };
}

/** How long the drop impact animates (ms). */
const IMPACT_MS = 900;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  rgb: [number, number, number];
}

const MAX_PARTICLES = 260;
/** Floor horizon, as a fraction of canvas height. */
const HORIZON = 0.64;

export class NeonScene {
  private particles: Particle[] = [];
  private gridOffset = 0;
  private lastPhase = 0;
  /** 1 right on a beat, decaying to 0. */
  pulse = 0;
  /** Build energy from the engine, 0..1 (smoothed for visuals). */
  energy = 0;
  /** 1 at the moment the drop lands, decaying to 0 over IMPACT_MS. */
  impact = 0;
  private burstFor: number | null = null;
  /** Where the last build fist was, so the drop countdown and shockwave stay there after the hand opens. */
  private lastBuild: { from: Point2; point: Point2 } | null = null;

  /** Advance beat pulse and particles. Call once per drawn frame. */
  update(objects: HoloObject[], f: NeonFrame, cw: number, ch: number): void {
    // Beat pulse: kick to 1 when the phase wraps, then decay.
    if (f.beat) {
      if (f.beat.phase < this.lastPhase) this.pulse = 1;
      this.lastPhase = f.beat.phase;
    }
    this.pulse *= Math.exp(-f.dt * 6);
    this.energy += (f.perf.build - this.energy) * (1 - Math.exp(-f.dt * 10));

    // Drop impact, timed to when the drop reaches the speakers.
    const age = f.perf.dropAtMs !== null ? f.nowMs - f.perf.dropAtMs : -1;
    this.impact = age >= 0 && age < IMPACT_MS && !f.perf.dropPending ? 1 - age / IMPACT_MS : 0;
    if (f.build) this.lastBuild = { from: { ...f.build.from }, point: { ...f.build.point } };
    if (this.impact > 0 && this.burstFor !== f.perf.dropAtMs) {
      this.burstFor = f.perf.dropAtMs;
      this.pulse = 1;
      this.energy = 0;
      this.burst(this.origin(cw, ch), ch);
    }

    // Grid scrolls toward the viewer: one line spacing per beat (or slow drift), faster while building.
    const beatsPerSec = f.beat ? f.beat.bpm / 60 : 0.5;
    this.gridOffset = (this.gridOffset + f.dt * beatsPerSec * (1 + 3 * this.energy + 2 * this.impact)) % 1;

    // Emit sparks along each audible stem, more when it's loud or on the beat.
    for (const obj of objects) {
      if (!obj.audio.audible) continue;
      const level = f.level(obj.id) * obj.audio.volume;
      const rate = (6 + 60 * level) * (1 + 1.5 * this.pulse) * (obj.holders.length ? 1.6 : 1);
      let n = rate * f.dt;
      const c = viewToPixels({ x: obj.position.x + obj.drift.x, y: obj.position.y + obj.drift.y }, cw, ch);
      const halfW = effectiveHalfWidth(obj) * ch * 0.85;
      const halfH = obj.halfSize.y * ch * 0.5;
      const rgb = hexToRgb(obj.color);
      while (n > 0 && this.particles.length < MAX_PARTICLES) {
        if (n < 1 && Math.random() > n) break;
        n -= 1;
        const maxLife = 0.9 + Math.random() * 1.1;
        this.particles.push({
          x: c.x + (Math.random() * 2 - 1) * halfW,
          y: c.y + (Math.random() * 2 - 1) * halfH,
          vx: (Math.random() - 0.5) * ch * 0.02,
          vy: -ch * (0.03 + Math.random() * 0.07),
          life: maxLife,
          maxLife,
          size: ch * (0.0015 + Math.random() * 0.003),
          rgb,
        });
      }
    }

    for (const p of this.particles) {
      p.x += p.vx * f.dt;
      p.y += p.vy * f.dt;
      p.vx *= Math.exp(-f.dt * 0.8);
      p.life -= f.dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  /** Where drop effects come from: the slam point, or the screen center. */
  private origin(cw: number, ch: number): Point2 {
    return this.lastBuild ? viewToPixels(this.lastBuild.point, cw, ch) : { x: cw / 2, y: ch / 2 };
  }

  /** Radial spark burst for the drop. */
  private burst(c: Point2, ch: number): void {
    const colors: [number, number, number][] = [[255, 94, 98], [180, 124, 255], [46, 230, 255], [255, 255, 255]];
    for (let i = 0; i < 140; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = ch * (0.25 + Math.random() * 0.9);
      const maxLife = 0.5 + Math.random() * 0.7;
      this.particles.push({
        x: c.x,
        y: c.y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        life: maxLife,
        maxLife,
        size: ch * (0.002 + Math.random() * 0.004),
        rgb: colors[i % colors.length],
      });
    }
  }

  /** Color grade + grid floor. Draw before the stems. */
  drawBackground(ctx: CanvasRenderingContext2D): void {
    const { width: w, height: h } = ctx.canvas;
    const u = h / 720;

    // Cool neon color grade over the webcam.
    ctx.save();
    const grade = ctx.createLinearGradient(0, 0, 0, h);
    grade.addColorStop(0, 'rgba(70, 20, 140, 0.16)');
    grade.addColorStop(0.6, 'rgba(10, 30, 90, 0.10)');
    grade.addColorStop(1, 'rgba(0, 120, 200, 0.18)');
    ctx.fillStyle = grade;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    // Perspective grid floor.
    const hy = h * HORIZON;
    const vx = w / 2;
    const glow = 0.18 + 0.22 * this.pulse + 0.3 * this.energy + 0.4 * this.impact;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = u;

    // Horizontal lines: perspective spacing, scrolling toward the viewer.
    const LINES = 12;
    for (let i = 0; i < LINES; i++) {
      const z = (i + 1 - this.gridOffset) / LINES; // 0 far .. 1 near
      if (z <= 0) continue;
      const y = hy + (h - hy) * z * z;
      const a = glow * z;
      const hot = this.energy;
      ctx.strokeStyle = `rgba(${Math.round(120 + 135 * hot)}, ${Math.round(90 - 30 * hot)}, ${Math.round(255 - 60 * hot)}, ${Math.min(1, a).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    // Lines converging to the vanishing point.
    const RAYS = 18;
    const fade = ctx.createLinearGradient(0, hy, 0, h);
    fade.addColorStop(0, 'rgba(60, 200, 255, 0)');
    fade.addColorStop(1, `rgba(60, 200, 255, ${(glow * 0.9).toFixed(3)})`);
    ctx.strokeStyle = fade;
    ctx.beginPath();
    for (let i = 0; i <= RAYS; i++) {
      const x = ((i / RAYS) * 2 - 1) * w * 1.6 + vx;
      ctx.moveTo(vx, hy);
      ctx.lineTo(x, h);
    }
    ctx.stroke();

    // Horizon glow.
    const band = ctx.createLinearGradient(0, hy - h * 0.04, 0, hy + h * 0.04);
    band.addColorStop(0, 'rgba(180, 80, 255, 0)');
    band.addColorStop(0.5, `rgba(180, 80, 255, ${(0.12 + 0.12 * this.pulse).toFixed(3)})`);
    band.addColorStop(1, 'rgba(180, 80, 255, 0)');
    ctx.fillStyle = band;
    ctx.fillRect(0, hy - h * 0.04, w, h * 0.08);
    ctx.restore();
  }

  /** Blend beam, build core, drop impact, particles. Draw after the stems, before the hands. */
  drawForeground(ctx: CanvasRenderingContext2D, f: NeonFrame): void {
    const { width: cw, height: ch } = ctx.canvas;
    const u = ch / 720;
    if (f.build || f.perf.dropPending || this.impact > 0) this.drawBuild(ctx, f, cw, ch, u);
    if (this.impact > 0) this.drawImpact(ctx, f, cw, ch, u);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    if (f.blend) this.drawBeam(ctx, f, cw, ch, u);

    for (const p of this.particles) {
      const k = p.life / p.maxLife;
      const a = Math.sin(Math.PI * k) * 0.55;
      ctx.fillStyle = `rgba(${p.rgb[0]}, ${p.rgb[1]}, ${p.rgb[2]}, ${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (0.6 + 0.6 * k), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * Build/drop on the fist: a charge meter rising from where the fist closed
   * (fills as the hand rises, with the threshold marked), an energy ball on
   * the fist that grows and crackles, and a label saying what to do next.
   * After the slam it counts the beats down to the drop at the slam point.
   */
  private drawBuild(ctx: CanvasRenderingContext2D, f: NeonFrame, cw: number, ch: number, u: number): void {
    const where = f.build ?? this.lastBuild;
    if (!where) return;
    const from = viewToPixels(where.from, cw, ch);
    const p = viewToPixels(where.point, cw, ch);
    const e = this.energy;
    const coral: [number, number, number] = [255, 94, 98];
    const magenta: [number, number, number] = [255, 70, 200];
    const hot = mix(coral, [255, 255, 255], 0.5 * e + 0.5 * this.impact);
    const value = f.build?.value ?? f.perf.build;

    ctx.save();
    // Meter rail: from where the fist closed, up one full build of travel.
    if (f.build) {
      const railBottom = from.y;
      const railTop = from.y - BUILD_TRAVEL * ch;
      const x = from.x + ch * 0.07;
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.lineWidth = u * 4;
      ctx.beginPath();
      ctx.moveTo(x, railBottom);
      ctx.lineTo(x, railTop);
      ctx.stroke();
      const grad = ctx.createLinearGradient(0, railBottom, 0, railTop);
      grad.addColorStop(0, rgba(coral, 0.9));
      grad.addColorStop(1, rgba(magenta, 1));
      ctx.strokeStyle = grad;
      ctx.shadowColor = rgba(magenta, 1);
      ctx.shadowBlur = u * 10 * (0.4 + e);
      ctx.beginPath();
      ctx.moveTo(x, railBottom);
      ctx.lineTo(x, railBottom + (railTop - railBottom) * value);
      ctx.stroke();
      ctx.shadowBlur = 0;
      const ty = railBottom + (railTop - railBottom) * BUILD_MIN;
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = u * 1.5;
      ctx.beginPath();
      ctx.moveTo(x - u * 7, ty);
      ctx.lineTo(x + u * 7, ty);
      ctx.stroke();
    }

    // Energy ball on the fist (or at the slam point while the drop is pending).
    const r = ch * (0.025 + 0.05 * e) * (1 + 0.1 * this.pulse);
    ctx.globalCompositeOperation = 'lighter';
    const halo = ctx.createRadialGradient(p.x, p.y, r * 0.1, p.x, p.y, r * 2.4);
    halo.addColorStop(0, rgba(hot, 0.5 + 0.4 * e));
    halo.addColorStop(0.4, rgba(magenta, 0.15 + 0.3 * e));
    halo.addColorStop(1, rgba(magenta, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 2.4, 0, Math.PI * 2);
    ctx.fill();
    // Crackling arcs around it, faster with energy.
    const spin = f.t * (1 + 8 * e);
    ctx.lineWidth = u * (1.2 + 1.5 * e);
    ctx.strokeStyle = rgba(mix(coral, magenta, 0.5), 0.5 + 0.5 * e);
    for (let i = 0; i < 3; i++) {
      const a = spin + (i * Math.PI * 2) / 3;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * (1.3 + 0.15 * Math.sin(f.t * 30 + i)), a, a + 0.8 + e);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';

    // Label: what to do next.
    const fs = u * 12;
    ctx.font = `700 ${fs}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = rgba(magenta, 0.9);
    ctx.shadowBlur = u * 8;
    ctx.fillStyle = 'rgba(245,240,255,0.95)';
    let label = '';
    let sub = '';
    if (f.perf.dropPending && f.perf.dropAtMs !== null) {
      const beatMs = f.beat ? 60000 / f.beat.bpm : 0;
      label = beatMs ? `DROP IN ${Math.max(1, Math.ceil((f.perf.dropAtMs - f.nowMs) / beatMs))}` : 'DROP';
      sub = f.perf.dropQuantized ? 'ON THE BAR' : 'NO BEAT GRID';
    } else if (this.impact > 0) {
      label = 'DROP';
    } else if (f.build?.state === 'armed') {
      label = 'LIFT ▲ TO BUILD';
    } else if (f.build?.state === 'building') {
      label = `BUILD ${Math.round(f.build.value * 100)}`;
      sub = f.build.value >= RELEASE_DROP_MIN ? 'LET GO (OR PULL DOWN) TO DROP' : 'KEEP LIFTING · PULL DOWN TO DROP';
    }
    // Ready to drop: pulsing down-arrows under the fist.
    let ly = p.y + r * 2.4 + fs;
    if (f.build?.state === 'building') {
      const bob = (f.t * 2.5) % 1;
      ctx.save();
      ctx.shadowBlur = u * 10;
      for (let i = 0; i < 3; i++) {
        const k = (bob + i / 3) % 1;
        const ay = p.y + r * 2.2 + k * fs * 3;
        ctx.globalAlpha = Math.sin(Math.PI * k);
        ctx.fillStyle = rgba(magenta, 1);
        ctx.beginPath();
        ctx.moveTo(p.x - fs * 0.8, ay);
        ctx.lineTo(p.x + fs * 0.8, ay);
        ctx.lineTo(p.x, ay + fs * 0.7);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      ly += fs * 3.4;
      label = `▼ DROP  ·  ${label}`;
    }
    if (label) ctx.fillText(label, p.x, ly);
    if (sub) {
      ctx.font = `600 ${fs * 0.75}px ui-monospace, "SF Mono", Menlo, monospace`;
      ctx.fillStyle = 'rgba(245,240,255,0.65)';
      ctx.fillText(sub, p.x, ly + fs * 1.3);
    }
    ctx.restore();
  }

  /** Expanding shockwave ring + brief flash when the drop lands. */
  private drawImpact(ctx: CanvasRenderingContext2D, _f: NeonFrame, cw: number, ch: number, u: number): void {
    const k = 1 - this.impact; // 0 at the hit -> 1
    const c = this.origin(cw, ch);
    const maxR = Math.hypot(cw, ch);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // Flash (short).
    const flash = Math.max(0, 1 - k * 4);
    if (flash > 0) {
      ctx.fillStyle = `rgba(255, 200, 240, ${(0.16 * flash).toFixed(3)})`;
      ctx.fillRect(0, 0, cw, ch);
    }
    // Two rings, the second trailing.
    for (const [delay, color] of [[0, [255, 120, 200]], [0.12, [120, 220, 255]]] as const) {
      const t = Math.max(0, (k - delay) / (1 - delay));
      if (t <= 0 || t >= 1) continue;
      const radius = maxR * (1 - (1 - t) ** 3);
      ctx.strokeStyle = rgba(color as [number, number, number], 0.6 * (1 - t));
      ctx.lineWidth = u * (14 * (1 - t) + 1);
      ctx.beginPath();
      ctx.arc(c.x, c.y, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Light beam between a blend pair: thick and bright while blended (hands
   * together), thinning and flickering apart as the pair gets isolated.
   */
  private drawBeam(ctx: CanvasRenderingContext2D, f: NeonFrame, cw: number, ch: number, u: number): void {
    const { a, b, isolation } = f.blend!;
    const pa = viewToPixels(a.position, cw, ch);
    const pb = viewToPixels(b.position, cw, ch);
    const ca = hexToRgb(a.color);
    const cb = hexToRgb(b.color);
    const mx = (pa.x + pb.x) / 2;
    const my = (pa.y + pb.y) / 2 - ch * 0.08; // arc slightly upward
    const strength = 1 - 0.75 * isolation;

    const grad = ctx.createLinearGradient(pa.x, pa.y, pb.x, pb.y);
    grad.addColorStop(0, rgba(ca, 0.8 * strength));
    grad.addColorStop(1, rgba(cb, 0.8 * strength));

    const path = () => {
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.quadraticCurveTo(mx, my, pb.x, pb.y);
    };
    ctx.lineCap = 'round';
    // Bloom then core.
    for (const [width, alpha] of [[14, 0.12], [6, 0.35], [2, 1]] as const) {
      path();
      ctx.globalAlpha = alpha * (0.7 + 0.3 * this.pulse);
      ctx.strokeStyle = grad;
      ctx.lineWidth = u * width * (0.4 + 0.8 * strength);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Energy packets flowing both ways along the beam.
    const flow = (f.t * 0.8) % 1;
    for (let i = 0; i < 6; i++) {
      for (const dir of [1, -1]) {
        const s = dir > 0 ? (flow + i / 6) % 1 : 1 - ((flow + i / 6) % 1);
        const x = (1 - s) * (1 - s) * pa.x + 2 * (1 - s) * s * mx + s * s * pb.x;
        const y = (1 - s) * (1 - s) * pa.y + 2 * (1 - s) * s * my + s * s * pb.y;
        const rgb = dir > 0 ? ca : cb;
        ctx.fillStyle = rgba(rgb, 0.9 * strength);
        ctx.beginPath();
        ctx.arc(x, y, u * (2 + 2 * strength), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Label at the top of the arc.
    ctx.globalCompositeOperation = 'source-over';
    const label = isolation < 0.02 ? 'BLEND' : `ISOLATE ${Math.round(isolation * 100)}`;
    ctx.font = `600 ${u * 13}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(235, 240, 255, 0.9)';
    ctx.shadowColor = 'rgba(160, 120, 255, 0.9)';
    ctx.shadowBlur = u * 8;
    ctx.fillText(label, mx, (pa.y + pb.y) / 4 + my / 2 - u * 14);
  }
}

function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgba(c: [number, number, number], a: number): string {
  return `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}
