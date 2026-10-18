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
});
