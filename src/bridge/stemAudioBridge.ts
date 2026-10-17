import type { AudioCommandSink } from '../audio/AudioCommands';
import type { InteractionEvent } from '../ar/InteractionController';

/** Skip sends smaller than this to avoid flooding the audio engine. */
const EPSILON = 0.005;

/**
 * Maps object interaction to audio commands:
 *   x position     -> pan     (left edge -1, right edge +1)
 *   y position     -> volume  (top 1, bottom 0)
 *   two-hand span  -> stretch (0..1, snaps back to 0 when a hand lets go)
 * Object ids are used as stem ids.
 */
export function createStemAudioBridge(sink: AudioCommandSink): (e: InteractionEvent) => void {
  const last = new Map<string, { pan: number; volume: number; stretch: number }>();

  return (e) => {
    const { object } = e;
    const stemId = object.id;

    if (e.type === 'grab') sink.dispatch({ type: 'grab', stemId });
    if (e.type === 'release') sink.dispatch({ type: 'release', stemId });
    if (e.type !== 'move' && e.type !== 'stretchEnd') return;

    const pan = object.position.x * 2 - 1;
    const volume = 1 - object.position.y;
    const stretch = object.stretch?.amount ?? 0;
    const prev = last.get(stemId);
    const changed = (a: number | undefined, b: number) => a === undefined || Math.abs(a - b) > EPSILON;

    if (changed(prev?.pan, pan)) sink.dispatch({ type: 'setPan', stemId, value: pan });
    if (changed(prev?.volume, volume)) sink.dispatch({ type: 'setVolume', stemId, value: volume });
    if (changed(prev?.stretch, stretch) || (stretch === 0 && prev?.stretch !== 0)) {
      sink.dispatch({ type: 'setStretch', stemId, value: stretch });
    }
    last.set(stemId, { pan, volume, stretch });
  };
}
