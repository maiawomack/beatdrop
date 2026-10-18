/**
 * Shared contract between UIs (spatial AR, traditional DJ monitor) and the
 * single authoritative audio engine.
 *
 * - UIs send intent with `sink.dispatch(command)`.
 * - UIs read authoritative state from an AudioStateSource; they never treat
 *   their own local values as the truth.
 *
 * Targets: stem commands carry a `stemId`. Performance commands (build/drop)
 * target the master bus and have no stemId. There is one deck for now; when
 * the two-deck engine (Task 1) lands, add a `deckId` here together.
 *
 * NOTE for the audio-engine / integration owners: this is the spatial
 * workstation's current proposal. Change it together, not unilaterally.
 */

export type StemId = string;

/** Fixed musical loop lengths, in beats. */
export const LOOP_BEATS = [1, 2, 4, 8] as const;
export type LoopBeats = (typeof LOOP_BEATS)[number];

export type StemCommand =
  /** A UI picked the stem up (informational; the engine may give feedback). */
  | { type: 'grab'; stemId: StemId }
  /** A UI let the stem go. */
  | { type: 'release'; stemId: StemId }
  /** Stereo position, -1 (left) .. 1 (right). */
  | { type: 'setPan'; stemId: StemId; value: number }
  /** Fader level, 0 (silent) .. 1 (full). */
  | { type: 'setVolume'; stemId: StemId; value: number }
  /** Mute keeps the fader value, so unmuting restores it. */
  | { type: 'setMute'; stemId: StemId; value: boolean }
  /** While any stem is soloed, only soloed stems are audible. */
  | { type: 'setSolo'; stemId: StemId; value: boolean }
  /**
   * Effect amount, 0 (dry) .. 1 (full). Currently: lowpass filter sweep +
   * resonance + tempo-synced echo send. This is NOT time-stretching.
   */
  | { type: 'setFx'; stemId: StemId; value: number }
  /**
   * DJ filter, -1 .. 1: negative = lowpass (darker), positive = highpass
   * (thinner), 0 = off. Independent of setFx.
   */
  | { type: 'setFilter'; stemId: StemId; value: number }
  /**
   * Loop this stem for `beats` beats, or exit the loop with null. The engine
   * engages/exits on the next beat boundary and stays phase-locked: exiting
   * rejoins the song where it would have been ("slip" loop). Ignored when the
   * tempo is unknown (see TransportState.bpm).
   */
  | { type: 'setLoop'; stemId: StemId; beats: LoopBeats | null }
  /**
   * Pull a loop clip out of a stem: the last `beats` beats you heard (ending
   * on the current beat) repeat as a new, independent voice `clipId`, starting
   * on the next beat. The clip then appears in `stems` (with `clipOf` set)
   * and takes every stem command (volume, mute, filter, fx...). While any
   * clip of a stem exists, the source stem is silenced (`ducked`), without
   * touching its fader or mute. Ignored when the tempo is unknown.
   */
  | { type: 'createClip'; stemId: StemId; clipId: StemId; beats: LoopBeats }
  /** Put a clip back: it stops on the next beat and the source stem comes back. `stemId` is the clip's id. */
  | { type: 'removeClip'; stemId: StemId };

export type PerformanceCommand =
  /**
   * Build tension on the master bus, 0 .. 1: highpass sweep, bass duck,
   * echo wash, noise riser. Does not touch any stem's fader / mute / solo.
   * 0 cancels smoothly. Ignored while a drop is pending.
   */
  | { type: 'setBuild'; value: number }
  /**
   * Release the build: the engine schedules the drop on the next bar
   * boundary (or immediately when the tempo is unknown), restores the
   * master bus, and plays an impact. No-op if there's no build.
   */
  | { type: 'drop' };

export type AudioCommand = StemCommand | PerformanceCommand;

export function isStemCommand(c: AudioCommand): c is StemCommand {
  return 'stemId' in c;
}

export interface AudioCommandSink {
  dispatch(command: AudioCommand): void;
}

/** An active (or scheduled) loop, in buffer seconds. */
export interface LoopState {
  beats: LoopBeats;
  startSec: number;
  endSec: number;
  /** False between the command and the beat boundary where it engages. */
  engaged: boolean;
}

/** Authoritative per-stem state, as reported by the engine. */
export interface StemState {
  pan: number;
  volume: number;
  muted: boolean;
  solo: boolean;
  /** Derived: false if muted, or another stem is soloed and this one isn't. */
  audible: boolean;
  fx: number;
  /** DJ filter, -1 (lowpass) .. 0 (off) .. 1 (highpass). */
  filter: number;
  loop: LoopState | null;
  /** True while some UI is holding the stem. */
  grabbed: boolean;
  /** For a loop clip: the stem it was pulled from. Null for real stems. */
  clipOf: StemId | null;
  /** True while this stem is silenced because a clip was pulled out of it. */
  ducked: boolean;
}

/** Master-bus performance state (build / drop). */
export interface PerformanceState {
  /** Current build amount, 0 .. 1. */
  build: number;
  /** A drop has been requested and is waiting for its bar boundary. */
  dropPending: boolean;
  /**
   * Wall-clock time (ms since epoch, `performance.timeOrigin + now`) when the
   * pending or most recent drop hits the speakers; null if none yet. Same in
   * every window, so visuals on both monitors can sync to it.
   */
  dropAtMs: number | null;
  /** True if the drop was quantized to the beat grid, false if tempo was unknown. */
  dropQuantized: boolean;
  /** Increments on every drop, so listeners can detect a new one. */
  drops: number;
}

/** Playback clock, so every window can compute beat position itself. */
export interface TransportState {
  playing: boolean;
  /** Null when the tempo is unknown (then loops are disabled and drops aren't quantized). */
  bpm: number | null;
  beatsPerBar: number;
  /**
   * Wall-clock time (ms since epoch) of a beat-1 downbeat on the song
   * timeline, valid while playing. beat = (nowMs - anchorMs) / 1000 * bpm / 60.
   */
  anchorMs: number | null;
  /** Song (master timeline) duration, seconds. */
  durationSec: number;
}

export interface AudioStateSource {
  readonly stems: ReadonlyMap<StemId, Readonly<StemState>>;
  readonly perf: Readonly<PerformanceState>;
  readonly transport: Readonly<TransportState>;
  /** Called after any state change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

export function defaultStemState(): StemState {
  return {
    pan: 0,
    volume: 1,
    muted: false,
    solo: false,
    audible: true,
    fx: 0,
    filter: 0,
    loop: null,
    grabbed: false,
    clipOf: null,
    ducked: false,
  };
}

export function defaultPerformanceState(): PerformanceState {
  return { build: 0, dropPending: false, dropAtMs: null, dropQuantized: false, drops: 0 };
}

/** Wall-clock ms comparable across windows. */
export function wallNow(): number {
  return performance.timeOrigin + performance.now();
}

/** Beat position (beats since the anchor downbeat) at wall time `ms`, or null. */
export function beatAt(transport: Readonly<TransportState>, ms: number = wallNow()): number | null {
  if (!transport.playing || transport.bpm === null || transport.anchorMs === null) return null;
  return ((ms - transport.anchorMs) / 1000) * (transport.bpm / 60);
}
