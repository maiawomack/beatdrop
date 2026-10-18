import { beforeEach, describe, expect, it } from 'vitest';
import type { GesturePhase, HandId, Point2 } from '../perception';
import { LEVEL_DEADZONE, LEVEL_TRAVEL, PINCH_ARM_MS, TWO_UP_ARM_MS, VOLUME_MAX_RATE } from './InteractionController';
import { ASPECT, FRAME_MS, gesture, hand, Rig } from './testRig';

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

  it('a quick tap does not mute', () => {
    rig.pinchDrag('Right', [{ ...rig.stem('drums').position }]);
    expect(rig.engine.stems.get('drums')!.muted).toBe(false);
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

/** Deck stems as fader bars on the bottom edge: pinch near the top of the fill and drag up/down. */
describe('fader bars', () => {
  let rig: Rig;
  const TRACK = 0.56; // full track height = full volume range
  beforeEach(() => {
    rig = new Rig();
    rig.stems.forEach((s, i) => {
      s.locked = true;
      s.vertical = true;
      s.halfSize = { x: 0.05, y: TRACK / 2 };
      s.position = { x: 0.1 + i * 0.08, y: 1 - 0.035 - TRACK / 2 };
    });
    rig.controller.crossfadeZone = { x0: 0.36, x1: 0.64, y0: 0.35, y1: 1, arming: 0, hand: null };
  });

  const pinch = (id: HandId, p: Point2, phase: GesturePhase = 'held', fist = false) => ({
    ...hand(id, p, fist ? phase : 'idle'),
    pinch: gesture(phase, p),
    grip: gesture(fist ? 'held' : 'idle', p),
  });
  /** Top of a bar's fill (view space). */
  const topOf = (id: string) => {
    const o = rig.stem(id);
    return { x: o.position.x, y: o.position.y + o.halfSize.y - 2 * o.halfSize.y * o.audio.volume };
  };
  const pinchAt = (id: HandId, p: Point2) => {
    rig.frame(pinch(id, p, 'start'));
    for (let t = 0; t <= PINCH_ARM_MS + FRAME_MS; t += FRAME_MS) rig.frame(pinch(id, p));
  };
  const drag = (id: HandId, from: Point2, to: Point2, n: number) => {
    for (let i = 1; i <= n; i++) rig.frame(pinch(id, { x: from.x + (to.x - from.x) * (i / n), y: from.y + (to.y - from.y) * (i / n) }));
    for (let i = 0; i < 10; i++) rig.frame(pinch(id, to));
  };

  it('pinch near the top of the bar and drag: the top follows the hand 1:1', () => {
    rig.engine.dispatch({ type: 'setVolume', stemId: 'drums', value: 0.5 });
    rig.frame();
    const drums = rig.stem('drums');
    const home = { ...drums.position };
    // Not exactly on the line: a bit above it is fine.
    const p = { x: topOf('drums').x, y: topOf('drums').y - 0.05 };
    pinchAt('Right', p);
    expect(drums.holders).toEqual(['Right']);
    expect(rig.controller.handModes.get('Right')).toBe('volume');
    const up = { x: p.x, y: p.y - TRACK * 0.25 - 0.01 };
    drag('Right', p, up, 15);
    expect(rig.engine.stems.get('drums')!.volume).toBeCloseTo(0.75, 2);
    rig.frame(pinch('Right', up, 'end'));
    expect(drums.holders).toHaveLength(0);
    expect(drums.position).toEqual(home);
  });

  for (const id of ['Right', 'Left'] as const) it(`grip the top and pull down in one motion (${id} hand): it still takes the bar and follows from the grip`, () => {
    rig.frame();
    const p = topOf('drums'); // full volume: the handle is at the top of the track
    rig.frame(pinch(id, p, 'start'));
    // Straight into the pull, before the pinch has counted (PINCH_ARM_MS).
    const to = { x: p.x, y: p.y + TRACK * 0.5 + 0.01 };
    for (let i = 1; i <= 5; i++) rig.frame(pinch(id, { x: p.x, y: p.y + (to.y - p.y) * (i / 5) }));
    for (let i = 0; i < 20; i++) rig.frame(pinch(id, to));
    expect(rig.stem('drums').holders).toEqual([id]);
    expect(rig.engine.stems.get('drums')!.volume).toBeCloseTo(0.5, 2);
  });

  it('a pinch that also looks like fingers up is a pinch: it takes the bar, never the crossfader', () => {
    rig.frame();
    const p = topOf('drums');
    const pinchUp = (phase: GesturePhase) => ({ ...pinch('Right', p, phase), twoUp: gesture('held', p) });
    rig.frame(pinchUp('start'));
    for (let t = 0; t <= Math.max(PINCH_ARM_MS, TWO_UP_ARM_MS) + 2 * FRAME_MS; t += FRAME_MS) rig.frame(pinchUp('held'));
    expect(rig.stem('drums').holders).toEqual(['Right']);
    expect(rig.controller.handModes.get('Right')).not.toBe('crossfading');
    expect(rig.controller.crossfadeZone?.hand ?? null).toBeNull();
  });

  it('a pinch with the other fingers curled (it reads as a fist too) still takes the bar', () => {
    rig.frame();
    const p = topOf('drums');
    const fistPinch = (phase: GesturePhase) => ({ ...pinch('Right', p, phase), grip: gesture(phase, p) });
    rig.frame(fistPinch('start'));
    for (let t = 0; t <= PINCH_ARM_MS + 2 * FRAME_MS; t += FRAME_MS) rig.frame(fistPinch('held'));
    expect(rig.stem('drums').holders).toEqual(['Right']);
    expect(rig.controller.handModes.get('Right')).toBe('volume');
  });

  it('the bars and the tempo zone never overlap: a fist beside the outer bar is not tempo, beyond it is', () => {
    rig.frame();
    rig.controller.tempoStrips = [{ deck: 'A', position: { x: 0, y: 0.5 }, color: '#4fd9d2', hover: 0, hand: null, value: null }];
    const outer = rig.controller.objects.filter((o) => o.vertical).reduce((a, b) => (b.position.x < a.position.x ? b : a));
    const edge = outer.position.x - outer.halfSize.x / ASPECT; // its outer edge
    const fist = (x: number, phase: GesturePhase) => ({ ...hand('Right', { x, y: 0.3 }, phase), grip: gesture(phase, { x, y: 0.3 }), scale: 0.3 });
    // Right beside the bar (a big hand up close would count as "out to the side" here): not tempo.
    rig.frame(fist(edge - 0.005, 'start'));
    for (let i = 0; i < 12; i++) rig.frame(fist(edge - 0.005, 'held'));
    expect(rig.controller.handModes.get('Right')).not.toBe('tempo');
    rig.frame(fist(edge - 0.005, 'end'));
    for (let i = 0; i < 3; i++) rig.frame();
    // Clearly beyond it: tempo.
    const x = Math.max(0.01, edge - 0.08);
    rig.frame(fist(x, 'start'));
    for (let i = 0; i < 12; i++) rig.frame(fist(x, 'held'));
    expect(rig.controller.handModes.get('Right')).toBe('tempo');
  });

  it('only the top of the fill grabs: a pinch deep inside the bar does nothing', () => {
    rig.frame();
    const v = rig.stem('vocals'); // full volume: the top of the fill is at the top of the track
    pinchAt('Left', { x: v.position.x, y: v.position.y + 0.15 }); // deep inside the bar
    expect(v.holders).toHaveLength(0);
  });

  it('the bar glides after the pinch (no jumps), and lands where the hand stopped', () => {
    rig.engine.dispatch({ type: 'setVolume', stemId: 'drums', value: 0.5 });
    rig.frame();
    const p = topOf('drums');
    pinchAt('Right', p);
    const to = { x: p.x, y: p.y - TRACK * 0.4 - 0.01 };
    rig.frame(pinch('Right', to)); // one big jump of the hand
    const after = rig.engine.stems.get('drums')!.volume;
    expect(after).toBeGreaterThan(0.5);
    expect(after).toBeLessThan(0.75); // eased, not snapped
    for (let i = 0; i < 20; i++) rig.frame(pinch('Right', to));
    expect(rig.engine.stems.get('drums')!.volume).toBeCloseTo(0.9, 2);
  });

  it('pinching a bar wins over the lift pose (reaching down to the bars never builds)', () => {
    rig.frame();
    const v = rig.stem('drums');
    const p = topOf('drums');
    const pinchLift = (phase: GesturePhase) => ({ ...pinch('Left', p, phase), lift: gesture(phase, p) });
    rig.frame(pinchLift('start'));
    for (let t = 0; t <= PINCH_ARM_MS + FRAME_MS; t += FRAME_MS) rig.frame(pinchLift('held'));
    expect(v.holders).toEqual(['Left']);
    expect(rig.eventsOf('buildStart')).toHaveLength(0);
  });

  it('an empty bar can be pinched at the bottom, where its top is', () => {
    rig.engine.dispatch({ type: 'setVolume', stemId: 'vocals', value: 0 });
    rig.frame();
    pinchAt('Left', { ...topOf('vocals'), y: topOf('vocals').y - 0.03 });
    expect(rig.stem('vocals').holders).toEqual(['Left']);
  });

  it('a fist on a bar does nothing', () => {
    rig.pinchDrag('Right', [{ ...rig.stem('drums').position }, { x: rig.stem('drums').position.x, y: 0.5 }]);
    expect(rig.stem('drums').holders).toHaveLength(0);
    expect(rig.commands('setVolume')).toHaveLength(0);
    expect(rig.engine.stems.get('drums')!.muted).toBe(false);
  });

  it('the crossfader (two fingers up) keeps going when the hand slides over the bars', () => {
    const p = { x: 0.5, y: 0.6 };
    const v = (q: Point2, phase: GesturePhase = 'held') => ({ ...hand('Right', q, 'idle'), twoUp: gesture(phase, q) });
    rig.frame(v(p, 'start'));
    for (let t = 0; t <= TWO_UP_ARM_MS + FRAME_MS; t += FRAME_MS) rig.frame(v(p));
    expect(rig.controller.handModes.get('Right')).toBe('crossfading');
    const to = { x: rig.stem('drums').position.x, y: p.y };
    for (let i = 1; i <= 20; i++) rig.frame(v({ x: p.x + (to.x - p.x) * (i / 20), y: p.y }));
    for (let i = 0; i < 10; i++) rig.frame(v(to));
    expect(rig.controller.handModes.get('Right')).toBe('crossfading');
    expect(rig.engine.perf.crossfader).toBeLessThan(-0.5);
    expect(rig.stem('drums').holders).toHaveLength(0);
  });

  it('a pinch on a record does nothing (records are open-palm only)', () => {
    rig.controller.platters = [{ deck: 'A', position: { x: 0.2, y: 0.2 }, radius: 0.08, color: '#fff', hover: 0, hand: null, offsetSec: 0 }];
    pinchAt('Right', { x: 0.2, y: 0.2 });
    rig.frame(pinch('Right', { x: 0.2 + 0.05, y: 0.2 }));
    expect(rig.controller.handModes.get('Right')).not.toBe('scratching');
    expect(rig.commands('scratch')).toHaveLength(0);
  });

});
