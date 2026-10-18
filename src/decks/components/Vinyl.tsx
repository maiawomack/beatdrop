import { useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { DeckState } from '../../shared/types';
import type { EngineStore } from '../engineStore';
import { useAnimationFrame } from '../hooks';
import { DECK_COLORS } from '../theme';

const RING_RADIUS = 49.2;
/** How much a full-strength beat grows the record. */
const PULSE_SCALE = 0.035;

/**
 * Beat envelope at a position in the track: 1 right on a beat, decaying quickly
 * before the next one. Bar downbeats (every 4th beat) hit a bit harder.
 */
function beatPulse(posSec: number, bpm: number, firstBeatSec: number): number {
  if (bpm <= 0) return 0;
  const beats = (posSec - firstBeatSec) / (60 / bpm);
  if (beats < 0) return 0;
  const phase = beats - Math.floor(beats);
  const accent = Math.floor(beats) % 4 === 0 ? 1 : 0.7;
  return Math.exp(-phase * 7) * accent;
}
const CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
/** Seconds of audio per full turn of the record (33⅓ rpm). */
const SEC_PER_TURN = 1.8;

/** Small deterministic PRNG so each record keeps the same grooves and dust. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Paint the record surface: grooves, track gaps, run-out, rim, dust. */
function paintRecord(canvas: HTMLCanvasElement, seed: number) {
  const dpr = window.devicePixelRatio || 1;
  const size = Math.round(canvas.clientWidth * dpr);
  if (!size) return;
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  const random = rng(seed);
  const R = size / 2;
  const tau = Math.PI * 2;
  const labelR = R * 0.335;
  const grooveStart = R * 0.42;
  const grooveEnd = R * 0.955;
  g.translate(R, R);

  g.fillStyle = '#0b0b0c';
  g.beginPath();
  g.arc(0, 0, R, 0, tau);
  g.fill();

  // Run-out: the smooth band between the label and the music.
  g.fillStyle = '#121214';
  g.beginPath();
  g.arc(0, 0, grooveStart, 0, tau);
  g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.05)';
  g.lineWidth = Math.max(1, dpr * 0.6);
  for (let r = labelR * 1.08; r < grooveStart; r += R * 0.018) {
    g.beginPath();
    g.arc(0, 0, r, 0, tau);
    g.stroke();
  }

  // Grooves, with a few shiny gaps between tracks.
  const gaps = [0.22, 0.47, 0.66, 0.84].map((f) => grooveStart + f * (grooveEnd - grooveStart));
  const step = Math.max(1, dpr * 0.9);
  g.lineWidth = step * 0.85;
  for (let r = grooveStart; r < grooveEnd; r += step) {
    const nearGap = gaps.some((gr) => Math.abs(r - gr) < R * 0.006);
    const light = nearGap ? 20 + random() * 4 : 6 + random() * 7 + (random() < 0.04 ? 5 : 0);
    g.strokeStyle = `hsl(250 4% ${light}%)`;
    g.beginPath();
    g.arc(0, 0, r, 0, tau);
    g.stroke();
  }

  // Rim: a smooth lip with a lighter edge.
  const rim = g.createRadialGradient(0, 0, grooveEnd, 0, 0, R);
  rim.addColorStop(0, '#101012');
  rim.addColorStop(0.7, '#1b1b1f');
  rim.addColorStop(1, '#2a2a30');
  g.fillStyle = rim;
  g.beginPath();
  g.arc(0, 0, R, 0, tau);
  g.arc(0, 0, grooveEnd, 0, tau, true);
  g.fill();

  // Scuffs and dust: what makes a real record look real, and shows it spinning.
  for (let i = 0; i < 9; i++) {
    const r = grooveStart + random() * (grooveEnd - grooveStart);
    const a = random() * tau;
    g.strokeStyle = `rgba(255,255,255,${0.03 + random() * 0.04})`;
    g.lineWidth = dpr * (0.6 + random());
    g.beginPath();
    g.arc(0, 0, r, a, a + 0.2 + random() * 0.6);
    g.stroke();
  }
  for (let i = 0; i < 160; i++) {
    const r = labelR + random() * (R - labelR);
    const a = random() * tau;
    g.fillStyle = `rgba(255,255,255,${0.05 + random() * 0.18})`;
    g.beginPath();
    g.arc(Math.cos(a) * r, Math.sin(a) * r, dpr * (0.3 + random() * 0.9), 0, tau);
    g.fill();
  }
}

