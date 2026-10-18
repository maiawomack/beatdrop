import { beforeEach, describe, expect, it } from 'vitest';
import type { GesturePhase, Point2 } from '../perception';
import { PINCH_ARM_MS, TEMPO_EDGE, TEMPO_RANGE, TEMPO_TRAVEL } from './InteractionController';
import { FRAME_MS, gesture, hand, Rig } from './testRig';

describe('tempo (a fist at the screen edge, up and down)', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = new Rig();
    // Deck A's tempo pulse at the left edge, as decks.ts makes it (deck B has nothing loaded).
    rig.controller.tempoStrips = [{ deck: 'A', position: { x: 0, y: 0.5 }, color: '#4fd9d2', hover: 0, hand: null, value: null }];
  });

  /** A closed fist (the grip engaged), as perception reports it. */
  const fist = (p: Point2, phase: GesturePhase = 'held') => ({ ...hand('Right', p, phase), grip: gesture(phase, p) });
  const edge = { x: TEMPO_EDGE / 2, y: 0.5 };
  const move = (from: Point2, dy: number, n = 10) => {
    for (let i = 1; i <= n; i++) rig.frame(fist({ x: from.x, y: from.y + dy * (i / n) }));
  };

  it('a fist at the left edge: up = faster, down = slower; opening keeps it', () => {
    rig.frame(fist(edge, 'start'));
    move(edge, -TEMPO_TRAVEL / 2);
    expect(rig.controller.handModes.get('Right')).toBe('tempo');
    expect(rig.engine.perf.tempo.A).toBeCloseTo(1 + TEMPO_RANGE / 2, 5);
    move({ x: edge.x, y: edge.y - TEMPO_TRAVEL / 2 }, TEMPO_TRAVEL);
    expect(rig.engine.perf.tempo.A).toBeCloseTo(1 - TEMPO_RANGE / 2, 5);
    const end = { x: edge.x, y: edge.y + TEMPO_TRAVEL / 2 };
    rig.frame(fist(end, 'end'));
    rig.frame(hand('Right', end, 'idle'));
    expect(rig.engine.perf.tempo.A).toBeCloseTo(1 - TEMPO_RANGE / 2, 5);
    expect(rig.controller.tempoStrips[0]!.hand).toBeNull();
  });

  it('the pulse shows only while a hand is at that edge, level with the hand', () => {
    const strip = rig.controller.tempoStrips[0]!;
    rig.frame(hand('Left', { x: 0.4, y: 0.3 }, 'idle')); // away from the edge
    expect(strip.hover).toBe(0);
    rig.frame(hand('Left', { x: TEMPO_EDGE / 3, y: 0.3 }, 'idle')); // open hand at the left edge
    expect(strip.hover).toBe(1);
    expect(strip.position.y).toBeCloseTo(0.3, 5);
    rig.frame(hand('Left', { x: 1 - TEMPO_EDGE / 3, y: 0.3 }, 'idle')); // the right edge is deck B's
    expect(strip.hover).toBe(0);
    // Held: it follows the fist.
    rig.frame(fist(edge, 'start'));
    move(edge, -0.1);
    expect(strip.hand).toBe('Right');
    expect(strip.position.y).toBeCloseTo(edge.y - 0.1, 5);
  });

  it('a fist away from the edges never changes the tempo', () => {
    const mid = { x: 0.35, y: 0.5 }; // left half, but not at the edge
    rig.frame(fist(mid, 'start'));
    move(mid, -0.2);
    expect(rig.commands('setTempo')).toHaveLength(0);
    expect(rig.controller.handModes.get('Right')).not.toBe('tempo');
  });

  it('the right edge is deck B, and does nothing while B is empty', () => {
    const right = { x: 1 - TEMPO_EDGE / 2, y: 0.5 };
    rig.frame(fist(right, 'start'));
    move(right, -0.2);
    expect(rig.commands('setTempo')).toHaveLength(0);
  });

  it('normal speed has a notch, and a quick fist does not reset the tempo', () => {
    rig.engine.dispatch({ type: 'setTempo', deck: 'A', rate: 1.004 });
    rig.frame();
    rig.frame(fist(edge, 'start'));
    rig.frame(fist({ x: edge.x, y: edge.y - 0.001 }));
    expect(rig.engine.perf.tempo.A).toBe(1);
    rig.engine.dispatch({ type: 'setTempo', deck: 'A', rate: 1.06 });
    rig.frame(fist(edge, 'end'));
    for (let i = 0; i < 3; i++) rig.frame();
    rig.frame(fist(edge, 'start'));
    rig.frame(fist(edge, 'end'));
    expect(rig.engine.perf.tempo.A).toBeCloseTo(1.06);
  });

  it('a pinch at the edge is not tempo', () => {
    const pinch = (p: Point2, phase: GesturePhase = 'held') => ({ ...hand('Right', p, 'idle'), pinch: gesture(phase, p) });
    rig.frame(pinch(edge, 'start'));
    for (let t = 0; t <= PINCH_ARM_MS + FRAME_MS; t += FRAME_MS) rig.frame(pinch(edge));
    for (let i = 1; i <= 10; i++) rig.frame(pinch({ x: edge.x, y: edge.y - 0.02 * i }));
    expect(rig.commands('setTempo')).toHaveLength(0);
  });
});
