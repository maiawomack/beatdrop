import {
  defaultPerformanceState,
  type AudioCommand,
  type AudioCommandSink,
  type AudioStateSource,
  type PerformanceState,
  type StemId,
  type StemState,
  type TransportState,
} from '../audio/AudioCommands';

/**
 * Cross-window sync over BroadcastChannel (same origin, same browser).
 *
 * Exactly ONE window hosts the audio engine (`hostAudioEngine`). Other
 * windows (e.g. the traditional DJ monitor) use `connectToAudioHost`, which
 * looks like a local engine: dispatch() forwards commands to the host, and
 * `stems` / `perf` / `transport` / subscribe() mirror the host's
 * authoritative state. A client never plays audio, so there's no duplicate
 * playback; if a second host appears, both hosts get `onConflict`.
 *
 * Timing: `transport.anchorMs` and `perf.dropAtMs` are wall-clock
 * (performance.timeOrigin-based) so they mean the same instant in every
 * window; compute beat position locally with `beatAt()`.
 *
 * Proposal from the spatial workstation; the integration owner should
 * confirm or replace it.
 */
export const SYNC_CHANNEL = 'beatdrop-sync';

export interface StateSnapshot {
  stems: Record<StemId, StemState>;
  perf: PerformanceState;
  transport: TransportState;
}

export type SyncMessage =
  | { type: 'command'; command: AudioCommand }
  | { type: 'state'; hostId: string; state: StateSnapshot }
  | { type: 'requestState' };

/** Max state broadcasts per second (commands are applied immediately). */
const STATE_HZ = 30;
/** Rebroadcast at least this often so late or drifting clients resync (ms). */
const HEARTBEAT_MS = 2000;

export function snapshot(engine: AudioStateSource): StateSnapshot {
  return {
    stems: structuredClone(Object.fromEntries(engine.stems)) as Record<StemId, StemState>,
    perf: { ...engine.perf },
    transport: { ...engine.transport },
  };
}

export interface HostOptions {
  /** Called if another window is also hosting an engine (duplicate playback). */
  onConflict?: (otherHostId: string) => void;
}

export function hostAudioEngine(engine: AudioCommandSink & AudioStateSource, opts: HostOptions = {}): () => void {
  const channel = new BroadcastChannel(SYNC_CHANNEL);
  const hostId = Math.random().toString(36).slice(2, 10);
  let pending: ReturnType<typeof setTimeout> | null = null;
  let conflicted = false;

  const sendState = () => {
    pending = null;
    channel.postMessage({ type: 'state', hostId, state: snapshot(engine) } satisfies SyncMessage);
  };
  const scheduleState = () => {
    if (pending === null) pending = setTimeout(sendState, 1000 / STATE_HZ);
  };

  channel.onmessage = (e: MessageEvent<SyncMessage>) => {
    const msg = e.data;
    if (msg.type === 'command') engine.dispatch(msg.command);
    else if (msg.type === 'requestState') sendState();
    else if (msg.type === 'state' && msg.hostId !== hostId && !conflicted) {
      conflicted = true;
      opts.onConflict?.(msg.hostId);
      sendState(); // let the other host find out too
    }
  };
  const unsubscribe = engine.subscribe(scheduleState);
  const heartbeat = setInterval(sendState, HEARTBEAT_MS);
  sendState();

  return () => {
    unsubscribe();
    clearInterval(heartbeat);
    if (pending !== null) clearTimeout(pending);
    channel.close();
  };
}

export type RemoteEngine = AudioCommandSink & AudioStateSource & { close(): void; readonly connected: boolean };

/** For non-host windows: a remote handle to the hosted engine. */
export function connectToAudioHost(): RemoteEngine {
  const channel = new BroadcastChannel(SYNC_CHANNEL);
  const stems = new Map<StemId, StemState>();
  const listeners = new Set<() => void>();
  const perf: PerformanceState = defaultPerformanceState();
  const transport: TransportState = { playing: false, bpm: null, beatsPerBar: 4, anchorMs: null, durationSec: 0 };
  let connected = false;

  channel.onmessage = (e: MessageEvent<SyncMessage>) => {
    if (e.data.type !== 'state') return;
    const { state } = e.data;
    connected = true;
    stems.clear();
    for (const [id, s] of Object.entries(state.stems)) stems.set(id, s);
    Object.assign(perf, state.perf);
    Object.assign(transport, state.transport);
    for (const l of listeners) l();
  };
  channel.postMessage({ type: 'requestState' } satisfies SyncMessage);

  return {
    stems,
    perf,
    transport,
    get connected() {
      return connected;
    },
    dispatch(command) {
      channel.postMessage({ type: 'command', command } satisfies SyncMessage);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => channel.close(),
  };
}
