/**
 * Shared interface between interaction code and the audio engine.
 *
 * Interaction code only ever calls `sink.dispatch(command)`; the audio engine
 * implements AudioCommandSink. Neither side imports the other's internals.
 */

export type StemId = string;

export type AudioCommand =
  /** Object picked up by a hand. */
  | { type: 'grab'; stemId: StemId }
  /** Object let go. */
  | { type: 'release'; stemId: StemId }
  /** Stereo position, -1 (left) .. 1 (right). */
  | { type: 'setPan'; stemId: StemId; value: number }
  /** Gain, 0 (silent) .. 1 (full). */
  | { type: 'setVolume'; stemId: StemId; value: number }
  /**
   * Two-hand stretch amount, 0 (none) .. 1 (full). The engine decides what it
   * means sonically (e.g. filter sweep, reverb, time-stretch).
   */
  | { type: 'setStretch'; stemId: StemId; value: number };

export interface AudioCommandSink {
  dispatch(command: AudioCommand): void;
}
