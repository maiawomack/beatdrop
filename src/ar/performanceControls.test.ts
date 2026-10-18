import { beforeEach, describe, expect, it } from 'vitest';
import type { HandId, Point2 } from '../perception';
import { capOffset, type HoloObject, type StemControl } from './HoloObject';
import { BUILD_TRAVEL, DROP_COOLDOWN_MS, FILTER_MAX_RATE, FILTER_TRAVEL, LOOP_STEP } from './InteractionController';
import { ASPECT, FRAME_MS, hand, liftHand, Rig } from './testRig';

function capPoint(obj: HoloObject, kind: StemControl): Point2 {
  return { x: obj.position.x + capOffset(obj, kind) / ASPECT, y: obj.position.y };
}

/** Hover then close the hand on a point; returns nothing, leaves the hand held there. */
function grabAt(rig: Rig, id: HandId, p: Point2): void {
  for (let i = 0; i < 4; i++) rig.frame(hand(id, p, 'idle'));
  rig.frame(hand(id, p, 'start'));
  rig.frame(hand(id, p, 'held'));
}

/** Both hands at once: hover, then close on their points, and stay held. */
function grabBoth(rig: Rig, left: Point2, right: Point2): void {
  for (let i = 0; i < 4; i++) rig.frame(hand('Left', left, 'idle'), hand('Right', right, 'idle'));
  rig.frame(hand('Left', left, 'start'), hand('Right', right, 'start'));
  rig.frame(hand('Left', left, 'held'), hand('Right', right, 'held'));
}

/** Move a held hand in a straight line over n frames. */
function moveTo(rig: Rig, id: HandId, from: Point2, to: Point2, n: number, tracked = true, make = hand): void {
  for (let i = 1; i <= n; i++) {
    const k = i / n;
    rig.frame(make(id, { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k }, 'held', tracked));
  }
}

