import { beforeEach, describe, expect, it } from 'vitest';
import type { HandId, Point2 } from '../perception';
import { LEVEL_DEADZONE, LEVEL_TRAVEL, VOLUME_MAX_RATE } from './InteractionController';
import { FRAME_MS, hand, Rig } from './testRig';

/** Deck stems are locked in their column: grab + up/down = volume, two hands apart vertically = taller (FX). */
describe('locked deck stems', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = new Rig();
    for (const s of rig.stems) s.locked = true;
  });

  const grab = (id: HandId, p: Point2) => {
    for (let i = 0; i < 4; i++) rig.frame(hand(id, p, 'idle'));
    rig.frame(hand(id, p, 'start'));
  };
  const move = (id: HandId, from: Point2, to: Point2, n: number) => {
    for (let i = 1; i <= n; i++) {
      const k = i / n;
      rig.frame(hand(id, { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k }, 'held'));
    }
  };

  it('grab and move up raises the volume; the stem stays put', () => {
    rig.engine.dispatch({ type: 'setVolume', stemId: 'drums', value: 0.5 });
    const drums = rig.stem('drums');
    const home = { ...drums.position };
    grab('Right', home);
    const up = { x: home.x + 0.1, y: home.y - (LEVEL_DEADZONE + LEVEL_TRAVEL * 0.25) };
    move('Right', home, up, 12);
    for (let i = 0; i < 10; i++) rig.frame(hand('Right', up, 'held'));
    expect(rig.engine.stems.get('drums')!.volume).toBeCloseTo(0.75, 2);
    expect(drums.position).toEqual(home);
    expect(rig.controller.handModes.get('Right')).toBe('volume');
    rig.frame(hand('Right', up, 'end'));
    expect(drums.position).toEqual(home);
    expect(rig.engine.stems.get('drums')!.muted).toBe(false); // a slow move is not a tap
  });

  it('moving down lowers it, never below 0', () => {
    const vocals = rig.stem('vocals');
    const p = { ...vocals.position };
    grab('Left', p);
    move('Left', p, { x: p.x, y: p.y + 0.6 }, 20);
    for (let i = 0; i < 20; i++) rig.frame(hand('Left', { x: p.x, y: p.y + 0.6 }, 'held'));
    expect(rig.engine.stems.get('vocals')!.volume).toBe(0);
  });

  it('a one-frame tracking glitch cannot jump the volume', () => {
    rig.engine.dispatch({ type: 'setVolume', stemId: 'bass', value: 0.5 });
    const bass = rig.stem('bass');
    const p = { ...bass.position };
    grab('Right', p);
    rig.frame(hand('Right', { x: p.x, y: p.y - 0.4 }, 'held')); // glitch
    rig.frame(hand('Right', p, 'held'));
    const vols = (rig.commands('setVolume') as { stemId: string; value: number }[]).filter((c) => c.stemId === 'bass').map((c) => c.value);
    expect(Math.max(...vols)).toBeLessThanOrEqual(0.5 + VOLUME_MAX_RATE * (FRAME_MS / 1000) + 1e-9);
  });

  it('a quick tap still mutes', () => {
    rig.pinchDrag('Right', [{ ...rig.stem('drums').position }]);
    expect(rig.engine.stems.get('drums')!.muted).toBe(true);
  });

  it('two hands pulled apart vertically stretch it taller (FX); horizontally they do not', () => {
    const drums = rig.stem('drums');
    const p = { ...drums.position };
    const a = { x: p.x - 0.05, y: p.y };
    const b = { x: p.x + 0.05, y: p.y };
    for (let i = 0; i < 4; i++) rig.frame(hand('Left', a, 'idle'), hand('Right', b, 'idle'));
    rig.frame(hand('Left', a, 'start'), hand('Right', b, 'start'));
    rig.frame(hand('Left', a, 'held'), hand('Right', b, 'held'));
    expect(drums.holders).toHaveLength(2);
    // Sideways: no stretch.
    for (let i = 1; i <= 8; i++) rig.frame(hand('Left', { x: a.x - 0.02 * i, y: p.y }, 'held'), hand('Right', { x: b.x + 0.02 * i, y: p.y }, 'held'));
    expect(drums.stretchAmount).toBeCloseTo(0, 5);
    // Vertical: stretch.
    for (let i = 1; i <= 10; i++) rig.frame(hand('Left', { x: a.x, y: p.y - 0.015 * i }, 'held'), hand('Right', { x: b.x, y: p.y + 0.015 * i }, 'held'));
    expect(drums.stretchAmount).toBeGreaterThan(0.4);
    expect(drums.position).toEqual(p);
    expect(rig.controller.handModes.get('Left')).toBe('stretching');
  });

  it('when one stretching hand lets go, the other does not jump the volume', () => {
    const drums = rig.stem('drums');
    const p = { ...drums.position };
    const a = { x: p.x - 0.05, y: p.y };
    const b = { x: p.x + 0.05, y: p.y };
    for (let i = 0; i < 4; i++) rig.frame(hand('Left', a, 'idle'), hand('Right', b, 'idle'));
    rig.frame(hand('Left', a, 'start'), hand('Right', b, 'start'));
    // Right hand goes far down while stretching, then Left lets go.
    const low = { x: b.x, y: p.y + 0.3 };
    for (let i = 1; i <= 10; i++) rig.frame(hand('Left', a, 'held'), hand('Right', { x: b.x, y: p.y + 0.03 * i }, 'held'));
    rig.frame(hand('Left', a, 'end'), hand('Right', low, 'held'));
    for (let i = 0; i < 6; i++) rig.frame(hand('Right', low, 'held'));
    expect(rig.engine.stems.get('drums')!.volume).toBe(1);
  });
});
