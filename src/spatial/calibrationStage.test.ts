import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GrabClassifier, GrabLabel } from '../perception/grabClassifier';
import type { HandState, PerceptionFrame } from '../perception/types';
import { CalibrationStage, liftThresholds } from './calibrationStage';

/** Fake Perceptron service: /health, and /gesture/segments answering per gesture. */
function mockService(answer: (gesture: string, attempt: number) => { status?: number; segments?: [number, number][] }) {
  const attempts: Record<string, number> = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/health')) return new Response(JSON.stringify({ perceptron: true }));
      const gesture = JSON.parse(String(init!.body)).gesture as string;
      attempts[gesture] = (attempts[gesture] ?? 0) + 1;
      const a = answer(gesture, attempts[gesture]);
      if (a.status) return new Response(JSON.stringify({ error: 'Perceptron request failed' }), { status: a.status });
      return new Response(JSON.stringify({ segments: a.segments, poses: [], summary: '' }));
    }),
  );
}

/** A tracked hand with the given fist and lift measurements. */
const hand = (grip: number, lift: number) =>
  ({ tracked: true, confidence: 1, grip: { ratio: grip }, lift: { ratio: lift } }) as unknown as HandState;

function setup() {
  const samples: { label: GrabLabel; t: number }[] = [];
  let collecting: GrabLabel | null = null;
  const trained: { kept: { label: GrabLabel; t: number }[] } = { kept: [] };
  const deps = {
    video: {} as HTMLVideoElement,
    gestures: {
      collect: (label: GrabLabel | null) => (collecting = label),
      finishCalibration: (keep?: (s: { label: GrabLabel; t: number }) => boolean) => {
        trained.kept = keep ? samples.filter(keep) : samples;
        const grab = trained.kept.filter((s) => s.label === 1).length;
        return { ready: grab > 0, counts: { open: trained.kept.length - grab, grab } } as unknown as GrabClassifier;
      },
      setLiftThresholds: vi.fn(),
    },
    saveGrab: vi.fn(),
    saveLift: vi.fn(),
    onClose: vi.fn(),
    // 4 s demo -> frames at 0 and 3800 ms on the demo's own timeline.
    recorder: (() => {
      let origin = 0;
      return {
        begin: (now: number) => (origin = now),
        capture: () => {},
        take: () => ({ frames: [{ t: 0, jpeg: 'x' }, { t: 3800, jpeg: 'x' }], origin }),
      };
    })(),
  };
  const stage = new CalibrationStage(deps);
  let now = 1000;
  /** Advance `ms` of frames; `measure` gives the hand (or null) at each moment. */
  const run = async (ms: number, measure: () => HandState | null) => {
    for (const end = now + ms; now < end; now += 50) {
      const h = measure();
      stage.update({ timestamp: now, hands: h ? [h] : [] } as PerceptionFrame);
      if (collecting !== null && h) samples.push({ label: collecting, t: now });
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0)); // let a pending Perceptron check finish
    }
  };
  return { stage, deps, trained, run, key: (k: string) => stage.handleKey(k, now), time: () => now };
}

afterEach(() => vi.unstubAllGlobals());