describe('build → drop', () => {
  let rig: Rig;
  /** Open space: not on any stem or cap. */
  let core: Point2;
  beforeEach(() => {
    rig = new Rig();
    core = { x: 0.62, y: 0.8 };
  });

  /** Take the lift pose and raise it slowly to `amount` of a full build. */
  function raise(amount: number, id: HandId = 'Right'): Point2 {
    for (let i = 0; i < 2; i++) rig.frame(liftHand(id, core, 'idle'));
    rig.frame(liftHand(id, core, 'start'));
    const top = { x: core.x, y: core.y - BUILD_TRAVEL * amount };
    moveTo(rig, id, core, top, 15, true, liftHand);
    for (let i = 0; i < 4; i++) rig.frame(liftHand(id, top, 'held'));
    return top;
  }

  /** Lifted hand moves. */
  const liftMove = (from: Point2, to: Point2, n: number, tracked = true): void => moveTo(rig, 'Right', from, to, n, tracked, liftHand);

  it('the lift pose builds as it rises; the mixer settings are untouched', () => {
    rig.engine.dispatch({ type: 'setVolume', stemId: 'drums', value: 0.6 });
    rig.engine.dispatch({ type: 'setMute', stemId: 'bass', value: true });
    raise(1);
    expect(rig.controller.handModes.get('Right')).toBe('building');
    const builds = rig.commands('setBuild') as { value: number }[];
    expect(builds.length).toBeGreaterThan(3);
    expect(builds[builds.length - 1].value).toBeGreaterThan(0.95);
    expect(rig.engine.perf.build).toBeGreaterThan(0.95);
    expect(rig.engine.stems.get('drums')!.volume).toBeCloseTo(0.6);
    expect(rig.engine.stems.get('bass')!.muted).toBe(true);
  });

  it('letting go drops exactly once, and the mix comes back exactly as it was', () => {
    rig.engine.dispatch({ type: 'setVolume', stemId: 'drums', value: 0.6 });
    rig.engine.dispatch({ type: 'setMute', stemId: 'bass', value: true });
    const before = structuredClone(Object.fromEntries(rig.engine.stems));
    const top = raise(0.9);
    rig.frame(liftHand('Right', top, 'end'));
    rig.frame(liftHand('Right', top, 'idle'));

    expect(rig.commands('drop')).toHaveLength(1);
    expect(rig.eventsOf('buildEnd')[0].dropped).toBe(true);
    expect(rig.engine.perf.drops).toBe(1);
    expect(rig.engine.perf.build).toBe(0);
    // No cancel after a drop, and no stem state changed.
    const afterDrop = rig.engine.log.slice(rig.engine.log.findIndex((c) => c.type === 'drop'));
    expect(afterDrop.filter((c) => c.type === 'setBuild')).toHaveLength(0);
    expect(Object.fromEntries(rig.engine.stems)).toEqual(before);
  });

  it('opening the hand while bringing it down still drops', () => {
    const top = raise(0.8);
    rig.frame(liftHand('Right', { x: top.x, y: top.y + 0.08 }, 'held'));
    rig.frame(liftHand('Right', { x: top.x, y: top.y + 0.18 }, 'end'));
    expect(rig.commands('drop')).toHaveLength(1);
  });

  it('pulling down without letting go never drops (only opening the hand does)', () => {
    const top = raise(0.9);
    liftMove(top, { x: top.x, y: top.y + 0.25 }, 3); // fast pull-down, still in the lift pose
    expect(rig.commands('drop')).toHaveLength(0);
    rig.frame(liftHand('Right', { x: top.x, y: top.y + 0.25 }, 'end'));
    expect(rig.commands('drop')).toHaveLength(1);
  });

  it('letting go once it is building drops; a barely-raised hand cancels', () => {
    const top = raise(0.3);
    rig.frame(liftHand('Right', top, 'end'));
    expect(rig.commands('drop')).toHaveLength(1);
    for (let i = 0; i < 60; i++) rig.frame(); // cooldown
    const low = raise(0.15);
    rig.frame(liftHand('Right', low, 'end'));
    expect(rig.commands('drop')).toHaveLength(1);
    expect(rig.engine.perf.build).toBe(0);
  });

  it('lowering the hand slowly cancels instead of dropping', () => {
    const top = raise(0.8);
    liftMove(top, core, 60);
    rig.frame(liftHand('Right', core, 'end'));
    expect(rig.commands('drop')).toHaveLength(0);
    const builds = rig.commands('setBuild') as { value: number }[];
    expect(builds[builds.length - 1].value).toBe(0);
    expect(rig.engine.perf.build).toBe(0);
  });

  it('letting go without enough build cancels instead of dropping', () => {
    const top = raise(0.1);
    liftMove(top, { x: top.x, y: top.y + 0.25 }, 2);
    rig.frame(liftHand('Right', { x: top.x, y: top.y + 0.25 }, 'end'));
    expect(rig.commands('drop')).toHaveLength(0);
  });

  /** The hand is gone from the camera for `ms`. */
  const gone = (ms: number) => {
    for (let t = 0; t < ms; t += FRAME_MS) rig.frame();
  };

  it('losing the hand while building counts as letting go: it drops', () => {
    const top = raise(0.9);
    rig.frame(liftHand('Right', { x: top.x, y: 0.03 }, 'end', false)); // raised out of the frame
    gone(600);
    expect(rig.commands('drop')).toHaveLength(1);
    expect(rig.eventsOf('buildEnd').at(-1)!.dropped).toBe(true);
    expect(rig.controller.build?.state ?? 'dropped').toBe('dropped');
  });

  it('losing the hand before the build gets going cancels it (no drop)', () => {
    core = { x: 0.62, y: 0.7 };
    rig.frame(liftHand('Right', core, 'start'));
    for (let i = 0; i < 4; i++) rig.frame(liftHand('Right', core, 'held'));
    rig.frame(liftHand('Right', core, 'end', false));
    gone(600);
    expect(rig.commands('drop')).toHaveLength(0);
    expect(rig.engine.perf.build).toBe(0);
  });

  it('a lift pose that ends at the top edge drops too (no holding)', () => {
    const top = raise(0.9);
    const edge = { x: top.x, y: 0.1 };
    liftMove(top, edge, 4);
    rig.frame(liftHand('Right', edge, 'end'));
    expect(rig.commands('drop')).toHaveLength(1);
  });

  it('starting high still reaches a full build inside the frame', () => {
    core = { x: 0.62, y: 0.4 };
    rig.frame(liftHand('Right', core, 'start'));
    moveTo(rig, 'Right', core, { x: core.x, y: 0.1 }, 20, true, liftHand);
    for (let i = 0; i < 4; i++) rig.frame(liftHand('Right', { x: core.x, y: 0.1 }, 'held'));
    expect(rig.engine.perf.build).toBeGreaterThan(0.95);
  });

  it('drops have a cooldown', () => {
    for (let n = 0; n < 2; n++) {
      const top = raise(0.9);
      liftMove(top, { x: top.x, y: top.y + 0.25 }, 2);
      rig.frame(liftHand('Right', { x: top.x, y: top.y + 0.25 }, 'end'));
    }
    const elapsed = 2 * 22 * FRAME_MS;
    expect(elapsed).toBeLessThan(DROP_COOLDOWN_MS * 2);
    expect(rig.commands('drop')).toHaveLength(1);
  });

  it('moving a stem up and down never builds or drops', () => {
    const drums = rig.stem('drums');
    const p = { ...drums.position };
    grabAt(rig, 'Left', p);
    moveTo(rig, 'Left', p, { x: p.x, y: p.y - 0.2 }, 10);
    moveTo(rig, 'Left', { x: p.x, y: p.y - 0.2 }, { x: p.x, y: p.y + 0.3 }, 2);
    expect(rig.commands('setBuild')).toHaveLength(0);
    expect(rig.commands('drop')).toHaveLength(0);
  });

  it('a fist never builds, even in open space', () => {
    grabAt(rig, 'Right', core);
    moveTo(rig, 'Right', core, { x: core.x, y: core.y - BUILD_TRAVEL }, 20);
    moveTo(rig, 'Right', { x: core.x, y: core.y - BUILD_TRAVEL }, core, 3);
    expect(rig.eventsOf('buildStart')).toHaveLength(0);
    expect(rig.commands('drop')).toHaveLength(0);
  });

  it('the lift pose held still is armed but silent; letting go then does nothing', () => {
    rig.frame(liftHand('Right', core, 'start'));
    for (let i = 0; i < 20; i++) rig.frame(liftHand('Right', core, 'held'));
    expect(rig.controller.handModes.get('Right')).toBe('buildArmed');
    expect(rig.commands('setBuild')).toHaveLength(0);
    rig.frame(liftHand('Right', core, 'end'));
    expect(rig.commands('drop')).toHaveLength(0);
    expect(rig.commands('setBuild')).toHaveLength(0);
  });

  it('the lift pose over a stem builds and does not grab it', () => {
    const drums = rig.stem('drums');
    const p = { ...drums.position };
    rig.frame(liftHand('Right', p, 'start'));
    moveTo(rig, 'Right', p, { x: p.x, y: p.y - 0.15 }, 10, true, liftHand);
    expect(drums.holders).toHaveLength(0);
    expect(rig.engine.perf.build).toBeGreaterThan(0.3);
  });

  it('reports drop-pending while the engine waits for the beat (the hand is already free)', () => {
    rig.engine.holdDrops = true;
    const top = raise(0.9);
    rig.frame(liftHand('Right', top, 'end'));
    rig.frame(hand('Right', top, 'idle'));
    expect(rig.engine.perf.dropPending).toBe(true);
    expect(rig.eventsOf('buildEnd')[0].dropped).toBe(true);
    expect(rig.controller.handModes.get('Right')).toBe('idle');
    rig.engine.landDrop();
    expect(rig.engine.perf.drops).toBe(1);
  });

  it('the other hand keeps working independently during a build', () => {
    const drums = rig.stem('drums');
    const p = { ...drums.position };
    for (let i = 0; i < 4; i++) rig.frame(hand('Left', p, 'idle'), liftHand('Right', core, 'idle'));
    rig.frame(hand('Left', p, 'start'), liftHand('Right', core, 'start'));
    // Move both: right raises the build, left drags drums.
    for (let i = 1; i <= 15; i++) {
      rig.frame(
        liftHand('Right', { x: core.x, y: core.y - 0.02 * i }, 'held'),
        hand('Left', { x: p.x + 0.01 * i, y: p.y }, 'held'),
      );
    }
    expect(drums.holders).toEqual(['Left']);
    expect(drums.position.x).toBeGreaterThan(p.x + 0.1);
    expect(rig.engine.perf.build).toBeGreaterThan(0.5);
  });
});

