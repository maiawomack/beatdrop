import {
  defaultPerformanceState,
  defaultStemState,
  isStemCommand,
  wallNow,
  type AudioCommand,
  type AudioCommandSink,
  type AudioStateSource,
  type PerformanceState,
  type StemId,
  type StemState,
  type TransportState,
} from './AudioCommands';

/**
 * Stand-in for the audio engine with the same state semantics and no Web
 * Audio. Used by tests, and usable when the real engine isn't available.
 *
 * Timing is collapsed: loops engage and drops land immediately (call
 * `holdDrops = true` to keep a drop pending until `landDrop()`).
 */
export class MockAudioEngine implements AudioCommandSink, AudioStateSource {
  readonly stems = new Map<StemId, StemState>();
  readonly perf: PerformanceState = defaultPerformanceState();
  readonly transport: TransportState = {
    playing: true,
    bpm: 120,
    beatsPerBar: 4,
    anchorMs: wallNow(),
    durationSec: 16,
  };
  readonly log: AudioCommand[] = [];
  holdDrops = false;
  private listeners = new Set<() => void>();

  constructor(stemIds: StemId[] = []) {
    for (const id of stemIds) this.stems.set(id, defaultStemState());
  }

  dispatch(command: AudioCommand): void {
    this.log.push(command);
    if (isStemCommand(command)) {
      if (command.type === 'removeClip' && !this.stems.has(command.stemId)) return;
      const stem = this.stems.get(command.stemId) ?? defaultStemState();
      this.stems.set(command.stemId, stem);
      switch (command.type) {
        case 'grab':
          stem.grabbed = true;
          break;
        case 'release':
          stem.grabbed = false;
          break;
        case 'setPan':
          stem.pan = clamp(command.value, -1, 1);
          break;
        case 'setVolume':
          stem.volume = clamp(command.value, 0, 1);
          break;
        case 'setMute':
          stem.muted = command.value;
          break;
        case 'setSolo':
          stem.solo = command.value;
          break;
        case 'setFx':
          stem.fx = clamp(command.value, 0, 1);
          break;
        case 'setFilter': {
          const v = clamp(command.value, -1, 1);
          stem.filter = Math.abs(v) < 0.02 ? 0 : v;
          break;
        }
        case 'createClip': {
          if (this.transport.bpm === null || this.stems.has(command.clipId) || stem.clipOf) break;
          const end = (command.beats * 60) / this.transport.bpm;
          this.stems.set(command.clipId, {
            ...defaultStemState(),
            clipOf: command.stemId,
            loop: { beats: command.beats, startSec: 0, endSec: end, engaged: true },
          });
          stem.ducked = true;
          break;
        }
        case 'removeClip': {
          const source = stem.clipOf;
          if (!source) break;
          this.stems.delete(command.stemId);
          const left = [...this.stems.values()].some((s) => s.clipOf === source);
          const src = this.stems.get(source);
          if (src && !left) src.ducked = false;
          break;
        }
        case 'setLoop':
          if (this.transport.bpm === null) break;
          stem.loop =
            command.beats === null
              ? null
              : { beats: command.beats, startSec: 0, endSec: (command.beats * 60) / this.transport.bpm, engaged: true };
          break;
      }
      const anySolo = [...this.stems.values()].some((s) => s.solo);
      for (const s of this.stems.values()) s.audible = !s.muted && (!anySolo || s.solo);
    } else if (command.type === 'setBuild') {
      if (!this.perf.dropPending) this.perf.build = clamp(command.value, 0, 1);
    } else if (command.type === 'drop') {
      if (!this.perf.dropPending && this.perf.build >= 0.05) {
        this.perf.dropPending = true;
        this.perf.dropAtMs = wallNow();
        this.perf.dropQuantized = this.transport.bpm !== null;
        if (!this.holdDrops) this.landDrop();
      }
    }
    this.notify();
  }

  /** Complete a pending drop (immediately unless holdDrops). */
  landDrop(): void {
    if (!this.perf.dropPending) return;
    this.perf.dropPending = false;
    this.perf.build = 0;
    this.perf.drops++;
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
