import { describe, expect, it } from 'vitest';
import { GestureProcessor } from './gestures';
import type { HandState, Landmark, RawHand } from './types';

/**
 * Synthetic 21-point hands in view space (also used as world landmarks).
 * `down` = fingers point down the image (the lift pose orientation).
 */
function makeHand(opts: { down: boolean; bunched: boolean }): RawHand {
  const lm: Landmark[] = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const s = opts.down ? 1 : -1; // +y = down the image
  const wrist = { x: 0.5, y: 0.5 - s * 0.12, z: 0 };
  lm[0] = wrist;
  // Knuckles across the hand, ~0.1 from the wrist.
  const mcpY = wrist.y + s * 0.1;
  [5, 9, 13, 17].forEach((i, k) => (lm[i] = { x: 0.47 + k * 0.02, y: mcpY, z: 0 }));
  // Finger joints between knuckle and tip.
  const tipY = wrist.y + s * 0.2;
  const spreadTips = [0.44, 0.49, 0.54, 0.58];
  [8, 12, 16, 20].forEach((tip, k) => {
    const x = opts.bunched ? 0.5 + k * 0.004 : spreadTips[k];
    lm[tip] = { x, y: tipY, z: 0 };
    lm[tip - 1] = { x, y: (mcpY + tipY) / 2 + s * 0.03, z: 0 };
    lm[tip - 2] = { x, y: (mcpY + tipY) / 2, z: 0 };
  });
  // Thumb: tip meets the fingertips when bunched, sticks out otherwise.
  lm[1] = { x: 0.53, y: wrist.y + s * 0.03, z: 0 };
  lm[2] = { x: 0.55, y: wrist.y + s * 0.07, z: 0 };
  lm[3] = { x: 0.55, y: wrist.y + s * 0.12, z: 0 };
  lm[4] = opts.bunched ? { x: 0.505, y: tipY - s * 0.01, z: 0 } : { x: 0.62, y: wrist.y + s * 0.12, z: 0 };
  return { id: 'Right', confidence: 1, landmarks: lm, worldLandmarks: lm.map((p) => ({ ...p })) };
}

function run(p: GestureProcessor, hand: RawHand, frames: number, t0: number): { t: number; last: HandState } {
  let last!: HandState;
  let t = t0;
  for (let i = 0; i < frames; i++, t += 33) last = p.update([structuredClone(hand)], t)[0];
  return { t, last };
}

describe('lift pose (fingertips bunched, pointing down)', () => {
  it('engages for the lift pose and releases when the fingers open', () => {
    const p = new GestureProcessor(1);
    let r = run(p, makeHand({ down: true, bunched: true }), 6, 0);
    expect(r.last.lift?.active).toBe(true);
    r = run(p, makeHand({ down: true, bunched: false }), 4, r.t);
    expect(r.last.lift?.active).toBe(false);
  });

  it('does not engage for an upright hand, bunched or open', () => {
    const p = new GestureProcessor(1);
    expect(run(p, makeHand({ down: false, bunched: true }), 6, 0).last.lift?.active).toBe(false);
    const q = new GestureProcessor(1);
    expect(run(q, makeHand({ down: false, bunched: false }), 6, 0).last.lift?.active).toBe(false);
  });

  it('a downward open hand is not a lift', () => {
    const p = new GestureProcessor(1);
    expect(run(p, makeHand({ down: true, bunched: false }), 6, 0).last.lift?.active).toBe(false);
  });

  it('a fist pointing down (the tempo fist) is a fist, not a lift', () => {
    // Bunched and pointing down like the lift pose, but the fingers are curled back behind
    // the knuckles onto the palm instead of reaching past them.
    const fist = makeHand({ down: true, bunched: true });
    const mcpY = fist.landmarks[9]!.y;
    [8, 12, 16, 20].forEach((tip, k) => {
      fist.landmarks[tip] = { x: 0.49 + k * 0.006, y: mcpY - 0.035, z: 0 };
      fist.landmarks[tip - 1] = { x: 0.49 + k * 0.006, y: mcpY + 0.02, z: 0 };
    });
    fist.landmarks[4] = { x: 0.5, y: mcpY - 0.02, z: 0 };
    fist.worldLandmarks = fist.landmarks.map((l) => ({ ...l }));
    const last = run(new GestureProcessor(1), fist, 6, 0).last;
    expect(last.lift?.active).toBe(false);
    expect(last.grip.active).toBe(true);
  });
});

