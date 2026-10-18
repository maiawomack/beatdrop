import { beforeEach, describe, expect, it } from 'vitest';
import type { GesturePhase, Point2 } from '../perception';
import { PINCH_ARM_MS, TEMPO_RANGE, TEMPO_TRAVEL } from './InteractionController';
import { FRAME_MS, gesture, hand, Rig } from './testRig';

describe('tempo strip (pinch and drag)', () => {
  let rig: Rig;
  const at = { x: 0.3, y: 0.2 };
  beforeEach(() => {
    rig = new Rig();
    rig.controller.tempoStrips = [{ deck: 'A', position: { ...at }, halfHeight: 0.09, color: '#4fd9d2', hover: 0, hand: null, value: null }];
  });

  const pinch = (p: Point2, phase: GesturePhase = 'held', fist = false) => ({
    ...hand('Right', p, fist ? phase : 'idle'),
    pinch: gesture(phase, p),
    grip: gesture(fist ? 'held' : 'idle', p),
  });
  const take = (p: Point2) => {
    rig.frame(pinch(p, 'start'));
    for (let t = 0; t <= PINCH_ARM_MS + FRAME_MS; t += FRAME_MS) rig.frame(pinch(p));
  };
  const rates = () => (rig.commands('setTempo') as { deck: string; rate: number }[]).map((c) => c.rate);

  it('pinch and drag up = faster, down = slower; letting go keeps it', () => {
    take(at);
    expect(rig.controller.handModes.get('Right')).toBe('tempo');
    const up = { x: at.x, y: at.y - TEMPO_TRAVEL / 2 };
    for (let i = 1; i <= 10; i++) rig.frame(pinch({ x: at.x, y: at.y + (up.y - at.y) * (i / 10) }));
    expect(rig.engine.perf.tempo.A).toBeCloseTo(1 + TEMPO_RANGE / 2, 5);
    for (let i = 1; i <= 10; i++) rig.frame(pinch({ x: at.x, y: up.y + TEMPO_TRAVEL * (i / 10) }));
    expect(rig.engine.perf.tempo.A).toBeCloseTo(1 - TEMPO_RANGE / 2, 5);
    rig.frame(pinch({ x: at.x, y: up.y + TEMPO_TRAVEL }, 'end'));
    expect(rig.engine.perf.tempo.A).toBeCloseTo(1 - TEMPO_RANGE / 2, 5); // held
    expect(rig.controller.tempoStrips[0]!.hand).toBeNull();
  });

  it('a quick pinch-tap resets to normal speed', () => {
    rig.engine.dispatch({ type: 'setTempo', deck: 'A', rate: 1.06 });
    rig.frame();
    take(at);
    rig.frame(pinch(at, 'end'));
    expect(rates().at(-1)).toBe(1);
    expect(rig.engine.perf.tempo.A).toBe(1);
  });

  it('normal speed has a notch, and a fist does nothing', () => {
    rig.engine.dispatch({ type: 'setTempo', deck: 'A', rate: 1.004 });
    rig.frame();
    take(at);
    rig.frame(pinch({ x: at.x, y: at.y - 0.001 }));
    expect(rates().at(-1)).toBe(1);
    rig.frame(pinch(at, 'end'));
    const before = rig.commands('setTempo').length;
    rig.pinchDrag('Left', [at, { x: at.x, y: at.y - 0.2 }].map((p) => ({ ...p })));
    expect(rig.commands('setTempo').length).toBe(before);
  });

  it('the tempo strip wins over the crossfader zone', () => {
    rig.controller.crossfadeZone = { x0: 0.2, x1: 0.8, y0: 0, y1: 1, arming: 0, hand: null };
    take(at);
    expect(rig.controller.handModes.get('Right')).toBe('tempo');
  });
});
