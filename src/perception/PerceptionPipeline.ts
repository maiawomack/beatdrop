import { startCamera, stopCamera, type CameraOptions } from './camera';
import { GestureProcessor, type GestureConfig } from './gestures';
import { HandTracker } from './handTracker';
import type { PerceptionFrame } from './types';

export type FrameListener = (frame: PerceptionFrame) => void;

export interface PerceptionOptions {
  camera?: CameraOptions;
  gestures?: Partial<GestureConfig>;
}

/**
 * Camera -> MediaPipe -> gestures. Emits one PerceptionFrame per processed
 * video frame. Knows nothing about rendering, AR objects, or audio.
 */
export class PerceptionPipeline {
  private listeners = new Set<FrameListener>();
  private running = false;
  private lastVideoTime = -1;
  private lastTimestamp = 0;

  private constructor(
    readonly video: HTMLVideoElement,
    private stream: MediaStream,
    private tracker: HandTracker,
    /** Gesture stage; exposed for grab calibration. */
    readonly gestures: GestureProcessor,
  ) {}

  static async create(video: HTMLVideoElement, opts: PerceptionOptions = {}): Promise<PerceptionPipeline> {
    const [stream, tracker] = await Promise.all([startCamera(video, opts.camera), HandTracker.create()]);
    const gestures = new GestureProcessor(video.videoWidth / video.videoHeight, opts.gestures);
    return new PerceptionPipeline(video, stream, tracker, gestures);
  }

  /** Subscribe to frames. Returns an unsubscribe function. */
  onFrame(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
  }

  dispose(): void {
    this.stop();
    this.listeners.clear();
    this.tracker.close();
    stopCamera(this.stream);
  }

  private scheduleNext(): void {
    if (!this.running) return;
    const v = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => this.tick());
    else requestAnimationFrame(() => this.tick());
  }

  private tick(): void {
    if (!this.running) return;
    const { video } = this;

    // Only process genuinely new frames.
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = video.currentTime;
      // MediaPipe requires strictly increasing timestamps.
      const t = Math.max(performance.now(), this.lastTimestamp + 1);
      this.lastTimestamp = t;

      this.gestures.setAspect(video.videoWidth / video.videoHeight);
      const hands = this.gestures.update(this.tracker.detect(video, t), t);
      const frame: PerceptionFrame = { timestamp: t, hands };
      for (const l of this.listeners) l(frame);
    }

    this.scheduleNext();
  }
}
