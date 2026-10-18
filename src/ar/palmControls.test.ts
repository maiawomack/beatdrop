import { beforeEach, describe, expect, it } from 'vitest';
import type { GesturePhase, HandId, Point2 } from '../perception';
import { FADE_TRAVEL, PINCH_ARM_MS, RECORD_TURNS_PER_SEC, SCRATCH_ARM_MS, SCRATCH_VIRTUAL_RADIUS, TWO_UP_ARM_MS } from './InteractionController';
import { ASPECT, FRAME_MS, gesture, hand, Rig } from './testRig';

/** Thumb + index pinch (not a fist). */
function pinch(id: HandId, p: Point2, phase: GesturePhase = 'held', fist = false) {
  return { ...hand(id, p, 'idle'), pinch: gesture(phase, p), grip: gesture(fist ? 'held' : 'idle', p) };
}

/** Two fingers up (✌). */
function twoUp(id: HandId, p: Point2, phase: GesturePhase = 'held') {
  return { ...hand(id, p, 'idle'), twoUp: gesture(phase, p) };
}

/** An open hand: palm engaged, grab idle. */
function palm(id: HandId, p: Point2, phase: GesturePhase = 'held', tracked = true, facing = true) {
  return { ...hand(id, p, 'idle', tracked), palm: gesture(phase, p), facing };
}

/** Expected scratch offset (s) for a sideways move of `dx` view-height units at the top of the invisible record. */
const sideways = (dx: number) => Math.atan2(dx, SCRATCH_VIRTUAL_RADIUS) / (2 * Math.PI) / RECORD_TURNS_PER_SEC;

