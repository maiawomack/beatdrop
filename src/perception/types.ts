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
 * idle  -> gesture not engaged
 * start -> gesture began this frame
 * held  -> gesture continuing
 * end   -> gesture released this frame (or the hand was lost while engaged)
 */
export type GesturePhase = 'idle' | 'start' | 'held' | 'end';

/** Gestures that can be used to grab things. 'grab' = pinch OR grip. */
export type GrabGesture = 'pinch' | 'grip' | 'grab';

export interface GestureState {
  phase: GesturePhase;
  /** True for 'start' and 'held'. */
  active: boolean;
  /** Smoothed anchor point of the gesture, view space. */
  point: Point2;
  /**
   * Openness measure normalized by palm size; lower = more closed.
   * pinch: thumb-index tip distance   (~0.1 closed, ~1+ open)
   * grip:  mean fingertip-to-palm distance (~0.4 fist, ~1.1 open)
   */
  ratio: number;
  /** 0..1 how close the gesture is to engaging (1 = engaged). For feedback. */
  strength: number;
}

export interface HandState {
  id: HandId;
  /** False while in the short grace period after the hand disappears. */
  tracked: boolean;
  confidence: number;
  /** 21 MediaPipe landmarks in view space (last known if not tracked). */
  landmarks: Landmark[];
  /**
   * Smoothed knuckle centroid (thumb/index/middle MCP), view space. Barely
   * moves while fingers open/close, so it's the best point to drag with.
   */
  anchor: Point2;
  /** Thumb + index pinch; point is between the fingertips. */
  pinch: GestureState;
  /** Whole-hand grip (fist); point is the palm center. */
  grip: GestureState;
  /**
   * Pinch OR grip: engaged while either is. Point is always the thumb-index
   * midpoint so switching between the two mid-hold doesn't jump.
   * Ratio is the more-closed of the two, normalized so < 1 means engaged-ish.
   */
  grab: GestureState;
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
  /** Metric 3D landmarks (meters, hand-centered); robust to camera angle. */
  worldLandmarks: Landmark[];
}