describe('gesture calibration stage', () => {
  it('trains only on the moments Perceptron confirmed, and personalizes the lift threshold', async () => {
    // Perceptron confirms 1.0-3.5 s of each 3.8 s demo.
    mockService(() => ({ segments: [[1.0, 3.5]] }));
    const { stage, deps, trained, run, key } = setup();
    await stage.open();
    expect(stage.phase).toEqual({ kind: 'offer', perceptron: true });
    key('y');
    // This user's fist (0.60) and lift (0.62) are looser than the defaults (0.55, 0.55).
    const userHand = () => (stage.phase.kind === 'recording' && /lift/i.test(stage.banner(0)?.title ?? '') ? hand(1, 0.62) : hand(0.6, 0.62));
    await run(30_000, userHand); // 3 steps x ~8.6 s, before the summary times out
    expect(stage.phase.kind).toBe('summary');

    // Grab model: only samples inside the confirmed 1.0-3.5 s window of each demo.
    expect(deps.saveGrab).toHaveBeenCalledOnce();
    expect(trained.kept.length).toBeGreaterThan(0);
    const banner = stage.banner(0)!.detail;
    expect(banner).toMatch(/Grab ✓/);
    expect(banner).toMatch(/default fist rule caught 0% of your fist frames/);
    // Lift: threshold moves from the default 0.55 to just above this user's bunch.
    expect(deps.gestures.setLiftThresholds).toHaveBeenCalledWith({ on: 0.67, off: 0.92 });
    expect(deps.saveLift).toHaveBeenCalledWith({ on: 0.67, off: 0.92 });
    expect(banner).toMatch(/0\.55 → 0\.67: the default caught 0% of your lift frames, yours catches 100%/);
    expect(banner).toMatch(/Perceptron AI checked every demo/);
  });

  it('rejects a demo Perceptron did not confirm, with feedback and a retry', async () => {
    // First FIST demo: Perceptron sees no fist. Second try: confirmed.
    mockService((gesture, attempt) => ({ segments: gesture === 'fist' && attempt === 1 ? [] : [[0.5, 3.5]] }));
    const { stage, run, key } = setup();
    await stage.open();
    key('y');
    await run(17_000, () => hand(0.4, 1.5)); // OPEN step, then the FIST demo is checked
    expect(stage.phase.kind).toBe('result');
    expect(stage.phase.kind === 'result' && stage.phase.ok).toBe(false);
    expect(stage.banner(0)!.detail).toMatch(/Perceptron saw no fist in that demo/);
    key('r'); // retry
    await run(9_000, () => hand(0.4, 1.5));
    expect(stage.banner(0)?.title).toMatch(/LIFT/);
  });

  it('falls back to the whole demo when Perceptron is unavailable', async () => {
    mockService(() => ({ status: 503 }));
    const { stage, deps, run, key } = setup();
    await stage.open();
    key('y');
    await run(30_000, () => hand(0.4, 0.5));
    expect(stage.phase.kind).toBe('summary');
    expect(deps.saveGrab).toHaveBeenCalledOnce();
    expect(stage.banner(0)!.detail).toMatch(/Perceptron checked 0 of 3 demos \(3 unavailable/);
  });

  it('Esc while Perceptron is checking closes for good (a late answer is ignored)', async () => {
    let answer: (r: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/health') ? new Response(JSON.stringify({ perceptron: true })) : new Promise<Response>((r) => (answer = r)),
      ),
    );
    const { stage, deps, run, key } = setup();
    await stage.open();
    key('y');
    await run(8_000, () => hand(0.4, 1.5)); // OPEN demo recorded, check pending
    expect(stage.phase.kind).toBe('checking');
    key('escape');
    expect(stage.active).toBe(false);
    answer(new Response(JSON.stringify({ segments: [[0.5, 3.5]], poses: [], summary: '' })));
    await run(500, () => hand(0.4, 1.5));
    expect(stage.active).toBe(false);
    expect(deps.onClose).toHaveBeenCalledOnce();
  });

  it('is optional: N skips without touching anything', async () => {
    mockService(() => ({ segments: [] }));
    const { stage, deps, key } = setup();
    await stage.open();
    key('n');
    expect(stage.active).toBe(false);
    expect(deps.onClose).toHaveBeenCalledOnce();
    expect(deps.saveGrab).not.toHaveBeenCalled();
    expect(deps.gestures.setLiftThresholds).not.toHaveBeenCalled();
  });

  it('bounds personal lift thresholds', () => {
    expect(liftThresholds([0.2, 0.2, 0.2])).toEqual({ on: 0.35, off: 0.6 }); // never tighter than 0.35
    expect(liftThresholds([1.2, 1.2, 1.2])).toEqual({ on: 0.95, off: 1.2 }); // never looser than 0.95
  });
});
