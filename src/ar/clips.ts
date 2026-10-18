import type { AudioStateSource } from '../audio/AudioCommands';
import type { Point2 } from '../perception';
import { CLIP_HALF_SIZE, createHoloObject, type HoloObject } from './HoloObject';
import type { InteractionController } from './InteractionController';

/**
 * Keeps loop-clip holograms in step with the engine, which is authoritative:
 * a clip appears when the engine reports it (wherever it was pulled out, or
 * next to its source if another window created it) and disappears when the
 * engine removes it. Call once per frame before the interaction update.
 */
export function syncClips(engine: AudioStateSource, interaction: InteractionController): void {
  for (const [id, s] of engine.stems) {
    if (!s.clipOf || interaction.objects.some((o) => o.id === id)) continue;
    const source = interaction.objects.find((o) => o.id === s.clipOf);
    if (!source) continue;
    const at: Point2 = interaction.takeClipSpawn(id) ?? { x: 0.5, y: source.position.y };
    const clip = createHoloObject({
      id,
      label: `${source.label} ⟲${s.loop?.beats ?? ''}`,
      color: source.color,
      position: at,
      halfSize: { ...CLIP_HALF_SIZE },
    });
    clip.clipOf = source.id;
    interaction.addObject(clip);
  }
  for (const obj of [...interaction.objects]) {
    if (obj.clipOf && !engine.stems.has(obj.id)) interaction.removeObject(obj.id);
  }
}

/** Objects that are loop clips of `sourceId`. */
export function clipsOf(objects: readonly HoloObject[], sourceId: string): HoloObject[] {
  return objects.filter((o) => o.clipOf === sourceId);
}