describe('spatial loop', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = new Rig();
  });

  it('hold the loop cap, raise to choose a length, release to engage it', () => {
    const drums = rig.stem('drums');
    const c = capPoint(drums, 'loop');
    grabAt(rig, 'Left', c);
    expect(rig.controller.handModes.get('Left')).toBe('loopSelecting');
    expect(drums.control?.kind).toBe('loop');
    // Two steps up: off -> 1 -> 2 beats.
    moveTo(rig, 'Left', c, { x: c.x, y: c.y - 2 * LOOP_STEP }, 8);
    expect(drums.loopPreview).toBe(2);
    expect(rig.commands('setLoop')).toHaveLength(0); // preview only while held
    rig.frame(hand('Left', { x: c.x, y: c.y - 2 * LOOP_STEP }, 'end'));
    expect(rig.commands('setLoop')).toEqual([{ type: 'setLoop', stemId: 'drums', beats: 2 }]);
    expect(rig.engine.stems.get('drums')!.loop?.beats).toBe(2);
    expect(drums.control).toBeNull();
    // The stem itself didn't move.
    expect(drums.position).toEqual(rig.stem('drums').position);
  });

  it('a tap on the loop cap toggles a 4-beat loop on and off', () => {
    const drums = rig.stem('drums');
    const c = capPoint(drums, 'loop');
    rig.pinchDrag('Right', [c]);
    expect(rig.engine.stems.get('drums')!.loop?.beats).toBe(4);
    for (let i = 0; i < 4; i++) rig.frame();
    rig.pinchDrag('Right', [c]);
    expect(rig.engine.stems.get('drums')!.loop).toBeNull();
  });

  it('losing the hand while choosing cancels without changing the loop', () => {
    const drums = rig.stem('drums');
    const c = capPoint(drums, 'loop');
    grabAt(rig, 'Left', c);
    moveTo(rig, 'Left', c, { x: c.x, y: c.y - 3 * LOOP_STEP }, 8);
    rig.frame(hand('Left', { x: c.x, y: c.y - 3 * LOOP_STEP }, 'end', false));
    expect(rig.commands('setLoop')).toHaveLength(0);
    expect(rig.eventsOf('loopCancel')).toHaveLength(1);
  });

  it('two-hand stretching never touches the loop, even grabbing near the loop cap', () => {
    const drums = rig.stem('drums');
    const p = { ...drums.position };
    const r = { x: p.x + 0.05, y: p.y };
    const l = capPoint(drums, 'loop');
    grabAt(rig, 'Right', r);
    // Left joins near the loop cap while Right keeps holding.
    for (let i = 0; i < 4; i++) rig.frame(hand('Left', l, 'idle'), hand('Right', r, 'held'));
    rig.frame(hand('Left', l, 'start'), hand('Right', r, 'held'));
    rig.frame(hand('Left', l, 'held'), hand('Right', r, 'held'));
    expect(drums.holders).toEqual(['Right', 'Left']);
    expect(rig.controller.handModes.get('Left')).toBe('stretching');
    expect(rig.commands('setLoop')).toHaveLength(0);
  });

  it('a stem whose cap is held is locked: the other hand cannot drag it', () => {
    const drums = rig.stem('drums');
    const p = { ...drums.position };
    const l = capPoint(drums, 'loop');
    grabBoth(rig, l, p);
    expect(rig.controller.handModes.get('Left')).toBe('loopSelecting');
    for (let i = 1; i <= 6; i++) rig.frame(hand('Left', l, 'held'), hand('Right', { x: p.x + 0.03 * i, y: p.y }, 'held'));
    expect(drums.holders).toHaveLength(0);
    expect(drums.position.x).toBeCloseTo(p.x, 5);
  });
});

