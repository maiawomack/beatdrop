import type { AudioEngine } from '../audio/AudioEngine';
import {
  DECK_IDS,
  STEM_IDS,
  type AudioCommand,
  type AudioEngineState,
  type ChannelKey,
  type DeckId,
  type DeckState,
} from '../shared/types';

/**
 * Shares one AudioEngine (Task 1) between windows over BroadcastChannel
 * (same browser, same origin: open every page from the same host, e.g. all
 * from http://127.0.0.1:5173).
 *
 * - The decks screen (Monitor 1) owns the engine and calls `hostEngine()`.
 * - Other windows (the spatial workstation, Monitor 2) call `connectEngine()`
 *   and get a RemoteEngine: dispatch() sends commands to the host, and state,
 *   live positions, levels and waveform envelopes mirror the host's engine.
 *   No audio plays in client windows, so there is never duplicate playback.
 *
 * Messages: the host broadcasts `state` on every engine change, `telemetry`
 * (positions + levels) ~30x/s while anything plays, and `announce` every 2 s.
 * Envelopes are sent on request (once per track and channel).
 */
export const ENGINE_CHANNEL = 'beatdrop-engine';

const TELEMETRY_MS = 33;
const ANNOUNCE_MS = 2000;
/** A client counts the host as gone after this long without hearing from it. */
const HOST_TIMEOUT_MS = 5000;

const CHANNELS: ChannelKey[] = [...STEM_IDS, 'full'];

interface DeckTelemetry {
  positionSec: number;
  playing: boolean;
  rate: number;
  levels: Partial<Record<ChannelKey, number>>;
  clips: Record<string, { positionSec: number; level: number }>;
}

export type EngineMessage =
  | { type: 'announce'; hostId: string }
  | { type: 'hello' }
  | { type: 'state'; hostId: string; state: AudioEngineState }
  | { type: 'telemetry'; hostId: string; audio: AudioContextState; decks: Record<DeckId, DeckTelemetry> }
  | { type: 'command'; command: AudioCommand }
  | { type: 'resume' }
  | { type: 'envelopeRequest'; deck: DeckId; channel: ChannelKey; key: string }
  | { type: 'envelope'; deck: DeckId; channel: ChannelKey; key: string; data: Float32Array; rate: number; duration: number };

/** What the spatial workstation needs from an engine, local or remote. */
export interface EngineLike {
  dispatch(command: AudioCommand): unknown;
  getState(): AudioEngineState;
  subscribe(listener: (state: AudioEngineState) => void): () => void;
  getPositionSec(deck: DeckId): number;
  getEnvelope(deck: DeckId, channel: ChannelKey): { data: Float32Array; rate: number; duration: number } | null;
  getChannelLevel(deck: DeckId, channel: ChannelKey): number;
  getClipLevel(deck: DeckId, clipId: string): number;
  getClipPositionSec(deck: DeckId, clipId: string): number;
}

/** Identifies a deck's loaded audio, so envelopes are refetched when the track changes. */
export function trackKey(d: DeckState): string {
  return `${d.track?.id ?? ''}|${d.source}|${d.durationSec.toFixed(3)}`;
}

