import { MockAudioEngine } from '../audio/MockAudioEngine';
import { createStemAudioBridge } from '../bridge/stemAudioBridge';
import type { GesturePhase, GestureState, HandId, HandState, PerceptionFrame, Point2 } from '../perception';
import { syncClips } from './clips';
import { createHoloObject, stemView, type HoloObject } from './HoloObject';
import { InteractionController, type InteractionEvent } from './InteractionController';
import { defaultStemLayout } from './layout';

/** Test support: synthetic hands and a controller wired to a mock engine, like main.ts. */

export const ASPECT = 16 / 9;
export const FRAME_MS = 33;

export function gesture(phase: GesturePhase, point: Point2): GestureState {
  const active = phase === 'start' || phase === 'held';
  return { phase, active, point, ratio: active ? 0.2 : 1, strength: active ? 1 : 0 };
}

export function hand(id: HandId, point: Point2, phase: GesturePhase, tracked = true): HandState {
  const g = gesture(phase, point);
  return { id, tracked, confidence: 1, landmarks: [], anchor: point, pinch: g, grip: gesture('idle', point), grab: g };
}

/** A hand in the lift pose (fingertips bunched, pointing down); its grab gesture stays idle. */
export function liftHand(id: HandId, point: Point2, phase: GesturePhase, tracked = true): HandState {
  return { ...hand(id, point, 'idle', tracked), lift: gesture(phase, point) };
}

export class Rig {
  t = 1000;
  engine = new MockAudioEngine(['drums', 'vocals', 'bass']);
  stems: HoloObject[] = defaultStemLayout(ASPECT).map(createHoloObject);
  events: InteractionEvent[] = [];
  controller: InteractionController;

  constructor() {
    const bridge = createStemAudioBridge(this.engine);
    this.controller = new InteractionController(
      this.stems,
      ASPECT,
      (e) => {
        if (e.type !== 'move') this.events.push(e);
        bridge(e);
      },
      'grab',
    );
  }

  stem(id: string): HoloObject {
    return this.stems.find((s) => s.id === id)!;
  }

  frame(...hands: HandState[]): void {
    syncClips(this.engine, this.controller);
    for (const obj of this.stems) {
      const s = this.engine.stems.get(obj.id);
      if (!s) continue;
      obj.audio = stemView(s);
      if (!obj.stretch) obj.stretchAmount = s.fx;
    }
    this.controller.perfView = { dropPending: this.engine.perf.dropPending, crossfader: this.engine.perf.crossfader, tempo: this.engine.perf.tempo };
    const frame: PerceptionFrame = { timestamp: this.t, hands };
    this.controller.update(frame);
    this.t += FRAME_MS;
  }

  /** Hover, grab, optionally drag along a path, and release. */
  pinchDrag(id: HandId, path: Point2[], hoverFrames = 4): void {
    for (let i = 0; i < hoverFrames; i++) this.frame(hand(id, path[0], 'idle'));
    this.frame(hand(id, path[0], 'start'));
    for (const p of path) this.frame(hand(id, p, 'held'));
    const last = path[path.length - 1];
    this.frame(hand(id, last, 'end'));
  }

  commands(type: string) {
    return this.engine.log.filter((c) => c.type === type);
  }

  eventsOf<T extends InteractionEvent['type']>(type: T): Extract<InteractionEvent, { type: T }>[] {
    return this.events.filter((e) => e.type === type) as Extract<InteractionEvent, { type: T }>[];
  }
}
