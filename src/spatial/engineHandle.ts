import { AudioEngine } from '../audio/AudioEngine';
import { RemoteEngine, type EngineLike } from '../integration/engineSync';
import type { AudioCommand, AudioEngineState, ChannelKey, DeckId } from '../shared/types';

/** How long to wait for the decks screen before running standalone (ms). */
const HOST_WAIT_MS = 1200;

/**
 * The spatial workstation's engine. Normally the decks screen (Monitor 1)
 * owns the audio and this mirrors it (`remote`). With no decks screen open it
 * runs its own engine (`standalone`) so gestures can still be tried alone,
 * and hands over automatically when the decks screen opens.
 */
export class EngineHandle implements EngineLike {
  private local: AudioEngine | null = null;
  private current: EngineLike;
  private listeners = new Set<(state: AudioEngineState) => void>();
  private unsubscribe: () => void = () => {};
  /** Called after switching from standalone to the decks screen's engine. */
  onSwitch: () => void = () => {};

  private constructor(private remote: RemoteEngine) {
    this.current = remote;
    this.follow(remote);
  }

  static async create(): Promise<EngineHandle> {
    const remote = new RemoteEngine();
    const handle = new EngineHandle(remote);
    if (!(await remote.waitForHost(HOST_WAIT_MS))) handle.goStandalone();
    remote.onHost(() => handle.useRemote());
    return handle;
  }

  get mode(): 'remote' | 'standalone' {
    return this.local ? 'standalone' : 'remote';
  }

  /** Remote: whether the decks screen is still there. */
  get connected(): boolean {
    return this.local !== null || this.remote.connected;
  }

  /** 'running' when audio can be heard. */
  get audioState(): AudioContextState | 'unknown' {
    return this.local ? this.local.ctx.state : this.remote.audioState;
  }

  resume(): void {
    if (this.local) void this.local.resume();
    else this.remote.resume();
  }

  dispatch(command: AudioCommand): unknown {
    return this.current.dispatch(command);
  }
  getState(): AudioEngineState {
    return this.current.getState();
  }
  subscribe(listener: (state: AudioEngineState) => void): () => void {
    this.listeners.add(listener);
    listener(this.current.getState());
    return () => this.listeners.delete(listener);
  }
  getPositionSec(deck: DeckId): number {
    return this.current.getPositionSec(deck);
  }
  getEnvelope(deck: DeckId, channel: ChannelKey) {
    return this.current.getEnvelope(deck, channel);
  }
  getChannelLevel(deck: DeckId, channel: ChannelKey): number {
    return this.current.getChannelLevel(deck, channel);
  }
  getClipLevel(deck: DeckId, clipId: string): number {
    return this.current.getClipLevel(deck, clipId);
  }
  getClipPositionSec(deck: DeckId, clipId: string): number {
    return this.current.getClipPositionSec(deck, clipId);
  }

  close(): void {
    this.unsubscribe();
    this.remote.close();
    void this.local?.ctx.close();
  }

  private goStandalone(): void {
    this.local = new AudioEngine();
    this.current = this.local;
    this.follow(this.local);
  }

  /** The decks screen appeared: drop the local engine and mirror the shared one. */
  private useRemote(): void {
    if (!this.local) return;
    void this.local.ctx.close();
    this.local = null;
    this.current = this.remote;
    this.follow(this.remote);
    this.onSwitch();
  }

  private follow(engine: EngineLike): void {
    this.unsubscribe();
    this.unsubscribe = engine.subscribe((state) => {
      for (const l of this.listeners) l(state);
    });
  }
}