/** Share `engine` with other windows. Returns a function that stops sharing. */
export function hostEngine(engine: AudioEngine, opts: { onConflict?: () => void } = {}): () => void {
  const channel = new BroadcastChannel(ENGINE_CHANNEL);
  const hostId = Math.random().toString(36).slice(2, 10);
  let pendingState = false;
  let latest = engine.getState();

  const post = (msg: EngineMessage) => channel.postMessage(msg);
  const sendState = () => {
    pendingState = false;
    post({ type: 'state', hostId, state: latest });
  };
  // Coalesce bursts of changes (a gesture can send several commands per frame).
  const unsubscribe = engine.subscribe((state) => {
    latest = state;
    if (!pendingState) {
      pendingState = true;
      queueMicrotask(sendState);
    }
  });

  channel.onmessage = (e: MessageEvent<EngineMessage>) => {
    const msg = e.data;
    switch (msg.type) {
      case 'command':
        engine.dispatch(msg.command).catch((err) => console.error('[engine sync] command failed', msg.command, err));
        break;
      case 'hello':
        post({ type: 'announce', hostId });
        latest = engine.getState();
        sendState();
        break;
      case 'resume':
        void engine.resume();
        break;
      case 'envelopeRequest': {
        const env = engine.getEnvelope(msg.deck, msg.channel);
        if (env && trackKey(engine.getState().decks[msg.deck]) === msg.key) {
          post({ type: 'envelope', deck: msg.deck, channel: msg.channel, key: msg.key, ...env });
        }
        break;
      }
      case 'announce':
      case 'state':
        if (msg.hostId !== hostId) {
          console.warn('[engine sync] Another window is also hosting the audio engine. Only one should.');
          opts.onConflict?.();
        }
        break;
    }
  };

  const telemetry = setInterval(() => {
    const state = latest;
    if (!DECK_IDS.some((d) => state.decks[d].playing)) return;
    const decks = {} as Record<DeckId, DeckTelemetry>;
    for (const id of DECK_IDS) {
      const d = state.decks[id];
      const levels: Partial<Record<ChannelKey, number>> = {};
      for (const ch of CHANNELS) levels[ch] = engine.getChannelLevel(id, ch);
      const clips: DeckTelemetry['clips'] = {};
      for (const clipId of Object.keys(d.clips)) {
        clips[clipId] = { positionSec: engine.getClipPositionSec(id, clipId), level: engine.getClipLevel(id, clipId) };
      }
      decks[id] = { positionSec: engine.getPositionSec(id), playing: d.playing, rate: d.playbackRate, levels, clips };
    }
    post({ type: 'telemetry', hostId, audio: engine.ctx.state, decks });
  }, TELEMETRY_MS);
  const announce = setInterval(() => post({ type: 'announce', hostId }), ANNOUNCE_MS);
  post({ type: 'announce', hostId });
  sendState();

  return () => {
    unsubscribe();
    clearInterval(telemetry);
    clearInterval(announce);
    channel.close();
  };
}

/**
 * A window's handle to the engine hosted elsewhere. Works like a local engine:
 * dispatch commands, read state, subscribe; positions and levels come from the
 * host's telemetry (extrapolated between updates).
 */
export class RemoteEngine implements EngineLike {
  private channel = new BroadcastChannel(ENGINE_CHANNEL);
  private state: AudioEngineState = emptyEngineState();
  private listeners = new Set<(state: AudioEngineState) => void>();
  private telemetry: { at: number; decks: Record<DeckId, DeckTelemetry> } | null = null;
  /** When the latest state arrived (performance.now()), to tell which source is fresher. */
  private stateAt = -Infinity;
  private envelopes = new Map<string, { data: Float32Array; rate: number; duration: number }>();
  private requested = new Set<string>();
  private lastHeard = -Infinity;
  private hostListeners = new Set<() => void>();
  /** The host's AudioContext state ('suspended' until someone interacts with the host window). */
  audioState: AudioContextState | 'unknown' = 'unknown';

  constructor() {
    this.channel.onmessage = (e: MessageEvent<EngineMessage>) => this.receive(e.data);
    this.channel.postMessage({ type: 'hello' } satisfies EngineMessage);
  }

  /** True while the host has been heard from recently. */
  get connected(): boolean {
    return performance.now() - this.lastHeard < HOST_TIMEOUT_MS;
  }

