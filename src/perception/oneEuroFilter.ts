/**
 * One Euro filter (Casiez et al. 2012): heavy smoothing when the signal is
 * slow (kills jitter), light smoothing when it's fast (keeps latency low).
 *
 * minCutoff: lower = smoother at rest, more lag.
 * beta:      higher = less lag during fast motion.
 */
export class OneEuroFilter {
  private x: number | null = null;
  private dx = 0;
  private lastT: number | null = null;

  constructor(
    private minCutoff = 1.0,
    private beta = 5.0,
    private dCutoff = 1.0,
  ) {}

  /** @param t timestamp in milliseconds */
  filter(value: number, t: number): number {
    if (this.x === null || this.lastT === null) {
      this.x = value;
      this.lastT = t;
      return value;
    }
    const dt = Math.max((t - this.lastT) / 1000, 1e-3);
    this.lastT = t;

    const rawDx = (value - this.x) / dt;
    this.dx = lerp(this.dx, rawDx, alpha(this.dCutoff, dt));

    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x = lerp(this.x, value, alpha(cutoff, dt));
    return this.x;
  }

  reset(): void {
    this.x = null;
    this.lastT = null;
    this.dx = 0;
  }
}

function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