describe('open palm', () => {
  it('an open, upright hand is a palm; the lift pose and a fist are not', () => {
    const p = new GestureProcessor(1);
    const open = run(p, makeHand({ down: false, bunched: false }), 6, 0).last;
    expect(open.palm?.active).toBe(true);
    expect(open.lift?.active).toBe(false);

    const q = new GestureProcessor(1);
    const lift = run(q, makeHand({ down: true, bunched: true }), 6, 0).last;
    expect(lift.lift?.active).toBe(true);
    expect(lift.palm?.active).toBe(false);

    // Fist: fingertips folded onto the palm.
    const fist = makeHand({ down: false, bunched: false });
    for (const tip of [8, 12, 16, 20]) fist.landmarks[tip] = { x: 0.5, y: 0.54, z: 0 }; // on the palm center
    fist.worldLandmarks = fist.landmarks.map((l) => ({ ...l }));
    const r = new GestureProcessor(1);
    expect(run(r, fist, 6, 0).last.palm?.active).toBe(false);
  });
});

describe('palm facing the camera', () => {
  it('an upright hand facing the camera faces it; lying flat or hanging down does not', () => {
    const upright = makeHand({ down: false, bunched: false });
    expect(run(new GestureProcessor(1), upright, 4, 0).last.facing).toBe(true);
    const flat = makeHand({ down: false, bunched: false });
    flat.worldLandmarks = flat.landmarks.map((l) => ({ x: l.x, y: 0.5, z: l.y }));
    const f = run(new GestureProcessor(1), flat, 4, 0).last;
    expect(f.facing).toBe(false);
    expect(f.flat).toBe(true);
    const hanging = makeHand({ down: true, bunched: false });
    expect(run(new GestureProcessor(1), hanging, 4, 0).last.facing).toBe(false);
  });
});

describe('two fingers up (✌)', () => {
  /** Upright hand with index + middle straight up, ring + pinky folded onto the palm. */
  function vSign(): RawHand {
    const h = makeHand({ down: false, bunched: false });
    for (const tip of [16, 20]) {
      h.landmarks[tip] = { x: h.landmarks[tip - 3]!.x, y: 0.55, z: 0 };
      h.landmarks[tip - 1] = { x: h.landmarks[tip - 3]!.x, y: 0.5, z: 0 };
    }
    h.landmarks[4] = { x: 0.5, y: 0.5, z: 0 }; // thumb tucked
    h.worldLandmarks = h.landmarks.map((l) => ({ ...l }));
    return h;
  }

  it('index and middle up with the others curled is a ✌', () => {
    const p = new GestureProcessor(1);
    const last = run(p, vSign(), 6, 0).last;
    expect(last.twoUp?.active).toBe(true);
    expect(last.pinch.active).toBe(false);
  });

  it('an open hand, a fist, and a downward V are not', () => {
    expect(run(new GestureProcessor(1), makeHand({ down: false, bunched: false }), 6, 0).last.twoUp?.active).toBe(false);
    const fist = makeHand({ down: false, bunched: false });
    for (const tip of [8, 12, 16, 20]) fist.landmarks[tip] = { x: 0.5, y: 0.54, z: 0 };
    fist.worldLandmarks = fist.landmarks.map((l) => ({ ...l }));
    expect(run(new GestureProcessor(1), fist, 6, 0).last.twoUp?.active).toBe(false);
    const down = vSign();
    for (const l of [...down.landmarks, ...down.worldLandmarks]) l.y = 1 - l.y; // flip upside down
    expect(run(new GestureProcessor(1), down, 6, 0).last.twoUp?.active).toBe(false);
  });
});

describe('one finger up (☝) also counts', () => {
  it('index up, the rest curled', () => {
    const h = makeHand({ down: false, bunched: false });
    for (const tip of [12, 16, 20]) {
      h.landmarks[tip] = { x: h.landmarks[tip - 3]!.x, y: 0.55, z: 0 };
      h.landmarks[tip - 1] = { x: h.landmarks[tip - 3]!.x, y: 0.5, z: 0 };
    }
    h.landmarks[4] = { x: 0.5, y: 0.5, z: 0 };
    h.worldLandmarks = h.landmarks.map((l) => ({ ...l }));
    expect(run(new GestureProcessor(1), h, 6, 0).last.twoUp?.active).toBe(true);
  });
});

describe('open palm with fingers together', () => {
  it('still counts as an open palm facing the camera', () => {
    const h = makeHand({ down: false, bunched: false });
    // Fingers side by side (not spread), thumb out to the side.
    [8, 12, 16, 20].forEach((tip, k) => {
      const x = 0.485 + k * 0.012;
      for (const j of [tip, tip - 1, tip - 2]) h.landmarks[j] = { ...h.landmarks[j]!, x };
    });
    h.worldLandmarks = h.landmarks.map((l) => ({ ...l }));
    const last = run(new GestureProcessor(1), h, 6, 0).last;
    expect(last.palm?.active).toBe(true);
    expect(last.facing).toBe(true);
    expect(last.twoUp?.active).toBe(false);
  });
});