describe('spatial filter', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = new Rig();
  });

  it('up = highpass, down = lowpass, bounded to [-1, 1], held on release, tap resets', () => {
    const bass = rig.stem('bass');
    const c = capPoint(bass, 'filter');
    grabAt(rig, 'Right', c);
    expect(rig.controller.handModes.get('Right')).toBe('filterControl');
    moveTo(rig, 'Right', c, { x: c.x, y: c.y - 2 * FILTER_TRAVEL }, 20);
    for (let i = 0; i < 10; i++) rig.frame(hand('Right', { x: c.x, y: c.y - 2 * FILTER_TRAVEL }, 'held'));
    expect(rig.engine.stems.get('bass')!.filter).toBe(1);
    moveTo(rig, 'Right', { x: c.x, y: c.y - 2 * FILTER_TRAVEL }, { x: c.x, y: c.y + 2 * FILTER_TRAVEL }, 30);
    for (let i = 0; i < 10; i++) rig.frame(hand('Right', { x: c.x, y: c.y + 2 * FILTER_TRAVEL }, 'held'));
    expect(rig.engine.stems.get('bass')!.filter).toBe(-1);
    for (const cmd of rig.commands('setFilter') as { value: number }[]) {
      expect(cmd.value).toBeGreaterThanOrEqual(-1);
      expect(cmd.value).toBeLessThanOrEqual(1);
    }
    rig.frame(hand('Right', { x: c.x, y: c.y + 2 * FILTER_TRAVEL }, 'end'));
    expect(rig.engine.stems.get('bass')!.filter).toBe(-1); // held

    for (let i = 0; i < 4; i++) rig.frame();
    rig.pinchDrag('Right', [capPoint(bass, 'filter')]);
    expect(rig.engine.stems.get('bass')!.filter).toBe(0);
  });

  it('a one-frame tracking glitch cannot slam the filter', () => {
    const bass = rig.stem('bass');
    const c = capPoint(bass, 'filter');
    grabAt(rig, 'Right', c);
    rig.frame(hand('Right', { x: c.x, y: c.y - 0.5 }, 'held')); // glitch
    rig.frame(hand('Right', c, 'held'));
    const max = Math.max(...(rig.commands('setFilter') as { value: number }[]).map((c) => Math.abs(c.value)), 0);
    expect(max).toBeLessThanOrEqual(FILTER_MAX_RATE * (FRAME_MS / 1000) + 1e-9);
  });

  it('untracked frames freeze the filter', () => {
    const bass = rig.stem('bass');
    const c = capPoint(bass, 'filter');
    grabAt(rig, 'Right', c);
    moveTo(rig, 'Right', c, { x: c.x, y: c.y - 0.4 }, 6, false);
    expect(rig.commands('setFilter')).toHaveLength(0);
  });
});

