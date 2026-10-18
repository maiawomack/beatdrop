/**
 * The scratch voice: an AudioWorklet that plays the record under the DJ's hand.
 *
 * AudioBufferSourceNode can't play backwards, so a scratch runs through this processor,
 * which reads a window of the deck's audio around the playhead with its own read head
 * (cubic interpolation) at any speed, forward or reverse.
 *
 * The hand arrives as record positions (~30 per second, from the gesture layer). The
 * processor turns them into physics rather than seeking to them:
 *   - hand speed: estimated from successive positions, extrapolated between updates
 *   - response curve: tracking jitter is ignored (dead zone), small movements stay
 *     subtle (power curve), fast ones are soft-clamped to MAX_SPEED (tanh)
 *   - weight: the record's speed follows the curve through a little mass (HAND_TC), so
 *     pitch glides instead of jumping; a gentle pull keeps it near the hand's position,
 *     and the record slips under the hand rather than racing to catch up
 *   - catch and release: grabbing a playing record brakes it from its current speed;
 *     letting go spins it back up like a turntable motor (MOTOR_TC) while it fades out
 *     and the live track fades back in where it would have been (the deck stays in sync)
 *   - sound: level follows speed like a cartridge (a still record is silent), and a
 *     speed-tracking low-pass keeps fast scratches from aliasing.
 *
 * Messages in:  load {left, right, pos, srcRate, spin} · target {pos} · release {spin} · brake {tc} · stop
 * (brake: a tape stop, the record winds down to a halt over ~3 tc without fading out)
 * Messages out: pos {pos} (record position, ~40x/s) · done (faded out after release)
 * Positions are in source samples of the loaded window; speeds in playback rate (1 = normal).
 */

export const SCRATCH_PROCESSOR = 'beatdrop-scratch';

/** Tuning, shared with the tests. */
export const SCRATCH_TUNING = {
  /** Highest playback speed while scratching, either direction (1 = normal). */
  MAX_SPEED: 3,
  /** Hand speeds below this are tracking jitter: the record holds still. */
  DEADZONE: 0.06,
  /** Response curve exponent (> 1: small movements give gentle, controlled scratches). */
  CURVE: 1.35,
  /** How firmly the record follows the hand's position (1/s), on top of following its speed. */
  POS_GAIN: 8,
  /** Furthest the record lags the hand before it slips under it (s of audio). */
  MAX_LAG: 0.05,
  /** Record inertia against the hand (s): how quickly its speed follows the hand. */
  HAND_TC: 0.018,
  /** Hand updates are extrapolated for at most this long (s); after that the hand counts as still. */
  PREDICT_SEC: 0.06,
  /** Turntable motor after release (s): spin-up toward normal speed. */
  MOTOR_TC: 0.07,
  /** Fade of the scratch voice after release (s). */
  FADE_TC: 0.03,
  /** Speed at which the record reaches full level (slower = quieter, like a cartridge). */
  FULL_LEVEL_SPEED: 0.3,
} as const;

