import { afterEach, describe, expect, it } from 'vitest';
import { MockAudioEngine } from '../audio/MockAudioEngine';
import { connectToAudioHost, hostAudioEngine, type RemoteEngine } from './broadcastSync';

// Node provides BroadcastChannel; messages between instances are async.
const settle = () => new Promise((r) => setTimeout(r, 80));

describe('cross-window sync', () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => {
    while (cleanup.length) cleanup.pop()!();
  });
  const client = (): RemoteEngine => {
    const c = connectToAudioHost();
    cleanup.push(() => c.close());
    return c;
  };

  it('a client gets initial state, and its commands reach the one hosted engine', async () => {
    const engine = new MockAudioEngine(['drums', 'bass']);
    engine.dispatch({ type: 'setVolume', stemId: 'drums', value: 0.4 });
    cleanup.push(hostAudioEngine(engine));
    const monitor1 = client();
    await settle();
    expect(monitor1.connected).toBe(true);
    expect(monitor1.stems.get('drums')?.volume).toBeCloseTo(0.4);
    expect(monitor1.transport.bpm).toBe(120);

    // Monitor 1 -> engine -> (Monitor 2 reads engine directly).
    monitor1.dispatch({ type: 'setFilter', stemId: 'bass', value: -0.5 });
    monitor1.dispatch({ type: 'setLoop', stemId: 'drums', beats: 2 });
    await settle();
    expect(engine.stems.get('bass')?.filter).toBeCloseTo(-0.5);
    expect(engine.stems.get('drums')?.loop?.beats).toBe(2);
    // ...and the resulting state comes back to Monitor 1.
    expect(monitor1.stems.get('bass')?.filter).toBeCloseTo(-0.5);
    expect(monitor1.stems.get('drums')?.loop?.beats).toBe(2);
  });

  it('spatial-side changes and drops are mirrored to other windows', async () => {
    const engine = new MockAudioEngine(['drums']);
    cleanup.push(hostAudioEngine(engine));
    const monitor1 = client();
    await settle();
    engine.dispatch({ type: 'setBuild', value: 0.8 });
    engine.dispatch({ type: 'drop' });
    engine.dispatch({ type: 'setMute', stemId: 'drums', value: true });
    await settle();
    expect(monitor1.perf.drops).toBe(1);
    expect(monitor1.perf.build).toBe(0);
    expect(monitor1.stems.get('drums')?.muted).toBe(true);
  });

  it('a second host is detected instead of silently playing twice', async () => {
    const conflicts: string[] = [];
    cleanup.push(hostAudioEngine(new MockAudioEngine(['drums']), { onConflict: (id) => conflicts.push(`a:${id}`) }));
    cleanup.push(hostAudioEngine(new MockAudioEngine(['drums']), { onConflict: (id) => conflicts.push(`b:${id}`) }));
    await settle();
    expect(conflicts.some((c) => c.startsWith('a:'))).toBe(true);
    expect(conflicts.some((c) => c.startsWith('b:'))).toBe(true);
  });
});
