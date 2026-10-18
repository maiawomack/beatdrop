import type { HoloObject } from '../ar/HoloObject';
import type { InteractionEvent } from '../ar/InteractionController';
import type { PerceptionFrame } from '../perception';

/** Hard cap so a forgotten recording can't eat memory (~2 min at 30 fps). */
const MAX_FRAMES = 3600;

interface RecordedFrame {
  frame: PerceptionFrame;
  /** What the user said they were doing (held key while recording), if anything. */
  label?: 'open' | 'pinch' | 'fist';
  /** Interaction events emitted while processing this frame. */
  events: { type: string; stem: string; hand?: string; value?: number }[];
  /** Stem state after this frame. */
  stems: {
    id: string;
    position: { x: number; y: number };
    holders: string[];
    levelHand: string | null;
    stretchAmount: number;
    hover: number;
    volume: number;
    muted: boolean;
    fx: number;
  }[];
}

/**
 * Debug recorder: captures perception frames, interaction events and stem
 * state, then downloads them as JSON. The file can be replayed through
 * InteractionController in tests to reproduce interaction bugs exactly.
 */
export class InteractionRecorder {
  private frames: RecordedFrame[] = [];
  private pendingEvents: RecordedFrame['events'] = [];
  private startedAt = 0;
  recording = false;
  /** Set while the user holds a label key (O / P / F) during a recording. */
  label: RecordedFrame['label'];

  constructor(private meta: Record<string, unknown> = {}) {}

  toggle(): void {
    if (this.recording) this.stop();
    else this.start();
  }

  start(): void {
    this.frames = [];
    this.pendingEvents = [];
    this.startedAt = Date.now();
    this.recording = true;
  }

  stop(): void {
    this.recording = false;
    if (this.frames.length === 0) return;
    const blob = new Blob(
      [JSON.stringify({ version: 1, recordedAt: new Date(this.startedAt).toISOString(), meta: this.meta, frames: this.frames })],
      { type: 'application/json' },
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `beatdrop-recording-${new Date(this.startedAt).toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    this.frames = [];
  }

  /** Wrap the interaction event handler so events get logged too. */
  tap(handler: (e: InteractionEvent) => void): (e: InteractionEvent) => void {
    return (e) => {
      if (this.recording) {
        this.pendingEvents.push({
          type: e.type,
          stem: 'object' in e ? e.object.id : 'core',
          hand: 'hand' in e ? e.hand : undefined,
          value: 'value' in e ? e.value : undefined,
        });
      }
      handler(e);
    };
  }

  /** Call once per frame, after interaction has been updated. */
  capture(frame: PerceptionFrame, objects: HoloObject[]): void {
    if (!this.recording) return;
    this.frames.push({
      frame: structuredClone(frame),
      label: this.label,
      events: this.pendingEvents,
      stems: objects.map((o) => ({
        id: o.id,
        position: { ...o.position },
        holders: [...o.holders],
        levelHand: o.levelHand,
        stretchAmount: o.stretchAmount,
        hover: o.hover,
        volume: o.audio.volume,
        muted: o.audio.muted,
        fx: o.audio.fx,
      })),
    });
    this.pendingEvents = [];
    if (this.frames.length >= MAX_FRAMES) this.stop();
  }

  get seconds(): number {
    return this.recording ? (Date.now() - this.startedAt) / 1000 : 0;
  }
}