describe('hand state machine', () => {
  it('idle -> hover -> grabbing -> repositioning -> idle', () => {
    const rig = new Rig();
    const drums = rig.stem('drums');
    const p = { ...drums.position };
    rig.frame(hand('Left', { x: 0.5, y: 0.5 }, 'idle'));
    expect(rig.controller.handModes.get('Left')).toBe('idle');
    for (let i = 0; i < 4; i++) rig.frame(hand('Left', p, 'idle'));
    expect(rig.controller.handModes.get('Left')).toBe('hover');
    rig.frame(hand('Left', p, 'start'));
    expect(rig.controller.handModes.get('Left')).toBe('grabbing');
    moveTo(rig, 'Left', p, { x: p.x + 0.1, y: p.y }, 5);
    expect(rig.controller.handModes.get('Left')).toBe('repositioning');
    rig.frame(hand('Left', { x: p.x + 0.1, y: p.y }, 'held', false));
    expect(rig.controller.handModes.get('Left')).toBe('trackingLost');
    rig.frame(hand('Left', { x: 0.5, y: 0.5 }, 'end', false));
    rig.frame(hand('Left', { x: 0.5, y: 0.5 }, 'idle'));
    expect(rig.controller.handModes.get('Left')).toBe('idle');
    expect(drums.holders).toHaveLength(0);
  });
});

