import { beforeEach, describe, expect, it } from 'vitest';
import type { GesturePhase, Point2 } from '../perception';
import { PINCH_ARM_MS, TEMPO_TRACK_BOTTOM, TEMPO_TRACK_TOP, tempoForLineY, tempoLineY, tempoReachGain, tempoSideDistance } from './InteractionController';
import { ASPECT, FRAME_MS, gesture, hand, Rig } from './testRig';

describe('tempo (a fist out to your side, up and down)', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = new Rig();
    rig.stems.splice(0); // the spatial screen shows no stem bars right now (SHOW_STEM_BARS)
    // Deck A's tempo strip, as decks.ts makes it (deck B has nothing loaded).
    rig.controller.tempoStrips = [{ deck: 'A', position: { x: 0, y: 0.5 }, color: '#4fd9d2', hover: 0, hand: null, value: null }];
  });

  /** A closed fist (the grip engaged), with an apparent palm size (how close you are). */
  const fist = (p: Point2, phase: GesturePhase = 'held', palm?: number) => ({
    ...hand('Right', p, phase),
    grip: gesture(phase, p),
    scale: palm,
  });
  const side = { x: 0.15, y: 0.5 }; // well out to the left
  const hold = (p: Point2, frames = 12, palm?: number) => {
    for (let i = 0; i < frames; i++) rig.frame(fist(p, 'held', palm));
  };
  const move = (from: Point2, dy: number, n = 10, palm?: number) => {
    for (let i = 1; i <= n; i++) rig.frame(fist({ x: from.x, y: from.y + dy * (i / n) }, 'held', palm));
  };

  it('the edge line uses the decks screen fader scale: 2× top, ×1.00 middle, ½× bottom', () => {
    expect(tempoLineY(2)).toBeCloseTo(TEMPO_TRACK_TOP, 5);
    expect(tempoLineY(1)).toBeCloseTo((TEMPO_TRACK_TOP + TEMPO_TRACK_BOTTOM) / 2, 5);
    expect(tempoLineY(0.5)).toBeCloseTo(TEMPO_TRACK_BOTTOM, 5);
    expect(tempoForLineY(tempoLineY(1.3))).toBeCloseTo(1.3, 5);
  });

  it('the line stays where the fader has it when the fist closes, and moves with the fist from there', () => {
    rig.engine.dispatch({ type: 'setTempo', deck: 'A', rate: 1.2 });
    rig.frame();
    rig.frame(fist(side, 'start'));
    hold(side);
    const strip = rig.controller.tempoStrips[0]!;
    expect(rig.controller.handModes.get('Right')).toBe('tempo');
    expect(strip.hand).toBe('Right');
    expect(strip.position.y).toBeCloseTo(tempoLineY(1.2), 5); // not at the fist
    expect(rig.engine.perf.tempo.A).toBeCloseTo(1.2, 5);
    move(side, -0.1);
    hold({ x: side.x, y: side.y - 0.1 });
    expect(strip.position.y).toBeCloseTo(tempoLineY(1.2) - 0.1, 5);
    expect(rig.engine.perf.tempo.A).toBeCloseTo(tempoForLineY(tempoLineY(1.2) - 0.1), 5);
    // Way down: the line stops at the bottom of its track (½×).
    move({ x: side.x, y: side.y - 0.1 }, 0.9, 20);
    hold({ x: side.x, y: side.y + 0.8 }, 60);
    expect(rig.engine.perf.tempo.A).toBeCloseTo(0.5, 5);
    rig.frame(fist({ x: side.x, y: side.y + 0.8 }, 'end'));
    rig.frame(hand('Right', side, 'idle'));
    expect(rig.engine.perf.tempo.A).toBeCloseTo(0.5, 5);
    expect(strip.hand).toBeNull();
  });

  it('from across the room (a small hand): a nearer reach counts, and the line moves further per move', () => {
    const palm = 0.05;
    const near = { x: 0.5 - (tempoSideDistance(palm) + 0.02) / ASPECT, y: 0.5 }; // just out to the side
    rig.frame(fist(near, 'start', palm));
    hold(near, 12, palm);
    expect(rig.controller.handModes.get('Right')).toBe('tempo');
    const gain = tempoReachGain(palm);
    expect(gain).toBeGreaterThan(1);
    move(near, -0.05, 10, palm);
    hold({ x: near.x, y: near.y - 0.05 }, 30, palm);
    expect(rig.controller.tempoStrips[0]!.position.y).toBeCloseTo(tempoLineY(1) - 0.05 * gain, 5);
  });

  it('a hand out to your side shows the tempo line at the screen edge, where the fader has it', () => {
    rig.engine.dispatch({ type: 'setTempo', deck: 'A', rate: 0.8 });
    rig.frame();
    const strip = rig.controller.tempoStrips[0]!;
    rig.frame(hand('Left', { x: 0.45, y: 0.3 }, 'idle')); // in front of you
    expect(strip.hover).toBe(0);
    rig.frame(hand('Left', { x: 0.15, y: 0.3 }, 'idle')); // out to the side
    expect(strip.hover).toBe(1);
    expect(strip.position.y).toBeCloseTo(tempoLineY(0.8), 5);
  });

  it('a fist in front of you never changes the tempo', () => {
    const front = { x: 0.5 - (tempoSideDistance(undefined) - 0.05) / ASPECT, y: 0.5 }; // left of center, but in front
    rig.frame(fist(front, 'start'));
    move(front, -0.2);
    expect(rig.commands('setTempo')).toHaveLength(0);
    expect(rig.controller.handModes.get('Right')).not.toBe('tempo');
  });

  it('the right side is deck B, and does nothing while B is empty', () => {
    const right = { x: 0.85, y: 0.5 };
    rig.frame(fist(right, 'start'));
    move(right, -0.2);
    expect(rig.commands('setTempo')).toHaveLength(0);
  });

  it('the middle snaps to x1.00, and a quick fist does not change the tempo', () => {
    rig.engine.dispatch({ type: 'setTempo', deck: 'A', rate: 1.01 });
    rig.frame();
    rig.frame(fist(side, 'start'));
    move(side, 0.006);
    hold({ x: side.x, y: side.y + 0.006 });
    expect(rig.engine.perf.tempo.A).toBe(1);
    rig.frame(fist(side, 'end'));
    rig.engine.dispatch({ type: 'setTempo', deck: 'A', rate: 1.06 });
    for (let i = 0; i < 3; i++) rig.frame();
    rig.frame(fist(side, 'start'));
    rig.frame(fist(side, 'end'));
    expect(rig.engine.perf.tempo.A).toBeCloseTo(1.06);
  });

  it('a pinch out to the side is not tempo', () => {
    const pinch = (p: Point2, phase: GesturePhase = 'held') => ({ ...hand('Right', p, 'idle'), pinch: gesture(phase, p) });
    rig.frame(pinch(side, 'start'));
    for (let t = 0; t <= PINCH_ARM_MS + FRAME_MS; t += FRAME_MS) rig.frame(pinch(side));
    for (let i = 1; i <= 10; i++) rig.frame(pinch({ x: side.x, y: side.y - 0.02 * i }));
    expect(rig.commands('setTempo')).toHaveLength(0);
  });
});