/** A realistic record half off the screen edge; the thin outer arc shows progress. */
interface Props {
  deck: DeckState;
  engine: EngineStore;
  /** Beat-grid phase from the stems manifest (0 when unknown). */
  firstBeatSec: number;
  /** Mixer crossfader, -1 (A) .. 1 (B): scales how hard this record pulses. */
  crossfader: number;
}

export function Vinyl({ deck, engine, firstBeatSec, crossfader }: Props) {
  const pulseRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<SVGCircleElement>(null);
  const surface = useRef<HTMLCanvasElement>(null);
  const spinRef = useRef<HTMLDivElement>(null);
  /** While scratching (from the spatial workstation): the spin animation's time and track position at the start. */
  const scratchRef = useRef<{ t0: number; p0: number } | null>(null);
  const side = deck.id === 'A' ? 'left' : 'right';
  const title = deck.track
    ? [deck.track.title, ...deck.track.artists.slice(0, 2)].join(' · ')
    : 'Beatdrop Records · Promo Copy';

  useEffect(() => {
    const canvas = surface.current;
    if (!canvas) return;
    const paint = () => paintRecord(canvas, deck.id === 'A' ? 7 : 19);
    paint();
    const observer = new ResizeObserver(paint);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [deck.id]);

  /**
   * Mouse scratch: grab the record and turn it around its centre (clockwise = forward),
   * like a hand on the platter. Same engine scratch as the spatial screen's open palm.
   */
  const grab = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!deck.track || e.button !== 0) return;
    const el = e.currentTarget;
    const box = el.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const angleOf = (ev: { clientX: number; clientY: number }) => Math.atan2(ev.clientY - cy, ev.clientX - cx);
    let last = angleOf(e);
    let turned = 0;
    el.setPointerCapture(e.pointerId);
    engine.dispatch({ type: 'SCRATCH_START', deck: deck.id });
    el.onpointermove = (ev) => {
      const a = angleOf(ev);
      let d = a - last;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      last = a;
      turned += d;
      engine.dispatch({ type: 'SCRATCH_MOVE', deck: deck.id, offsetSec: (turned / (2 * Math.PI)) * SEC_PER_TURN });
    };
    el.onpointerup = el.onpointercancel = () => {
      el.onpointermove = el.onpointerup = el.onpointercancel = null;
      engine.dispatch({ type: 'SCRATCH_END', deck: deck.id });
    };
  };

  useAnimationFrame(() => {
    const pos = engine.position(deck.id);

    // A hand scratching this deck: the record turns with it (33⅓ rpm: 1 s of audio = 1/1.8 turn),
    // by steering the spin animation's time, so on release it just carries on from there.
    const anim = spinRef.current?.getAnimations()[0];
    if (anim && deck.scratching) {
      scratchRef.current ??= { t0: Number(anim.currentTime ?? 0), p0: pos };
      const durMs = 1800 / deck.playbackRate;
      const t = scratchRef.current.t0 + ((pos - scratchRef.current.p0) * 1000) / deck.playbackRate;
      anim.currentTime = ((t % durMs) + durMs) % durMs;
    } else {
      scratchRef.current = null;
    }
    const el = progressRef.current;
    if (el) {
      const duration = deck.durationSec;
      el.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - (duration ? pos / duration : 0)));
    }

    // Pulse on the track's beat grid. Position runs in track time, so a faster
    // tempo pulses faster on its own. Strength follows this deck's equal-power
    // crossfader gain, matching what you hear.
    const pulse = pulseRef.current;
    if (!pulse) return;
    const angle = ((crossfader + 1) / 4) * Math.PI;
    const weight = deck.id === 'A' ? Math.cos(angle) : Math.sin(angle);
    const beat = deck.playing && deck.bpm ? beatPulse(pos, deck.bpm, firstBeatSec) * weight : 0;
    pulse.style.transform = `scale(${1 + beat * PULSE_SCALE})`;
    pulse.style.setProperty('--beat', beat.toFixed(3));
  });

  return (
    <div
      className={`vinyl ${side}${deck.playing ? ' playing' : ''}`}
      style={{ '--deck': DECK_COLORS[deck.id] } as CSSProperties}
      aria-hidden
    >
      <div className="pulse" ref={pulseRef}>
        <div className="beat-glow" />
        <div className="spin" ref={spinRef} onPointerDown={grab} style={{ animationDuration: `${SEC_PER_TURN / deck.playbackRate}s` }}>
          <canvas ref={surface} className="surface" />
          <svg className="label" viewBox="0 0 100 100">
            <defs>
              <radialGradient id={`paper-${deck.id}`} cx="45%" cy="40%">
                <stop offset="0" stopColor="#fbf9f3" />
                <stop offset="1" stopColor="#e9e4d8" />
              </radialGradient>
              <radialGradient id={`spindle-${deck.id}`} cx="40%" cy="35%">
                <stop offset="0" stopColor="#f2f2f5" />
                <stop offset="1" stopColor="#7b7b85" />
              </radialGradient>
              <path id={`arc-top-${deck.id}`} d="M 14 50 A 36 36 0 0 1 86 50" />
              <path id={`arc-bottom-${deck.id}`} d="M 12 50 A 38 38 0 0 0 88 50" />
            </defs>
            <circle cx="50" cy="50" r="49" fill={`url(#paper-${deck.id})`} />
            <circle cx="50" cy="50" r="44" fill="none" stroke="#1a1a1f" strokeWidth="0.5" opacity="0.5" />
            <text className="label-text">
              <textPath href={`#arc-top-${deck.id}`} startOffset="50%" textAnchor="middle">
                BEATDROP · SIDE {deck.id} · 33⅓ RPM
              </textPath>
            </text>
            <text className="label-text small">
              <textPath href={`#arc-bottom-${deck.id}`} startOffset="50%" textAnchor="middle">
                {title.length > 44 ? `${title.slice(0, 43)}…` : title}
              </textPath>
            </text>
            {/* Hand-drawn eighth note */}
            <g fill="#121214">
              <ellipse cx="44" cy="62" rx="8.5" ry="6.2" transform="rotate(-22 44 62)" />
              <path d="M 50.2 60.5 L 50.6 27 Q 51 25 52.6 26.4 Q 58 32 63 33 Q 66.5 34 65 40 Q 62 36.5 57.5 35.5 Q 54.5 35 53.6 34.6 L 53.2 60.4 Z" />
            </g>
            <circle cx="50" cy="50" r="3.1" fill={`url(#spindle-${deck.id})`} />
            <circle cx="50" cy="50" r="1.3" fill="#2a2a30" />
          </svg>
        </div>
        <div className="sheen" />
        <svg className="ring" viewBox="0 0 100 100">
          <circle
            ref={progressRef}
            cx="50"
            cy="50"
            r={RING_RADIUS}
            fill="none"
            stroke={DECK_COLORS[deck.id]}
            strokeWidth="0.7"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE}
            // Start at 12 o'clock and sweep through the on-screen half first.
            transform={side === 'left' ? 'rotate(-90 50 50)' : 'scale(-1 1) translate(-100 0) rotate(-90 50 50)'}
          />
        </svg>
      </div>
    </div>
  );
}
