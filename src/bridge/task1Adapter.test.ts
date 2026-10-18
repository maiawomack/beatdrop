import { describe, expect, it } from 'vitest';
import { beatAt } from '../audio/AudioCommands';
import { STEM_IDS, type AudioCommand, type AudioEngineState, type DeckId, type DeckState } from '../shared/types';
import { parseId, Task1Adapter, type Task1Engine } from './task1Adapter';

function deck(id: DeckId, over: Partial<DeckState> = {}): DeckState {
  const stems = Object.fromEntries(STEM_IDS.map((s) => [s, { gain: 1, muted: false, available: false }])) as DeckState['stems'];
  return {
    id,
    track: null,
    source: 'none',
    status: 'empty',
    error: null,
    playing: false,
    positionSec: 0,
    positionAt: Date.now(),
    durationSec: 180,
    playbackRate: 1,
    bpm: null,
    gain: 1,
    stems,
    eq: { low: 0, mid: 0, high: 0 },
    filter: 0,
    echo: 0,
    loop: null,
    firstBeatSec: 0,
    bpmSource: null,
    channelFilter: {},
    clips: {},
    scratching: false,
    ...over,
  };
}

class FakeEngine implements Task1Engine {
  log: AudioCommand[] = [];
  listeners = new Set<(s: AudioEngineState) => void>();
  state: AudioEngineState = {
    decks: { A: deck('A'), B: deck('B') },
    mixer: { crossfader: 0, masterGain: 1, build: 0, dropPending: false, dropAtMs: null, dropQuantized: false, drops: 0 },
  };
  dispatch(c: AudioCommand) {
    this.log.push(c);
  }
  getState() {
    return structuredClone(this.state);
  }
  subscribe(l: (s: AudioEngineState) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit() {
    for (const l of this.listeners) l(this.getState());
  }
}

function separated(id: DeckId, over: Partial<DeckState> = {}): DeckState {
  const d = deck(id, { status: 'ready', source: 'stems', ...over });
  for (const s of STEM_IDS) d.stems[s].available = true;
  return d;
}

describe('Task 1 engine adapter', () => {
  it('exposes a full-mix deck as one channel and a separated deck as its stems', () => {
    const e = new FakeEngine();
    e.state.decks.A = deck('A', { status: 'ready', source: 'full' });
    e.state.decks.B = separated('B');
    const a = new Task1Adapter(e);
    expect([...a.stems.keys()].sort()).toEqual(['A:full', 'B:bass', 'B:drums', 'B:instrumental', 'B:vocals']);
  });

  it('maps spatial commands onto the deck commands', () => {
    const e = new FakeEngine();
    e.state.decks.A = separated('A');
    const a = new Task1Adapter(e);
    a.dispatch({ type: 'setVolume', stemId: 'A:vocals', value: 0.4 });
    a.dispatch({ type: 'setMute', stemId: 'A:drums', value: true });
    a.dispatch({ type: 'setFilter', stemId: 'A:bass', value: -0.5 });
    a.dispatch({ type: 'setLoop', stemId: 'A:bass', beats: 2 });
    a.dispatch({ type: 'createClip', stemId: 'A:vocals', clipId: 'A:vocals~1', beats: 4 });
    a.dispatch({ type: 'setFilter', stemId: 'A:vocals~1', value: 0.3 });
    a.dispatch({ type: 'removeClip', stemId: 'A:vocals~1' });
    a.dispatch({ type: 'setBuild', value: 0.7 });
    a.dispatch({ type: 'drop' });
    a.dispatch({ type: 'setSolo', stemId: 'A:vocals', value: true }); // unsupported: ignored
    expect(e.log).toEqual([
      { type: 'SET_STEM_GAIN', deck: 'A', stem: 'vocals', gain: 0.4 },
      { type: 'SET_STEM_MUTE', deck: 'A', stem: 'drums', muted: true },
      { type: 'SET_CHANNEL_FILTER', deck: 'A', channel: 'bass', value: -0.5 },
      { type: 'SET_LOOP_BEATS', deck: 'A', beats: 2 },
      { type: 'CREATE_CLIP', deck: 'A', channel: 'vocals', clipId: 'A:vocals~1', beats: 4 },
      { type: 'SET_CLIP_FILTER', deck: 'A', clipId: 'A:vocals~1', value: 0.3 },
      { type: 'REMOVE_CLIP', deck: 'A', clipId: 'A:vocals~1' },
      { type: 'SET_BUILD', value: 0.7 },
      { type: 'DROP' },
    ]);
  });

  it('mutes a full mix with the deck gain and restores the exact gain', () => {
    const e = new FakeEngine();
    e.state.decks.A = deck('A', { status: 'ready', source: 'full', gain: 0.6 });
    const a = new Task1Adapter(e);
    a.dispatch({ type: 'setMute', stemId: 'A:full', value: true });
    expect(e.log.pop()).toEqual({ type: 'SET_DECK_GAIN', deck: 'A', gain: 0 });
    e.state.decks.A.gain = 0;
    e.emit();
    expect(a.stems.get('A:full')).toMatchObject({ muted: true, volume: 0.6 });
    a.dispatch({ type: 'setMute', stemId: 'A:full', value: false });
    expect(e.log.pop()).toEqual({ type: 'SET_DECK_GAIN', deck: 'A', gain: 0.6 });
  });

  it('shows clips as stems of their own and their source as ducked', () => {
    const e = new FakeEngine();
    e.state.decks.A = separated('A', {
      clips: {
        'A:vocals~1': { channel: 'vocals', beats: 4, startSec: 10, endSec: 12, gain: 1, muted: false, filter: 0, engaged: true },
      },
    });
    const a = new Task1Adapter(e);
    expect(a.stems.get('A:vocals~1')).toMatchObject({ clipOf: 'A:vocals', loop: { beats: 4, startSec: 10, endSec: 12 } });
    expect(a.stems.get('A:vocals')!.ducked).toBe(true);
    expect(a.stems.get('A:drums')!.ducked).toBe(false);
  });

  it('reports the playing deck’s beat grid as the transport', () => {
    const e = new FakeEngine();
    const now = Date.now();
    // 120 BPM, first beat at 0.25 s, currently at 10.25 s = exactly beat 20.
    e.state.decks.A = separated('A', { playing: true, bpm: 120, firstBeatSec: 0.25, positionSec: 10.25, positionAt: now });
    const a = new Task1Adapter(e);
    expect(a.transport.bpm).toBe(120);
    expect(beatAt(a.transport, now)!).toBeCloseTo(20, 6);
    expect(beatAt(a.transport, now + 250)!).toBeCloseTo(20.5, 6);
  });

  it('parses ids', () => {
    expect(parseId('A:vocals')).toEqual({ deck: 'A', channel: 'vocals', clipId: undefined });
    expect(parseId('B:full~3')).toEqual({ deck: 'B', channel: 'full', clipId: 'B:full~3' });
    expect(parseId('drums')).toBeNull();
    expect(parseId('A:kazoo')).toBeNull();
  });
});
