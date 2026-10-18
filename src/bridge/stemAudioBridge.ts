import type { AudioCommandSink } from '../audio/AudioCommands';
import type { InteractionEvent } from '../ar/InteractionController';

/** Skip sends smaller than this to avoid flooding the audio engine. */
const EPSILON = 0.005;

/**
 * Gives spatial interactions their musical meaning:
 *   move / reposition    -> nothing (layout only)
 *   level handle drag    -> setVolume
 *   tap on body          -> nothing (mute removed for now)
 *   two-hand stretch     -> setFx (filter sweep + echo), persists after release
 *   grab / release       -> grab / release (engine plays a feedback click)
 *   two-stem blend pair  -> setVolume on the other stems (ducked by isolation;
 *                           restored exactly when isolation returns to 0)
 *   loop cap             -> setLoop on release (preview while held is visual only)
 *   loop cap pulled out  -> createClip (a floating loop of the last few beats)
 *   clip back into stem  -> removeClip
 *   twist while holding  -> setFilter (same as the filter cap)
 *   filter cap           -> setFilter while moving; held on release
 *   build core           -> setBuild while raising, drop on slam, setBuild(0) on cancel
 *   palm on a record     -> scratch start / move / end
 *   fingers up + slide   -> setCrossfader
 *   pinch a tempo strip  -> setTempo (tap = back to ×1.00)
 * Performance effects run on separate engine nodes, so they never change the
 * fader / mute / solo values the DJ set.
 * Object ids are used as stem ids. Current audio values are read from the
 * object's `audio` mirror of engine state, never from its position.
 */
export function createStemAudioBridge(sink: AudioCommandSink): (e: InteractionEvent) => void {
  const sentFx = new Map<string, number>();
  const sentVolume = new Map<string, number>();
  /** Volume each ducked stem had before blending ducked it. */
  const unducked = new Map<string, number>();

  const sentFilter = new Map<string, number>();
  let sentBuild = 0;

  return (e) => {
    switch (e.type) {
      case 'buildStart':
        sentBuild = 0;
        return;
      case 'build':
        if (Math.abs(e.value - sentBuild) > EPSILON || (e.value === 0 && sentBuild !== 0)) {
          sink.dispatch({ type: 'setBuild', value: e.value });
          sentBuild = e.value;
        }
        return;
      case 'drop':
        // Make sure the engine has the peak before dropping it.
        if (e.build !== sentBuild) sink.dispatch({ type: 'setBuild', value: e.build });
        sink.dispatch({ type: 'drop' });
        sentBuild = 0;
        return;
      case 'scratchStart':
        sink.dispatch({ type: 'scratch', deck: e.deck, phase: 'start', offsetSec: 0 });
        return;
      case 'scratch':
        sink.dispatch({ type: 'scratch', deck: e.deck, phase: 'move', offsetSec: e.offsetSec });
        return;
      case 'scratchEnd':
        sink.dispatch({ type: 'scratch', deck: e.deck, phase: 'end', offsetSec: 0 });
        return;
      case 'crossfadeStart':
      case 'crossfadeEnd':
        return;
      case 'crossfade':
        sink.dispatch({ type: 'setCrossfader', value: e.value });
        return;
      case 'tempo':
        sink.dispatch({ type: 'setTempo', deck: e.deck, rate: e.rate });
        return;
      case 'buildEnd':
        if (!e.dropped && sentBuild > 0) sink.dispatch({ type: 'setBuild', value: 0 });
        sentBuild = 0;
        return;
    }

    const { object } = e;
    const stemId = object.id;

    switch (e.type) {
      case 'clipCreate':
        sink.dispatch({ type: 'createClip', stemId, clipId: e.clipId, beats: e.beats });
        break;
      case 'clipReturn':
        sink.dispatch({ type: 'removeClip', stemId });
        break;
      case 'loopCommit':
        sink.dispatch({ type: 'setLoop', stemId, beats: e.beats });
        break;
      case 'filter': {
        const prev = sentFilter.get(stemId) ?? object.audio.filter;
        if (Math.abs(prev - e.value) > EPSILON || (e.value === 0 && prev !== 0)) {
          sink.dispatch({ type: 'setFilter', stemId, value: e.value });
          sentFilter.set(stemId, e.value);
        }
        break;
      }
      case 'filterEnd':
        sentFilter.delete(stemId);
        break;
      case 'grab':
      case 'levelStart':
        sink.dispatch({ type: 'grab', stemId });
        break;
      case 'release':
      case 'levelEnd':
        sink.dispatch({ type: 'release', stemId });
        sentVolume.delete(stemId);
        break;
      case 'tap':
        break; // no tap-to-mute (removed for now)
      case 'level': {
        const prev = sentVolume.get(stemId);
        const atEdge = (e.value === 0 || e.value === 1) && prev !== e.value;
        if (prev === undefined || Math.abs(prev - e.value) > EPSILON || atEdge) {
          sink.dispatch({ type: 'setVolume', stemId, value: e.value });
          sentVolume.set(stemId, e.value);
        }
        break;
      }
      case 'blend': {
        // Stems in the pair are never ducked: restore them if an earlier pair ducked them.
        for (const o of [e.object, e.partner]) {
          const base = unducked.get(o.id);
          if (base !== undefined) {
            sink.dispatch({ type: 'setVolume', stemId: o.id, value: base });
            unducked.delete(o.id);
          }
        }
        for (const o of e.others) {
          if (!unducked.has(o.id)) unducked.set(o.id, o.audio.volume);
          const base = unducked.get(o.id)!;
          const value = e.value < EPSILON ? base : base * (1 - e.value);
          if (Math.abs(o.audio.volume - value) > EPSILON || (e.value < EPSILON && o.audio.volume !== base)) {
            sink.dispatch({ type: 'setVolume', stemId: o.id, value });
          }
          if (e.value < EPSILON) unducked.delete(o.id);
        }
        break;
      }
      case 'move':
      case 'stretchEnd': {
        const fx = object.stretchAmount;
        const prev = sentFx.get(stemId) ?? object.audio.fx;
        const atEdge = (fx === 0 || fx === 1) && prev !== fx;
        if (Math.abs(prev - fx) > EPSILON || atEdge) {
          sink.dispatch({ type: 'setFx', stemId, value: fx });
          sentFx.set(stemId, fx);
        }
        break;
      }
    }
  };
}