export const SCRATCH_SOURCE = `
const T = ${JSON.stringify(SCRATCH_TUNING)};

/** Speed response: dead zone, power curve, soft clamp. */
function shape(v) {
  const s = Math.abs(v) - T.DEADZONE;
  if (s <= 0) return 0;
  return Math.sign(v) * T.MAX_SPEED * Math.tanh(Math.pow(s, T.CURVE) / T.MAX_SPEED);
}

class Scratch extends AudioWorkletProcessor {
  constructor() {
    super();
    this.l = null; this.r = null;
    this.port.onmessage = (e) => this.message(e.data);
    this.kHand = k(T.HAND_TC); this.kMotor = k(T.MOTOR_TC); this.kFade = k(T.FADE_TC); this.kLevel = k(0.004);
    this.kHandDecay = Math.exp(-1 / (0.02 * sampleRate));
    this.predictFrames = T.PREDICT_SEC * sampleRate;
  }

  message(d) {
    if (d.type === 'load') {
      this.l = d.left; this.r = d.right; this.srcRate = d.srcRate;
      this.pos = d.pos; this.vel = d.spin; this.hand = d.pos; this.lastTarget = d.pos;
      this.handVel = 0; this.slip = 0; this.since = 1e9;
      this.held = true; this.motor = 0; this.fade = 1; this.braking = false; this.kMotor = k(T.MOTOR_TC);
      this.level = Math.min(1, Math.abs(d.spin) / T.FULL_LEVEL_SPEED);
      this.lpL = [0, 0]; this.lpR = [0, 0]; this.report = 0;
    } else if (!this.l) {
      return;
    } else if (d.type === 'target') {
      const gap = this.since;
      // Hand speed from successive positions (bunched messages keep the previous estimate).
      if (gap > sampleRate * 0.006 && gap < sampleRate * 0.15) {
        const v = (d.pos - this.lastTarget) / (gap * this.srcRate);
        this.handVel += (v - this.handVel) * 0.6;
      } else if (gap >= sampleRate * 0.15) {
        this.handVel = 0;
      }
      this.lastTarget = d.pos;
      this.hand = d.pos - this.slip;
      this.since = 0;
    } else if (d.type === 'release') {
      this.held = false; this.motor = d.spin; this.braking = false; this.kMotor = k(T.MOTOR_TC);
    } else if (d.type === 'brake') {
      this.held = false; this.motor = 0; this.braking = true; this.kMotor = k(d.tc);
    } else if (d.type === 'stop') {
      this.l = null;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] || out[0];
    if (!this.l) { L.fill(0); if (R !== L) R.fill(0); return true; }
    const left = this.l, right = this.r, len = left.length, sr = this.srcRate;
    const maxLag = T.MAX_LAG * sampleRate * sr;
    for (let i = 0; i < L.length; i++) {
      if (this.held) {
        // The hand: extrapolated between updates, then considered still.
        if (this.since < this.predictFrames) this.hand += this.handVel * sr;
        else this.handVel *= this.kHandDecay;
        this.since++;
        // Lagging too far (fast move, clamped speed): the record slips under the hand.
        let err = this.hand - this.pos;
        if (Math.abs(err) > maxLag) {
          const excess = err - Math.sign(err) * maxLag;
          this.slip += excess; this.hand -= excess; err -= excess;
        }
        const want = shape(this.handVel + T.POS_GAIN * err / (sampleRate * sr));
        this.vel += (want - this.vel) * this.kHand;
      } else {
        this.vel += (this.motor - this.vel) * this.kMotor;
        if (!this.braking) this.fade -= this.fade * this.kFade;
      }
      this.pos += this.vel * sr;
      if (this.pos < 1) { this.pos = 1; this.vel = 0; }
      if (this.pos > len - 3) { this.pos = len - 3; this.vel = 0; }

      const speed = Math.abs(this.vel);
      this.level += (Math.min(1, speed / T.FULL_LEVEL_SPEED) - this.level) * this.kLevel;
      // Two-pole low-pass at 18 kHz / speed: no aliasing on fast scratches.
      const fc = Math.min(18000, 18000 / Math.max(1, speed));
      const a = 1 - Math.exp((-2 * Math.PI * fc) / sampleRate);
      const g = this.level * this.fade;
      const i0 = Math.floor(this.pos), f = this.pos - i0;
      const xl = cubic(left, i0, f), xr = right === left ? xl : cubic(right, i0, f);
      this.lpL[0] += (xl - this.lpL[0]) * a; this.lpL[1] += (this.lpL[0] - this.lpL[1]) * a;
      this.lpR[0] += (xr - this.lpR[0]) * a; this.lpR[1] += (this.lpR[0] - this.lpR[1]) * a;
      L[i] = this.lpL[1] * g;
      if (R !== L) R[i] = this.lpR[1] * g;
    }
    this.report += L.length;
    if (this.report >= 1024) { this.report = 0; this.port.postMessage({ type: 'pos', pos: this.pos }); }
    if (!this.held && this.fade < 1e-4) { this.l = null; this.port.postMessage({ type: 'done' }); }
    return true;
  }
}

/** One-pole coefficient for a time constant (s). */
function k(tc) {
  return 1 - Math.exp(-1 / (tc * sampleRate));
}

/** Catmull-Rom interpolation between d[i] and d[i + 1]. */
function cubic(d, i, f) {
  const y0 = d[i - 1], y1 = d[i], y2 = d[i + 1], y3 = d[i + 2];
  return y1 + 0.5 * f * (y2 - y0 + f * (2 * y0 - 5 * y1 + 4 * y2 - y3 + f * (3 * (y1 - y2) + y3 - y0)));
}

registerProcessor('${SCRATCH_PROCESSOR}', Scratch);
`;

const ready = new WeakSet<BaseAudioContext>();
const loading = new WeakMap<BaseAudioContext, Promise<void>>();

/** Load the scratch processor into a context (once). Scratching works after this resolves. */
export function loadScratchProcessor(ctx: BaseAudioContext): Promise<void> {
  if (!ctx.audioWorklet) return Promise.resolve();
  let p = loading.get(ctx);
  if (!p) {
    const url = URL.createObjectURL(new Blob([SCRATCH_SOURCE], { type: 'application/javascript' }));
    p = ctx.audioWorklet
      .addModule(url)
      .then(() => {
        ready.add(ctx);
      })
      .catch((err) => console.warn('[audio] scratch unavailable:', err))
      .finally(() => URL.revokeObjectURL(url));
    loading.set(ctx, p);
  }
  return p;
}

export function scratchReady(ctx: BaseAudioContext): boolean {
  return ready.has(ctx);
}