describe('loop clips: pull a phrase out of a stem', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = new Rig();
  });

  /** Grab the vocals loop cap, drag it out toward the center, and let go there. */
  function pullOut(beatsSteps = 0): Point2 {
    const vocals = rig.stem('vocals');
    const c = capPoint(vocals, 'loop');
    grabAt(rig, 'Left', c);
    const up = { x: c.x, y: c.y - beatsSteps * LOOP_STEP };
    if (beatsSteps) moveTo(rig, 'Left', c, up, 6);
    const out = { x: up.x + 0.3 / ASPECT + 0.2, y: up.y - 0.1 };
    moveTo(rig, 'Left', up, out, 10);
    rig.frame(hand('Left', out, 'end'));
    rig.frame();
    return out;
  }

  it('dragging the loop cap out creates a floating clip where you let go; the source steps aside', () => {
    const out = pullOut();
    expect(rig.commands('createClip')).toEqual([{ type: 'createClip', stemId: 'vocals', clipId: 'vocals~1', beats: 4 }]);
    expect(rig.engine.stems.get('vocals')!.ducked).toBe(true);
    // The mixer setting of the source is untouched.
    expect(rig.engine.stems.get('vocals')!.muted).toBe(false);
    const clip = rig.controller.objects.find((o) => o.id === 'vocals~1')!;
    expect(clip.clipOf).toBe('vocals');
    expect(clip.position.x).toBeCloseTo(out.x, 1);
    expect(rig.commands('setLoop')).toHaveLength(0); // not an in-place loop
  });

  it('the length ladder sets the clip length', () => {
    pullOut(2);
    expect((rig.commands('createClip')[0] as { beats: number }).beats).toBe(2);
  });

  it('dragging back in before letting go loops in place instead', () => {
    const vocals = rig.stem('vocals');
    const c = capPoint(vocals, 'loop');
    grabAt(rig, 'Left', c);
    const up = { x: c.x, y: c.y - 3 * LOOP_STEP };
    moveTo(rig, 'Left', c, up, 6);
    const out = { x: up.x + 0.3 / ASPECT, y: up.y };
    moveTo(rig, 'Left', up, out, 5);
    expect(rig.controller.handModes.get('Left')).toBe('clipPulling');
    moveTo(rig, 'Left', out, up, 5);
    rig.frame(hand('Left', up, 'end'));
    expect(rig.commands('createClip')).toHaveLength(0);
    expect(rig.commands('setLoop')).toEqual([{ type: 'setLoop', stemId: 'vocals', beats: 4 }]);
  });

  it('dropping the clip back onto its stem puts it back', () => {
    const out = pullOut();
    const vocals = rig.stem('vocals');
    const clip = rig.controller.objects.find((o) => o.id === 'vocals~1')!;
    grabAt(rig, 'Right', clip.position);
    moveTo(rig, 'Right', out, vocals.position, 12);
    for (let i = 0; i < 4; i++) rig.frame(hand('Right', vocals.position, 'held'));
    rig.frame(hand('Right', vocals.position, 'end'));
    expect(rig.commands('removeClip')).toEqual([{ type: 'removeClip', stemId: 'vocals~1' }]);
    rig.frame();
    expect(rig.controller.objects.find((o) => o.id === 'vocals~1')).toBeUndefined();
    expect(rig.engine.stems.get('vocals')!.ducked).toBe(false);
  });

  it('throwing the clip at its stem puts it back', () => {
    const out = pullOut();
    const vocals = rig.stem('vocals');
    const clip = rig.controller.objects.find((o) => o.id === 'vocals~1')!;
    const p = { ...clip.position };
    grabAt(rig, 'Right', p);
    // Fast flick toward the vocals, letting go halfway.
    const dir = { x: vocals.position.x - p.x, y: vocals.position.y - p.y };
    moveTo(rig, 'Right', p, { x: p.x + dir.x * 0.4, y: p.y + dir.y * 0.4 }, 4);
    rig.frame(hand('Right', { x: p.x + dir.x * 0.4, y: p.y + dir.y * 0.4 }, 'end'));
    for (let i = 0; i < 40; i++) rig.frame();
    void out;
    expect(rig.commands('removeClip')).toHaveLength(1);
  });

  it('a tap on a clip does not mute it; clips have no loop cap', () => {
    pullOut();
    const clip = rig.controller.objects.find((o) => o.id === 'vocals~1')!;
    for (let i = 0; i < 4; i++) rig.frame();
    rig.pinchDrag('Right', [{ ...clip.position }]);
    expect(rig.engine.stems.get('vocals~1')!.muted).toBe(false);
    // Grabbing where a loop cap would be just grabs the clip body (or nothing), never a loop.
    rig.pinchDrag('Right', [capPoint(clip, 'loop')]);
    expect(rig.commands('setLoop')).toHaveLength(0);
  });
});

