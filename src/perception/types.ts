/**
 * Public types for the perception pipeline.
 *
 * Coordinate convention ("view space"): every point is normalized to [0, 1],
 * origin top-left, ALREADY MIRRORED so x matches what the user sees on the
 * mirrored webcam display. Consumers never need to flip anything.
 */

/** The user's actual hand (not MediaPipe's raw label). */
export type HandId = 'Left' | 'Right';

export interface Point2 {
  x: number;
  y: number;
}

export interface Landmark extends Point2 {
  /** Depth relative to the wrist; smaller = closer to the camera. */
  z: number;
}

/**
 * idle  -> not pinching
 * start -> pinch began this frame
 * held  -> pinch continuing
 * end   -> pinch released this frame (or the hand was lost while pinching)
 */
export type PinchPhase = 'idle' | 'start' | 'held' | 'end';

export interface PinchState {
  phase: PinchPhase;
  /** True for 'start' and 'held'. */
  active: boolean;
  /** Smoothed midpoint between thumb tip and index tip, view space. */
  point: Point2;
  /** Thumb-index distance divided by palm size; ~0.1 closed, ~1+ open. */
  ratio: number;
}

export interface HandState {
  id: HandId;
  /** False while in the short grace period after the hand disappears. */
  tracked: boolean;
  confidence: number;
  /** 21 MediaPipe landmarks in view space (last known if not tracked). */
  landmarks: Landmark[];
  pinch: PinchState;
}

export interface PerceptionFrame {
  /** performance.now() timestamp of the processed video frame. */
  timestamp: number;
  hands: HandState[];
}

/** Single detection straight from the tracker, before gesture processing. */
export interface RawHand {
  id: HandId;
  confidence: number;
  landmarks: Landmark[];
}
