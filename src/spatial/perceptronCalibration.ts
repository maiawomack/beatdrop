/**
 * Perceptron AI client for the gesture calibration stage (calibrationStage.ts).
 *
 * Each calibration demonstration is recorded as small timed webcam frames and sent to
 * the local Python service (tools/stems/separation_server.py, which holds the API key),
 * where Perceptron's Mk1.5 model finds *when* the requested gesture is performed:
 * video event finding (clip annotations), cross-checked with a per-frame pose check.
 * See tools/perceptron/gesture_check.py.
 *
 * Frames are only sent after the user says yes, held in memory for the request, and
 * never stored. Live performance never calls Perceptron.
 */

const SERVICE = 'http://127.0.0.1:8765';
/** Frame rate of the demonstration video sent to Perceptron. */
const FRAME_EVERY_MS = 200;
const FRAME_WIDTH = 384;
const REQUEST_TIMEOUT_MS = 45_000;

export type CalibrationGesture = 'open' | 'fist' | 'lift';

/** A time range in performance.now() milliseconds. */
export type Range = [start: number, end: number];

export interface TimedFrame {
  /** Milliseconds since the first frame of the demonstration. */
  t: number;
  /** JPEG data URL. */
  jpeg: string;
}

/** Whether the local service is running with a Perceptron key. */
export async function perceptronAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${SERVICE}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok && (await res.json()).perceptron === true;
  } catch {
    return false;
  }
}

/** Records one demonstration as small same-size JPEG frames with timestamps. */
export class ClipRecorder {
  private frames: TimedFrame[] = [];
  private start = 0;
  private last = -Infinity;
  private canvas: HTMLCanvasElement | null = null;

  constructor(private readonly video: HTMLVideoElement) {}

  /** Start a new demonstration at `now` (performance.now() ms). */
  begin(now: number): void {
    this.frames = [];
    this.start = now;
    this.last = -Infinity;
  }

  /** Call every frame while recording; keeps one frame every FRAME_EVERY_MS. */
  capture(now: number): void {
    if (now - this.last < FRAME_EVERY_MS || !this.video.videoWidth) return;
    this.last = now;
    const height = Math.round((this.video.videoHeight * FRAME_WIDTH) / this.video.videoWidth);
    this.canvas ??= document.createElement('canvas');
    if (this.canvas.width !== FRAME_WIDTH || this.canvas.height !== height) {
      this.canvas.width = FRAME_WIDTH;
      this.canvas.height = height;
    }
    this.canvas.getContext('2d')?.drawImage(this.video, 0, 0, FRAME_WIDTH, height);
    this.frames.push({ t: Math.round(now - this.start), jpeg: this.canvas.toDataURL('image/jpeg', 0.7) });
  }

  /** Hand over the frames (and forget them here). `origin` is the clip's start time. */
  take(): { frames: TimedFrame[]; origin: number } {
    const frames = this.frames;
    this.frames = [];
    // Timestamps start at the first kept frame (Perceptron's timeline starts there too).
    const first = frames[0]?.t ?? 0;
    return { frames: frames.map((f) => ({ t: f.t - first, jpeg: f.jpeg })), origin: this.start + first };
  }
}

export type SegmentsResult =
  | { ok: true; ranges: Range[]; poses: (string | null)[]; summary: string }
  | { ok: false; error: string };

/**
 * When does the demonstration show the gesture? Ranges come back on the page's clock
 * (performance.now() ms), ready to match against MediaPipe samples.
 */
export async function findSegments(gesture: CalibrationGesture, clip: { frames: TimedFrame[]; origin: number }): Promise<SegmentsResult> {
  if (clip.frames.length < 2) return { ok: false, error: 'no frames recorded' };
  try {
    const res = await fetch(`${SERVICE}/gesture/segments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gesture, frames: clip.frames }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body.error ?? `service error ${res.status}` };
    const segments = body.segments as [number, number][] | undefined;
    if (!Array.isArray(segments) || !segments.every((s) => Array.isArray(s) && s.length === 2 && s[0] <= s[1])) {
      return { ok: false, error: 'unexpected answer' };
    }
    return {
      ok: true,
      ranges: segments.map(([a, b]) => [clip.origin + a * 1000, clip.origin + b * 1000]),
      poses: Array.isArray(body.poses) ? body.poses : [],
      summary: String(body.summary ?? ''),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Total length of ranges, in seconds. */
export function rangesSeconds(ranges: Range[]): number {
  return ranges.reduce((sum, [a, b]) => sum + (b - a), 0) / 1000;
}

export function inRanges(ranges: Range[], t: number): boolean {
  return ranges.some(([a, b]) => t >= a && t <= b);
}
