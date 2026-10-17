import type { AudioCommandSink } from '../audio/AudioCommands';
import type { InteractionEvent } from '../ar/InteractionController';

/** Skip sends smaller than this to avoid flooding the audio engine. */
const EPSILON = 0.005;

/**
 * Maps object interaction to audio commands:
 *   x position -> pan    (left edge -1, right edge +1)
 *   y position -> volume (top 1, bottom 0)
 * Object ids are used as stem ids.
 */
export function createStemAudioBridge(sink: AudioCommandSink): (e: InteractionEvent) => void {
  const last = new Map<string, { pan: number; volume: number }>();

  return (e) => {
    const stemId = e.object.id;

    if (e.type === 'grab') sink.dispatch({ type: 'grab', stemId });

    const pan = e.object.position.x * 2 - 1;
    const volume = 1 - e.object.position.y;
    const prev = last.get(stemId);
    if (!prev || Math.abs(prev.pan - pan) > EPSILON) sink.dispatch({ type: 'setPan', stemId, value: pan });
    if (!prev || Math.abs(prev.volume - volume) > EPSILON) sink.dispatch({ type: 'setVolume', stemId, value: volume });
    last.set(stemId, { pan, volume });

    if (e.type === 'release') sink.dispatch({ type: 'release', stemId });
  };
}
