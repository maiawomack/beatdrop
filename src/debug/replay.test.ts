import { describe, it } from 'vitest';
import { createHoloObject, stemView } from '../ar/HoloObject';
import { InteractionController, type InteractionEvent } from '../ar/InteractionController';
import { defaultStemLayout } from '../ar/layout';
import { MockAudioEngine } from '../audio/MockAudioEngine';
import { createStemAudioBridge } from '../bridge/stemAudioBridge';
import type { GrabGesture, PerceptionFrame } from '../perception';

/**
 * Replays a recording from the D-key debug recorder through the current
 * InteractionController and prints the events it produces, next to the
 * events that were recorded live:
 *
 *   REPLAY=~/Downloads/beatdrop-recording-....json npx vitest run src/debug/replay.test.ts
 */
// Node globals, declared locally so the browser tsconfig needs no @types/node.
declare const process: { env: Record<string, string | undefined>; getBuiltinModule(id: 'fs'): { readFileSync(p: string, enc: 'utf8'): string } };
const file = process.env.REPLAY;

describe.skipIf(!file)('replay recording', () => {
  it('prints live vs replayed events', () => {
    const rec = JSON.parse(process.getBuiltinModule('fs').readFileSync(file!, 'utf8'));
    const aspect: number = rec.meta.aspect;
    const first = rec.frames[0].stems as { id: string; position: { x: number; y: number }; stretchAmount: number; volume: number }[];

    const engine = new MockAudioEngine(first.map((s) => s.id));
    for (const s of first) {
      engine.dispatch({ type: 'setFx', stemId: s.id, value: s.stretchAmount });
      engine.dispatch({ type: 'setVolume', stemId: s.id, value: s.volume });
    }
    const stems = defaultStemLayout(aspect).map(createHoloObject);
    for (const obj of stems) {
      const s = first.find((f) => f.id === obj.id);
      if (s) obj.position = { ...s.position };
    }

    const events: string[] = [];
    const bridge = createStemAudioBridge(engine);
    const controller = new InteractionController(
      stems,
      aspect,
      (e: InteractionEvent) => {
        if (e.type !== 'move') events.push(`${e.type} ${'object' in e ? e.object.id : 'core'}${'hand' in e ? ` ${e.hand}` : ''}`);
        bridge(e);
      },
      rec.meta.gesture as GrabGesture,
    );

    const t0 = rec.frames[0].frame.timestamp;
    for (const f of rec.frames) {
      for (const obj of stems) {
        const s = engine.stems.get(obj.id)!;
        obj.audio = stemView(s);
        if (!obj.stretch) obj.stretchAmount = s.fx;
      }
      events.length = 0;
      controller.update(f.frame as PerceptionFrame);
      const live = (f.events as { type: string; stem: string; hand?: string }[])
        .filter((e) => e.type !== 'move' && e.type !== 'level')
        .map((e) => `${e.type} ${e.stem}${e.hand ? ` ${e.hand}` : ''}`);
      const now = events.filter((e) => !e.startsWith('level '));
      if (live.length || now.length) {
        const ms = (f.frame.timestamp - t0).toFixed(0).padStart(6);
        console.log(`${ms}ms  live: ${live.join(', ').padEnd(40)} replay: ${now.join(', ')}`);
      }
    }
    console.log('final', [...engine.stems].map(([id, s]) => `${id} vol ${s.volume.toFixed(2)} fx ${s.fx.toFixed(2)}`).join(' | '));
  });
});
