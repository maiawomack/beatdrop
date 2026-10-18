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
  /**
   * "Lift" pose: hand upside down with the fingertips bunched together and
   * pointing down, like holding something up by a string. Used for
   * build/drop: lift it to build, let go (open the fingers) to drop.
   * Point is the bunched fingertips. Optional so older recordings still load.
   */
  lift?: GestureState;
  /**
   * Open palm: fingers extended and spread (the opposite of a fist). Used to
   * hold the crossfader and to scratch a record. Point is the palm center.
   * Optional so older recordings still load.
   */
  palm?: GestureState;
  /**
   * Fingers up (☝ or ✌): index extended and pointing up (middle either way),
   * ring and pinky curled. Holds the crossfader. Point is the index tip.
   * Optional so older recordings still load.
   */
  twoUp?: GestureState;
  /**
   * The hand is lying flat, palm down (like resting on a turntable), measured
   * from the 3D palm normal with hysteresis. Optional so older recordings load.
   */
  flat?: boolean;
  /**
   * The palm faces the camera (3D palm normal pointing at the lens, fingers
   * not hanging down), with hysteresis. Optional so older recordings load.
   */
  facing?: boolean;
  /** Fingers hanging down the image (wrist above the knuckles), e.g. the lift pose. */
  fingersDown?: boolean;
  /** Raw facing amount, 0 (side-on / flat) .. 1 (palm straight at the camera), for tuning. */
  facingAmount?: number;
  /**
   * Apparent palm size in the image (view-height units, smoothed). Grows as
   * the hand moves toward the camera, so it tracks back-and-forth depth.
   */
  scale?: number;
  /**
   * Smoothed in-plane hand rotation, radians, view space (y down, so
   * increasing = clockwise as the user sees it): angle of wrist -> middle
   * knuckle. Robust in a fist. Optional so older recordings still load.
   */
  roll?: number;
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