describe('open-palm controls', () => {
  let rig: Rig;
  const rec = { x: 0.2, y: 0.2 };
  beforeEach(() => {
    rig = new Rig();
    rig.controller.platters = [{ deck: 'A', position: { ...rec }, radius: 0.1, color: '#4fd9d2', hover: 0, hand: null, offsetSec: 0 }];
    rig.controller.crossfadeZone = { x0: 0.36, x1: 0.64, y0: 0.35, y1: 1, arming: 0, hand: null };
  });

  const rest = (p: Point2, ms: number) => {
    rig.frame(palm('Right', p, 'start'));
    for (let t = 0; t < ms; t += FRAME_MS) rig.frame(palm('Right', p));
  };
  const scratches = () => rig.commands('scratch') as { phase: string; offsetSec: number }[];

  it('a palm resting on the record scratches: right = forward, left = backward; opening ends it', () => {
    rest(rec, SCRATCH_ARM_MS + 2 * FRAME_MS);
    expect(scratches()[0]).toMatchObject({ phase: 'start' });
    expect(rig.controller.handModes.get('Right')).toBe('scratching');
    expect(rig.engine.perf.scratching).toEqual(['A']);

    const right = { x: rec.x + 0.1 / ASPECT, y: rec.y };
    rig.frame(palm('Right', right));
    expect(scratches().at(-1)!.offsetSec).toBeCloseTo(sideways(0.1), 5);
    const left = { x: rec.x - 0.05 / ASPECT, y: rec.y };
    rig.frame(palm('Right', left));
    expect(scratches().at(-1)!.offsetSec).toBeCloseTo(sideways(-0.05), 5);

    rig.frame(palm('Right', left, 'end'));
    expect(scratches().at(-1)).toMatchObject({ phase: 'end' });
    expect(rig.engine.perf.scratching).toEqual([]);
  });

  it('passing over the record, or touching it with a fist, does not scratch', () => {
    rig.frame(palm('Right', { x: rec.x - 0.1, y: rec.y }, 'start'));
    rig.frame(palm('Right', rec));
    rig.frame(palm('Right', { x: rec.x + 0.1, y: rec.y }));
    rig.pinchDrag('Left', [rec, { x: rec.x + 0.02, y: rec.y }]);
    expect(scratches()).toHaveLength(0);
  });

  it('a palm on the right half never takes deck A, even when A is the only deck loaded', () => {
    // Deck A's record sits on the left; an open palm resting on the right side stays idle.
    rest({ x: 0.8, y: 0.5 }, SCRATCH_ARM_MS + 4 * FRAME_MS);
    expect(scratches()).toHaveLength(0);
    // The same palm on the left half (off the record) does take deck A.
    rig.frame(palm('Right', { x: 0.8, y: 0.5 }, 'end'));
    rest({ x: 0.3, y: 0.6 }, SCRATCH_ARM_MS + 2 * FRAME_MS);
    expect(scratches()[0]).toMatchObject({ phase: 'start' });
  });

  it('an open-palm scratch keeps going wherever the hand moves (only opening / turning it lets go)', () => {
    rest(rec, SCRATCH_ARM_MS + 2 * FRAME_MS);
    rig.frame(palm('Right', { x: 0.6, y: 0.6 }));
    expect(scratches().at(-1)).toMatchObject({ phase: 'move' });
  });

  it('losing the hand ends the scratch', () => {
    rest(rec, SCRATCH_ARM_MS + 2 * FRAME_MS);
    rig.frame(palm('Right', rec, 'end', false));
    expect(scratches().at(-1)).toMatchObject({ phase: 'end' });
  });


  it('two fingers up and slide side to side crossfades, relative to where it started', () => {
    const p = { x: 0.5, y: 0.6 };
    rig.frame(twoUp('Right', p, 'start'));
    for (let t = 0; t <= TWO_UP_ARM_MS + FRAME_MS; t += FRAME_MS) rig.frame(twoUp('Right', p));
    expect(rig.controller.handModes.get('Right')).toBe('crossfading');
    const to = { x: p.x + FADE_TRAVEL / 2 / ASPECT, y: p.y };
    for (let i = 1; i <= 10; i++) rig.frame(twoUp('Right', { x: p.x + (to.x - p.x) * (i / 10), y: p.y }));
    for (let i = 0; i < 10; i++) rig.frame(twoUp('Right', to));
    expect(rig.engine.perf.crossfader).toBeCloseTo(1, 5);
    const back = { x: p.x - FADE_TRAVEL / 2 / ASPECT, y: p.y };
    for (let i = 1; i <= 20; i++) rig.frame(twoUp('Right', { x: to.x + (back.x - to.x) * (i / 20), y: p.y }));
    for (let i = 0; i < 15; i++) rig.frame(twoUp('Right', back));
    expect(rig.engine.perf.crossfader).toBeCloseTo(-1, 5);
    rig.frame(twoUp('Right', back, 'end'));
    expect(rig.controller.crossfadeZone!.hand).toBeNull();
    for (const c of rig.commands('setCrossfader') as { value: number }[]) expect(Math.abs(c.value)).toBeLessThanOrEqual(1);
  });

  it('a pinch in open space no longer crossfades', () => {
    const p = { x: 0.5, y: 0.6 };
    rig.frame(pinch('Right', p, 'start'));
    for (let t = 0; t <= PINCH_ARM_MS + 3 * FRAME_MS; t += FRAME_MS) rig.frame(pinch('Right', { x: p.x + t / 5000, y: p.y }));
    expect(rig.commands('setCrossfader')).toHaveLength(0);
  });

  it('a quick pinch on the way to a fist never touches the crossfader', () => {
    const p = { x: 0.5, y: 0.6 };
    rig.frame(pinch('Right', p, 'start'));
    rig.frame(pinch('Right', p, 'held', true)); // closes into a fist before arming
    for (let i = 0; i < 10; i++) rig.frame(pinch('Right', { x: p.x + 0.02 * i, y: p.y }, 'held', true));
    expect(rig.commands('setCrossfader')).toHaveLength(0);
  });

  it('an open palm anywhere scratches the deck on that side; closing it lets go', () => {
    rig.controller.platters.push({ deck: 'B', position: { x: 0.8, y: 0.2 }, radius: 0.1, color: '#c47be8', hover: 0, hand: null, offsetSec: 0 });
    const low = { x: 0.3, y: 0.7 }; // left half, far from the records
    rest(low, SCRATCH_ARM_MS + 2 * FRAME_MS);
    expect(rig.controller.handModes.get('Right')).toBe('scratching');
    expect(rig.engine.perf.scratching).toEqual(['A']);
    rig.frame(palm('Right', { x: low.x + 0.1 / ASPECT, y: low.y }));
    expect(scratches().at(-1)!.offsetSec).toBeCloseTo(sideways(0.1), 5);
    rig.frame(palm('Right', { x: low.x + 0.1 / ASPECT, y: low.y }, 'end'));
    expect(scratches().at(-1)).toMatchObject({ phase: 'end' });
    for (let i = 0; i < 3; i++) rig.frame();
    rest({ x: 0.7, y: 0.7 }, SCRATCH_ARM_MS + 2 * FRAME_MS);
    expect(rig.engine.perf.scratching).toEqual(['B']);
  });

  it('rocking the open palm at the wrist (tilting it) turns the record', () => {
    const p = { x: 0.3, y: 0.7 };
    const rocking = (roll: number, phase: GesturePhase = 'held') => ({ ...palm('Right', p, phase), roll });
    const up = -Math.PI / 2; // wrist -> knuckles pointing up the screen
    rig.frame(rocking(up, 'start'));
    for (let t = 0; t <= SCRATCH_ARM_MS + FRAME_MS; t += FRAME_MS) rig.frame(rocking(up));
    for (let i = 1; i <= 5; i++) rig.frame(rocking(up + (i / 5) * (Math.PI / 4))); // tilt 45° clockwise, hand stays put
    expect(scratches().at(-1)!.offsetSec).toBeCloseTo(0.125 / RECORD_TURNS_PER_SEC, 3);
    for (let i = 1; i <= 5; i++) rig.frame(rocking(up + Math.PI / 4 - (i / 5) * (Math.PI / 2))); // back past the start
    expect(scratches().at(-1)!.offsetSec).toBeCloseTo(-0.125 / RECORD_TURNS_PER_SEC, 3);
  });

  it('moving in an arc turns the record: a quarter turn forward, then back, like a real deck', () => {
    const start = { x: 0.3, y: 0.6 };
    const R = SCRATCH_VIRTUAL_RADIUS;
    const c = { x: start.x, y: start.y + R }; // the invisible record's center
    const onArc = (deg: number) => {
      const a = (deg * Math.PI) / 180;
      return { x: c.x + (Math.sin(a) * R) / ASPECT, y: c.y - Math.cos(a) * R };
    };
    rest(start, SCRATCH_ARM_MS + 2 * FRAME_MS);
    // Fast: a quarter turn clockwise in 4 frames (~130 ms), then back past the start.
    for (let i = 1; i <= 4; i++) rig.frame(palm('Right', onArc(22.5 * i)));
    const quarter = 0.25 / RECORD_TURNS_PER_SEC; // 0.45 s
    expect(scratches().at(-1)!.offsetSec).toBeCloseTo(quarter, 3);
    for (let i = 1; i <= 6; i++) rig.frame(palm('Right', onArc(90 - 22.5 * i)));
    expect(scratches().at(-1)!.offsetSec).toBeCloseTo(-0.5 * quarter, 3);
  });

  it('on a record, the hand turns that record around its own center', () => {
    const pl = rig.controller.platters[0]!;
    const rim = (deg: number) => {
      const a = (deg * Math.PI) / 180;
      const r = pl.radius * 0.8;
      return { x: pl.position.x + (Math.sin(a) * r) / ASPECT, y: pl.position.y - Math.cos(a) * r };
    };
    rest(rim(-30), SCRATCH_ARM_MS + 2 * FRAME_MS);
    for (let i = 1; i <= 6; i++) rig.frame(palm('Right', rim(-30 + 10 * i)));
    expect(scratches().at(-1)!.offsetSec).toBeCloseTo(60 / 360 / RECORD_TURNS_PER_SEC, 3);
  });

  it('fingers hanging down, or a hand that is not an open palm, does not scratch', () => {
    const p = { x: 0.3, y: 0.7 };
    rig.frame({ ...palm('Right', p, 'start'), fingersDown: true });
    for (let t = 0; t < 400; t += FRAME_MS) rig.frame({ ...palm('Right', p), fingersDown: true });
    for (let t = 0; t < 400; t += FRAME_MS) rig.frame({ ...hand('Right', p, 'idle'), flat: true });
    expect(scratches()).toHaveLength(0);
  });

  it('a palm shown only briefly does not scratch', () => {
    rest({ x: 0.3, y: 0.7 }, SCRATCH_ARM_MS - 3 * FRAME_MS);
    rig.frame(palm('Right', { x: 0.3, y: 0.7 }, 'end'));
    expect(scratches()).toHaveLength(0);
  });

  it('an open palm no longer crossfades', () => {
    rest({ x: 0.5, y: 0.7 }, 600);
    expect(rig.controller.crossfadeZone!.hand).toBeNull();
  });
});
