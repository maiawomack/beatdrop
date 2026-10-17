import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { toViewSpace } from './coords';
import type { HandId, RawHand } from './types';

// Keep the wasm version in sync with @mediapipe/tasks-vision in package.json.
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

/**
 * MediaPipe labels handedness assuming a mirrored (selfie) image. We feed it
 * the raw, unmirrored webcam frame, so its labels are swapped relative to the
 * user's real hands. Flip this if the debug overlay shows the wrong label.
 */
const SWAP_HANDEDNESS = true;

export class HandTracker {
  private constructor(private landmarker: HandLandmarker) {}

  static async create(): Promise<HandTracker> {
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    const options = (delegate: 'GPU' | 'CPU') => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO' as const,
      numHands: 2,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.5,
    });

    try {
      return new HandTracker(await HandLandmarker.createFromOptions(fileset, options('GPU')));
    } catch (err) {
      console.warn('[HandTracker] GPU delegate failed, falling back to CPU', err);
      return new HandTracker(await HandLandmarker.createFromOptions(fileset, options('CPU')));
    }
  }

  /** @param timestamp must increase monotonically (ms). */
  detect(video: HTMLVideoElement, timestamp: number): RawHand[] {
    const result = this.landmarker.detectForVideo(video, timestamp);

    const hands: RawHand[] = result.landmarks.map((lms, i) => {
      const category = result.handedness[i]?.[0];
      const label = (category?.categoryName ?? 'Right') as HandId;
      return {
        id: SWAP_HANDEDNESS ? opposite(label) : label,
        confidence: category?.score ?? 0,
        landmarks: lms.map(toViewSpace),
      };
    });

    return resolveDuplicateIds(hands);
  }

  close(): void {
    this.landmarker.close();
  }
}

function opposite(id: HandId): HandId {
  return id === 'Left' ? 'Right' : 'Left';
}

/**
 * MediaPipe occasionally labels both hands the same. When that happens,
 * assign by screen position: the hand further left in view is 'Left'.
 */
function resolveDuplicateIds(hands: RawHand[]): RawHand[] {
  if (hands.length !== 2 || hands[0].id !== hands[1].id) return hands;
  const [a, b] = hands;
  const aIsLeft = a.landmarks[0].x < b.landmarks[0].x;
  a.id = aIsLeft ? 'Left' : 'Right';
  b.id = aIsLeft ? 'Right' : 'Left';
  return hands;
}
