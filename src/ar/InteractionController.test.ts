import { beforeEach, describe, expect, it } from 'vitest';
import { effectiveHalfWidth, LEVEL_HANDLE_ENABLED, levelHandle } from './HoloObject';
import { BLEND_SPAN, LEVEL_DEADZONE, LEVEL_TRAVEL } from './InteractionController';
import { defaultPositions } from './layout';
import { ASPECT, hand, Rig } from './testRig';

describe('InteractionController + stem audio bridge', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = new Rig();
  });

  it('repositioning a stem moves it but sends no mix commands', () => {
    const drums = rig.stem('drums');
    const start = { ...drums.position };
    const path = Array.from({ length: 12 }, (_, i) => ({ x: start.x + i * 0.02, y: start.y - i * 0.02 }));
    rig.pinchDrag('Right', path);

    expect(drums.position.x).toBeGreaterThan(start.x + 0.1);
    expect(drums.position.y).toBeLessThan(start.y - 0.1);
    for (const type of ['setVolume', 'setPan', 'setMute', 'setSolo']) expect(rig.commands(type)).toHaveLength(0);
    expect(rig.commands('grab')).toHaveLength(1);
    expect(rig.commands('release')).toHaveLength(1);
    expect(drums.holders).toHaveLength(0);
  });

  it('closing the hand after moving away from a stem does not grab it from a distance', () => {
    const drums = rig.stem('drums');
    const p = { ...drums.position };
    for (let i = 0; i < 4; i++) rig.frame(hand('Left', p, 'idle'));
    // Hand drops well below the stem within a couple of frames, then closes.
    rig.frame(hand('Left', { x: p.x, y: p.y + 0.15 }, 'idle'));
    rig.frame(hand('Left', { x: p.x, y: p.y + 0.3 }, 'start'));
    rig.frame(hand('Left', { x: p.x, y: p.y + 0.3 }, 'held'));
    expect(drums.holders).toHaveLength(0);
    expect(rig.commands('grab')).toHaveLength(0);
  });

  it('closing the hand just before arriving on a stem still grabs it', () => {
    const drums = rig.stem('drums');
    const p = { ...drums.position };
    // Approach from the open center of the frame.
    const off = { x: p.x + 0.3, y: p.y };
    for (let i = 0; i < 4; i++) rig.frame(hand('Left', off, 'idle'));
    rig.frame(hand('Left', off, 'start'));
    rig.frame(hand('Left', { x: p.x + 0.15, y: p.y }, 'held'));
    for (let i = 0; i < 4; i++) rig.frame(hand('Left', p, 'held'));
    expect(drums.holders).toEqual(['Left']);
  });

  it('a fist held closed for a while does not pick up stems it sweeps over', () => {
    const drums = rig.stem('drums');
    const p = { ...drums.position };
    const off = { x: p.x + 0.3, y: p.y };
    for (let i = 0; i < 4; i++) rig.frame(hand('Left', off, 'idle'));
    rig.frame(hand('Left', off, 'start'));
    for (let i = 0; i < 12; i++) rig.frame(hand('Left', off, 'held'));
    for (let i = 0; i < 4; i++) rig.frame(hand('Left', p, 'held'));
    expect(drums.holders).toHaveLength(0);
  });

  it('a quick pinch-tap toggles mute and leaves the stem in place', () => {
    const vocals = rig.stem('vocals');
    const start = { ...vocals.position };
    rig.pinchDrag('Left', [start]);
    expect(rig.engine.stems.get('vocals')!.muted).toBe(true);
    expect(vocals.position).toEqual(start);

    rig.t += 500;
    rig.pinchDrag('Left', [start]);
    expect(rig.engine.stems.get('vocals')!.muted).toBe(false);
  });

  it('a slow hold without moving is not a tap', () => {
    const vocals = rig.stem('vocals');
    rig.pinchDrag('Left', Array(15).fill(vocals.position));
    expect(rig.commands('setMute')).toHaveLength(0);
  });

  it.skipIf(!LEVEL_HANDLE_ENABLED)('dragging the level handle changes volume relatively and does not move the stem', () => {
    const bass = rig.stem('bass');
    const start = { ...bass.position };
    const { dx } = levelHandle(bass);
    const handleX = bass.position.x + dx / ASPECT;
    // Start mid-track (no jump), then move down past the dead zone by half the travel.
    const y0 = bass.position.y;
    const drop = LEVEL_DEADZONE + LEVEL_TRAVEL / 2;
    const path = Array.from({ length: 10 }, (_, i) => ({ x: handleX, y: y0 + (i / 9) * drop }));
    rig.pinchDrag('Right', path);

    const vol = rig.engine.stems.get('bass')!.volume;
    expect(vol).toBeCloseTo(0.5, 1);
    expect(bass.position).toEqual(start);
    expect(bass.levelHand).toBeNull();
  });

  it('two hands manipulate two stems independently', () => {
    const drums = rig.stem('drums');
    const bass = rig.stem('bass');
    const d0 = { ...drums.position };
    const b0 = { ...bass.position };
    for (let i = 0; i < 4; i++) rig.frame(hand('Left', d0, 'idle'), hand('Right', b0, 'idle'));
    rig.frame(hand('Left', d0, 'start'), hand('Right', b0, 'start'));
    for (let i = 1; i <= 10; i++) {
      rig.frame(
        hand('Left', { x: d0.x, y: d0.y - i * 0.02 }, 'held'),
        hand('Right', { x: b0.x, y: b0.y + i * 0.02 }, 'held'),
      );
    }
    expect(drums.holders).toEqual(['Left']);
    expect(bass.holders).toEqual(['Right']);
    expect(drums.position.y).toBeLessThan(d0.y - 0.15);
    expect(bass.position.y).toBeGreaterThan(b0.y + 0.15);
  });

  it.skipIf(!LEVEL_HANDLE_ENABLED)('small hand drift on the fader does not change volume', () => {
    const bass = rig.stem('bass');
    const { dx } = levelHandle(bass);
    const h = { x: bass.position.x + dx / ASPECT, y: bass.position.y };
    rig.pinchDrag('Right', Array.from({ length: 10 }, (_, i) => ({ x: h.x, y: h.y + (i % 2 ? 1 : -1) * LEVEL_DEADZONE * 0.45 })));
    expect(rig.engine.stems.get('bass')!.volume).toBe(1);
  });

  it('a second hand stretches a held stem; FX persists after release', () => {
    const vocals = rig.stem('vocals');
    const c = { ...vocals.position };
    const left = { x: c.x - 0.05, y: c.y };
    const right = { x: c.x + 0.05, y: c.y };
    for (let i = 0; i < 4; i++) rig.frame(hand('Left', left, 'idle'), hand('Right', right, 'idle'));
    rig.frame(hand('Left', left, 'start'), hand('Right', right, 'idle'));
    rig.frame(hand('Left', left, 'held'), hand('Right', right, 'start'));
    for (let i = 1; i <= 10; i++) {
      rig.frame(hand('Left', { x: left.x - i * 0.02, y: c.y }, 'held'), hand('Right', { x: right.x + i * 0.02, y: c.y }, 'held'));
    }
    const fx = rig.engine.stems.get('vocals')!.fx;
    expect(fx).toBeGreaterThan(0.5);

    rig.frame(hand('Left', { x: left.x - 0.2, y: c.y }, 'end'), hand('Right', { x: right.x + 0.2, y: c.y }, 'end'));
    rig.frame();
    expect(vocals.holders).toHaveLength(0);
    expect(rig.engine.stems.get('vocals')!.fx).toBeCloseTo(fx, 2);
  });

  it('stretching: the stem ends follow the hands, and a second hand can join from just outside', () => {
    const vocals = rig.stem('vocals');
    const c = { ...vocals.position };
    const half = effectiveHalfWidth(vocals);
    const left = { x: c.x - (half * 0.8) / ASPECT, y: c.y };
    // Second hand starts a little beyond the right end (outside the normal hitbox).
    const right = { x: c.x + (half + 0.12) / ASPECT, y: c.y };
    for (let i = 0; i < 4; i++) rig.frame(hand('Left', left, 'idle'), hand('Right', right, 'idle'));
    rig.frame(hand('Left', left, 'start'), hand('Right', right, 'idle'));
    for (let i = 0; i < 4; i++) rig.frame(hand('Left', left, 'held'), hand('Right', right, 'start'));
    expect(vocals.holders).toEqual(['Left', 'Right']);

    const w0 = effectiveHalfWidth(vocals) * 2;
    const spread = 0.1; // each hand moves out by this (view-height units)
    for (let i = 1; i <= 5; i++) {
      const d = (spread * i) / 5 / ASPECT;
      rig.frame(hand('Left', { x: left.x - d, y: c.y }, 'held'), hand('Right', { x: right.x + d, y: c.y }, 'held'));
    }
    // Width grew by the same amount the hands spread apart (1:1).
    expect(effectiveHalfWidth(vocals) * 2 - w0).toBeCloseTo(2 * spread, 2);
  });

  it('blend: pulling two held stems apart isolates them (others duck); bringing them back restores the mix', () => {
    const drums = rig.stem('drums');
    const bass = rig.stem('bass');
    const d0 = { ...drums.position };
    const b0 = { ...bass.position };
    for (let i = 0; i < 4; i++) rig.frame(hand('Left', d0, 'idle'), hand('Right', b0, 'idle'));
    rig.frame(hand('Left', d0, 'start'), hand('Right', b0, 'start'));
    // Grabbing alone changes nothing.
    rig.frame(hand('Left', d0, 'held'), hand('Right', b0, 'held'));
    expect(rig.engine.stems.get('vocals')!.volume).toBe(1);

    // Pull apart (along the line between the hands) by the full blend span -> vocals fully ducked, pair untouched.
    const apart = (k: number) => [
      hand('Left', { x: d0.x - (k * BLEND_SPAN) / 2 / ASPECT, y: d0.y }, 'held'),
      hand('Right', { x: b0.x + (k * BLEND_SPAN) / 2 / ASPECT, y: b0.y }, 'held'),
    ];
    for (let i = 1; i <= 8; i++) rig.frame(...apart(i / 8));
    expect(rig.engine.stems.get('vocals')!.volume).toBeLessThan(0.05);
    expect(rig.engine.stems.get('drums')!.volume).toBe(1);
    expect(rig.engine.stems.get('bass')!.volume).toBe(1);

    // Back together -> vocals restored exactly.
    for (let i = 7; i >= 0; i--) rig.frame(...apart(i / 8));
    expect(rig.engine.stems.get('vocals')!.volume).toBe(1);
  });

  it('blend isolation persists after letting go', () => {
    const drums = rig.stem('drums');
    const bass = rig.stem('bass');
    const d0 = { ...drums.position };
    const b0 = { ...bass.position };
    for (let i = 0; i < 4; i++) rig.frame(hand('Left', d0, 'idle'), hand('Right', b0, 'idle'));
    rig.frame(hand('Left', d0, 'start'), hand('Right', b0, 'start'));
    for (let i = 1; i <= 6; i++) {
      rig.frame(hand('Left', { x: d0.x - i * 0.01, y: d0.y }, 'held'), hand('Right', { x: b0.x + i * 0.01, y: b0.y }, 'held'));
    }
    const ducked = rig.engine.stems.get('vocals')!.volume;
    expect(ducked).toBeLessThan(0.9);
    rig.frame(hand('Left', { x: d0.x - 0.06, y: d0.y }, 'end'), hand('Right', { x: b0.x + 0.06, y: b0.y }, 'end'));
    rig.frame();
    expect(rig.engine.stems.get('vocals')!.volume).toBeCloseTo(ducked, 2);
  });

  it('a hand that leaves the frame releases what it held', () => {
    const drums = rig.stem('drums');
    const p = { ...drums.position };
    for (let i = 0; i < 4; i++) rig.frame(hand('Left', p, 'idle'));
    rig.frame(hand('Left', p, 'start'));
    rig.frame(hand('Left', p, 'held'));
    expect(drums.holders).toEqual(['Left']);
    rig.frame(); // hand gone (perception's grace period has already expired)
    expect(drums.holders).toHaveLength(0);
    expect(rig.commands('release')).toHaveLength(1);
  });

  it.skipIf(!LEVEL_HANDLE_ENABLED)('a hand cannot take a stem another hand is adjusting the level of', () => {
    const bass = rig.stem('bass');
    const { dx } = levelHandle(bass);
    const h = { x: bass.position.x + dx / ASPECT, y: bass.position.y };
    for (let i = 0; i < 4; i++) rig.frame(hand('Right', h, 'idle'), hand('Left', h, 'idle'));
    rig.frame(hand('Right', h, 'start'), hand('Left', h, 'idle'));
    rig.frame(hand('Right', h, 'held'), hand('Left', h, 'start'));
    rig.frame(hand('Right', h, 'held'), hand('Left', h, 'held'));
    expect(bass.levelHand).toBe('Right');
    // The handle is taken, and the body is owned by the leveling hand, so Left gets nothing.
    expect(bass.holders).toHaveLength(0);
    expect(rig.commands('grab')).toHaveLength(1);
  });

  it('dropping a stem onto another pushes them apart so they never overlap', () => {
    const drums = rig.stem('drums');
    const vocals = rig.stem('vocals');
    const from = { ...drums.position };
    const to = { ...vocals.position };
    // Drag slowly (no flick) and let go right on top of vocals.
    rig.pinchDrag('Left', Array.from({ length: 40 }, (_, i) => ({ x: from.x + ((to.x - from.x) * i) / 39, y: from.y + ((to.y - from.y) * i) / 39 })).concat(Array(6).fill(to)));
    for (let i = 0; i < 40; i++) rig.frame();
    const dx = Math.abs(drums.position.x - vocals.position.x) * ASPECT;
    const dy = Math.abs(drums.position.y - vocals.position.y);
    const sepX = drums.halfSize.x + vocals.halfSize.x + 0.04;
    const sepY = 2 * (drums.halfSize.y + 0.035);
    expect(dx >= sepX - 1e-3 || dy >= sepY - 1e-3).toBe(true);
  });

  it('a fast release flicks the stem; it glides on and stays on screen', () => {
    const drums = rig.stem('drums');
    const p0 = { ...drums.position };
    // Fast drag toward the open center, then let go mid-motion.
    rig.pinchDrag('Left', Array.from({ length: 6 }, (_, i) => ({ x: p0.x + i * 0.02, y: p0.y })));
    const atRelease = drums.position.x;
    for (let i = 0; i < 60; i++) rig.frame();
    expect(drums.position.x).toBeGreaterThan(atRelease + 0.03);
    expect(drums.position.x).toBeLessThan(1);
  });

  it('reset layout eases free stems back to their default positions', () => {
    const drums = rig.stem('drums');
    const home = { ...drums.position };
    rig.pinchDrag('Right', Array.from({ length: 10 }, (_, i) => ({ x: home.x + i * 0.03, y: home.y })));
    expect(drums.position.x).toBeGreaterThan(home.x + 0.1);

    rig.controller.resetLayout(defaultPositions(ASPECT));
    for (let i = 0; i < 40; i++) rig.frame();
    expect(drums.position.x).toBeCloseTo(home.x, 3);
    expect(drums.position.y).toBeCloseTo(home.y, 3);
  });
});