describe('twist to filter', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = new Rig();
  });
  const twisted = (id: HandId, p: Point2, phase: Parameters<typeof hand>[2], roll: number) => ({ ...hand(id, p, phase), roll });

  function grabWithRoll(p: Point2, roll: number): void {
    for (let i = 0; i < 4; i++) rig.frame(twisted('Right', p, 'idle', roll));
    rig.frame(twisted('Right', p, 'start', roll));
  }

  it('rotating a held stem clockwise sweeps a highpass, counterclockwise a lowpass; release holds it', () => {
    const bass = rig.stem('bass');
    const p = { ...bass.position };
    const r0 = -Math.PI / 2;
    grabWithRoll(p, r0);
    for (let i = 1; i <= 20; i++) rig.frame(twisted('Right', p, 'held', r0 + (i / 20) * (0.3 + 0.9)));
    for (let i = 0; i < 10; i++) rig.frame(twisted('Right', p, 'held', r0 + 1.2));
    expect(rig.engine.stems.get('bass')!.filter).toBeCloseTo(1, 6);
    expect(rig.controller.handModes.get('Right')).toBe('filterControl');
    for (let i = 1; i <= 30; i++) rig.frame(twisted('Right', p, 'held', r0 + 1.2 - (i / 30) * 2.4));
    for (let i = 0; i < 10; i++) rig.frame(twisted('Right', p, 'held', r0 - 1.2));
    expect(rig.engine.stems.get('bass')!.filter).toBeCloseTo(-1, 6);
    rig.frame(twisted('Right', p, 'end', r0 - 1.2));
    expect(rig.engine.stems.get('bass')!.filter).toBeCloseTo(-1, 6);
  });

  it('small wrist turns while dragging do not filter', () => {
    const drums = rig.stem('drums');
    const p = { ...drums.position };
    grabWithRoll(p, 0);
    for (let i = 1; i <= 15; i++) rig.frame(twisted('Right', { x: p.x + 0.01 * i, y: p.y }, 'held', 0.2 * Math.sin(i)));
    expect(rig.commands('setFilter')).toHaveLength(0);
    expect(drums.position.x).toBeGreaterThan(p.x + 0.1);
  });

  it('twisting across the ±π seam does not jump', () => {
    const drums = rig.stem('drums');
    const p = { ...drums.position };
    grabWithRoll(p, Math.PI - 0.1);
    for (let i = 1; i <= 10; i++) rig.frame(twisted('Right', p, 'held', Math.PI - 0.1 + i * 0.06)); // wraps past π
    const v = rig.engine.stems.get('drums')!.filter;
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(0.5);
  });
});