  /** Resolves true once a host answers, or false after `timeoutMs`. */
  waitForHost(timeoutMs: number): Promise<boolean> {
    if (this.connected) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        this.hostListeners.delete(onHost);
        resolve(ok);
      };
      const onHost = () => done(true);
      const timer = setTimeout(() => done(false), timeoutMs);
      this.hostListeners.add(onHost);
    });
  }

  /** Called whenever a host is heard after having been silent (e.g. the decks screen opened). */
  onHost(listener: () => void): () => void {
    this.hostListeners.add(listener);
    return () => this.hostListeners.delete(listener);
  }

  dispatch(command: AudioCommand): Promise<void> {
    this.channel.postMessage({ type: 'command', command } satisfies EngineMessage);
    return Promise.resolve();
  }

  /** Ask the host to start its audio (only works once the host window has had a click or key press). */
  resume(): void {
    this.channel.postMessage({ type: 'resume' } satisfies EngineMessage);
  }

  getState(): AudioEngineState {
    return this.state;
  }

  subscribe(listener: (state: AudioEngineState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  getPositionSec(deck: DeckId): number {
    const d = this.state.decks[deck];
    // Paused or stopped: the host stamped the exact position. (Telemetry stops when nothing
    // plays, so its last packet still says "playing" and must not be extrapolated.)
    if (!d.playing) return d.positionSec;
    const tel = this.telemetry;
    const t = tel?.decks[deck];
    // Telemetry, unless the state changed since (play, seek, tempo). It also carries the
    // scratch position, which the state doesn't.
    if (tel && t?.playing && (tel.at >= this.stateAt || d.scratching)) {
      return t.positionSec + ((performance.now() - tel.at) / 1000) * t.rate;
    }
    return d.positionSec + ((Date.now() - d.positionAt) / 1000) * d.playbackRate;
  }

  getChannelLevel(deck: DeckId, channel: ChannelKey): number {
    return this.state.decks[deck].playing ? (this.telemetry?.decks[deck].levels[channel] ?? 0) : 0;
  }

  getClipLevel(deck: DeckId, clipId: string): number {
    return this.state.decks[deck].playing ? (this.telemetry?.decks[deck].clips[clipId]?.level ?? 0) : 0;
  }

  getClipPositionSec(deck: DeckId, clipId: string): number {
    const clip = this.state.decks[deck].clips[clipId];
    const t = this.telemetry?.decks[deck];
    const c = t?.clips[clipId];
    if (!clip || !c || !t) return clip?.startSec ?? 0;
    const elapsed = t.playing && this.state.decks[deck].playing ? ((performance.now() - this.telemetry!.at) / 1000) * t.rate : 0;
    const len = clip.endSec - clip.startSec;
    return clip.startSec + mod(c.positionSec - clip.startSec + elapsed, len);
  }

  getEnvelope(deck: DeckId, channel: ChannelKey): { data: Float32Array; rate: number; duration: number } | null {
    const d = this.state.decks[deck];
    if (d.status !== 'ready') return null;
    const key = trackKey(d);
    const id = `${deck}|${channel}|${key}`;
    const env = this.envelopes.get(id);
    if (env) return env;
    if (!this.requested.has(id)) {
      this.requested.add(id);
      this.channel.postMessage({ type: 'envelopeRequest', deck, channel, key } satisfies EngineMessage);
    }
    return null;
  }

  close(): void {
    this.channel.close();
    this.listeners.clear();
  }

  private receive(msg: EngineMessage): void {
    if (msg.type === 'announce' || msg.type === 'state' || msg.type === 'telemetry') {
      const wasConnected = this.connected;
      this.lastHeard = performance.now();
      if (!wasConnected) {
        // A (new) host: forget anything cached from an earlier one.
        this.requested.clear();
        for (const l of [...this.hostListeners]) l();
        if (msg.type === 'announce') this.channel.postMessage({ type: 'hello' } satisfies EngineMessage);
      }
    }
    switch (msg.type) {
      case 'state':
        this.state = msg.state;
        this.stateAt = performance.now();
        for (const l of this.listeners) l(this.state);
        break;
      case 'telemetry':
        this.telemetry = { at: performance.now(), decks: msg.decks };
        this.audioState = msg.audio;
        break;
      case 'envelope':
        this.envelopes.set(`${msg.deck}|${msg.channel}|${msg.key}`, { data: msg.data, rate: msg.rate, duration: msg.duration });
        break;
    }
  }
}

/** Engine state before anything is known (no tracks, default mixer). */
export function emptyEngineState(): AudioEngineState {
  const deck = (id: DeckId): DeckState => ({
    id,
    track: null,
    source: 'none',
    status: 'empty',
    error: null,
    playing: false,
    positionSec: 0,
    positionAt: Date.now(),
    durationSec: 0,
    playbackRate: 1,
    bpm: null,
    gain: 1,
    stems: Object.fromEntries(STEM_IDS.map((s) => [s, { gain: 1, muted: false, available: false }])) as DeckState['stems'],
    eq: { low: 0, mid: 0, high: 0 },
    filter: 0,
    echo: 0,
    loop: null,
    firstBeatSec: 0,
    bpmSource: null,
    channelFilter: {},
    clips: {},
    scratching: false,
  });
  return {
    decks: { A: deck('A'), B: deck('B') },
    mixer: { crossfader: 0, masterGain: 1, build: 0, dropPending: false, dropAtMs: null, dropQuantized: false, drops: 0 },
  };
}

function mod(a: number, n: number): number {
  return n > 0 ? ((a % n) + n) % n : 0;
}
