import { afterEach, describe, expect, it } from 'vitest';
import type { AudioEngine } from '../audio/AudioEngine';
import type { AudioCommand, AudioEngineState, ChannelKey, DeckId } from '../shared/types';
import { emptyEngineState, hostEngine, RemoteEngine } from './engineSync';

// Node has BroadcastChannel; delivery between instances is async.
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

/** Enough of AudioEngine for the host: state, commands, positions, levels, envelopes. */
class FakeEngine {
  state: AudioEngineState = emptyEngineState();
  log: AudioCommand[] = [];
  listeners = new Set<(s: AudioEngineState) => void>();
  ctx = { state: 'running' as AudioContextState };
  resumed = 0;
  async dispatch(c: AudioCommand) {
    this.log.push(c);
    if (c.type === 'SET_STEM_GAIN') this.state.decks[c.deck].stems[c.stem].gain = c.gain;
    if (c.type === 'PLAY') this.state.decks[c.deck].playing = true;
    if (c.type === 'PAUSE') Object.assign(this.state.decks[c.deck], { playing: false, positionSec: 42.5, positionAt: Date.now() });
    this.emit();
  }
  getState() {
    return structuredClone(this.state);
  }
  subscribe(l: (s: AudioEngineState) => void) {
    this.listeners.add(l);
    l(this.getState());
    return () => this.listeners.delete(l);
  }
  emit() {
    for (const l of this.listeners) l(this.getState());
  }
  getPositionSec(_d: DeckId) {
    return 42;
  }
  getChannelLevel(_d: DeckId, ch: ChannelKey) {
    return ch === 'full' ? 0.7 : 0;
  }
  getClipLevel() {
    return 0;
  }
  getClipPositionSec() {
    return 0;
  }
  getEnvelope(_d: DeckId, _ch: ChannelKey) {
    return { data: new Float32Array([0.1, 0.5, 1]), rate: 100, duration: 0.03 };
  }
  async resume() {
    this.resumed++;
  }
}

describe('engine sharing between windows', () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => {
    while (cleanup.length) cleanup.pop()!();
  });
  const host = (e: FakeEngine, onConflict?: () => void) => cleanup.push(hostEngine(e as unknown as AudioEngine, { onConflict }));
  const client = () => {
    const r = new RemoteEngine();
    cleanup.push(() => r.close());
    return r;
  };

  it('a client finds the host, mirrors its state, and its commands reach the one engine', async () => {
    const engine = new FakeEngine();
    engine.state.decks.A.status = 'ready';
    engine.state.decks.A.source = 'full';
    host(engine);
    const spatial = client();
    expect(await spatial.waitForHost(500)).toBe(true);
    await settle();
    expect(spatial.getState().decks.A.status).toBe('ready');

    // Monitor 2 -> engine -> back to Monitor 2.
    await spatial.dispatch({ type: 'SET_STEM_GAIN', deck: 'A', stem: 'vocals', gain: 0.3 });
    await settle();
    expect(engine.log).toContainEqual({ type: 'SET_STEM_GAIN', deck: 'A', stem: 'vocals', gain: 0.3 });
    expect(spatial.getState().decks.A.stems.vocals.gain).toBeCloseTo(0.3);

    // Changes made on the host (Monitor 1) show up too.
    engine.state.decks.B.gain = 0.5;
    engine.emit();
    await settle();
    expect(spatial.getState().decks.B.gain).toBeCloseTo(0.5);
  });

  it('streams positions and levels while playing, and sends waveform envelopes on request', async () => {
    const engine = new FakeEngine();
    engine.state.decks.A.status = 'ready';
    engine.state.decks.A.source = 'full';
    host(engine);
    const spatial = client();
    await spatial.waitForHost(500);
    await spatial.dispatch({ type: 'PLAY', deck: 'A' });
    await settle(120);
    expect(spatial.getChannelLevel('A', 'full')).toBeCloseTo(0.7);
    expect(spatial.getPositionSec('A')).toBeGreaterThanOrEqual(42);
    expect(spatial.audioState).toBe('running');

    expect(spatial.getEnvelope('A', 'full')).toBeNull(); // first call asks the host
    await settle();
    expect(Array.from(spatial.getEnvelope('A', 'full')!.data)).toEqual([
      expect.closeTo(0.1),
      expect.closeTo(0.5),
      expect.closeTo(1),
    ]);
  });

  it('a paused deck stays put (the last telemetry before the pause must not keep it moving)', async () => {
    const engine = new FakeEngine();
    engine.state.decks.A.status = 'ready';
    engine.state.decks.A.source = 'full';
    host(engine);
    const spatial = client();
    await spatial.waitForHost(500);
    await spatial.dispatch({ type: 'PLAY', deck: 'A' });
    await settle(120);
    await spatial.dispatch({ type: 'PAUSE', deck: 'A' }); // nothing plays now: telemetry stops
    await settle();
    const paused = spatial.getPositionSec('A');
    await settle(150);
    expect(paused).toBeCloseTo(42.5);
    expect(spatial.getPositionSec('A')).toBe(paused);
  });

  it('forwards resume to the host (to start audio from the other window)', async () => {
    const engine = new FakeEngine();
    host(engine);
    const spatial = client();
    await spatial.waitForHost(500);
    spatial.resume();
    await settle();
    expect(engine.resumed).toBe(1);
  });

  it('without a host, waitForHost gives up (the spatial page then runs standalone)', async () => {
    const spatial = client();
    expect(await spatial.waitForHost(150)).toBe(false);
    expect(spatial.connected).toBe(false);
  });

  it('a second host is flagged instead of silently playing twice', async () => {
    let conflicts = 0;
    host(new FakeEngine(), () => conflicts++);
    host(new FakeEngine(), () => conflicts++);
    await settle();
    expect(conflicts).toBeGreaterThan(0);
  });
});
