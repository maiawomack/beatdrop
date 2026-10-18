import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkSnapshots, type Snapshot } from './perceptronCalibration';

/** Snapshots every 500 ms: open step at 0-1000 ms, fist step at 3000-4000 ms. */
const snaps: Snapshot[] = [
  { label: 0, t: 0, jpeg: 'data:image/jpeg;base64,AA==' },
  { label: 0, t: 500, jpeg: 'data:image/jpeg;base64,AA==' },
  { label: 0, t: 1000, jpeg: 'data:image/jpeg;base64,AA==' },
  { label: 1, t: 3000, jpeg: 'data:image/jpeg;base64,AA==' },
  { label: 1, t: 3500, jpeg: 'data:image/jpeg;base64,AA==' },
  { label: 1, t: 4000, jpeg: 'data:image/jpeg;base64,AA==' },
];

function mockService(verdicts: Record<'open' | 'fist', { pose: string; keep: boolean }[]> | { status: number; error: string }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      if ('status' in verdicts) return new Response(JSON.stringify({ error: verdicts.error }), { status: verdicts.status });
      const step = JSON.parse(String(init.body)).step as 'open' | 'fist';
      return new Response(JSON.stringify({ results: verdicts[step] }), { status: 200 });
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('Perceptron calibration check', () => {
  it('drops samples recorded around a snapshot that does not show the requested pose', async () => {
    mockService({
      open: [
        { pose: 'open_hand', keep: true },
        { pose: 'fist', keep: false }, // made a fist during the OPEN step
        { pose: 'open_hand', keep: true },
      ],
      fist: [
        { pose: 'partly_closed', keep: false }, // still closing when FIST began
        { pose: 'fist', keep: true },
        { pose: 'fist', keep: true },
      ],
    });
    const result = await checkSnapshots(snaps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dropped).toBe(2);
    expect(result.total).toBe(6);
    // Open step: the sample near the rejected 500 ms snapshot goes, neighbours stay.
    expect(result.keep({ label: 0, t: 40 })).toBe(true);
    expect(result.keep({ label: 0, t: 520 })).toBe(false);
    expect(result.keep({ label: 0, t: 990 })).toBe(true);
    // Fist step: the half-closed start is dropped; the real fist is kept.
    expect(result.keep({ label: 1, t: 3010 })).toBe(false);
    expect(result.keep({ label: 1, t: 3600 })).toBe(true);
    // A sample far from any snapshot of its step is kept: the check only removes what it saw.
    expect(result.keep({ label: 1, t: 6000 })).toBe(true);
    // Verdicts never cross steps: an open-step snapshot can't reject a fist sample.
    expect(result.keep({ label: 1, t: 500 })).toBe(true);
  });

  it('reports failure (so calibration falls back to every sample) when the service is unavailable', async () => {
    mockService({ status: 503, error: 'no Perceptron API key' });
    const result = await checkSnapshots(snaps);
    expect(result).toEqual({ ok: false, error: 'no Perceptron API key' });
  });

  it('rejects an answer that does not cover every snapshot', async () => {
    mockService({ open: [{ pose: 'open_hand', keep: true }], fist: [] });
    const result = await checkSnapshots(snaps);
    expect(result.ok).toBe(false);
  });
});
