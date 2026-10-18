import type { AudioStateSource } from '../audio/AudioCommands';
import { parseId } from '../bridge/task1Adapter';
import type { Point2 } from '../perception';
import { DECK_COLORS, STEM_COLORS, STEM_LABELS } from '../decks/theme';
import type { ChannelKey, DeckId } from '../shared/types';
import { createHoloObject, type CrossfadeZone, type HoloObjectInit, type Platter, type TempoStrip } from './HoloObject';
import type { InteractionController } from './InteractionController';

/**
 * Deck-aware layout for the shared two-deck engine, mirroring the decks
 * screen (Monitor 1): each deck's stems are fader bars standing on the
 * bottom edge, side by side, in the same order and colors as its stem
 * faders. Deck A on the left, deck B on the right, center left clear for you.
 */

const CHANNEL_ORDER: ChannelKey[] = ['vocals', 'drums', 'bass', 'instrumental', 'full'];
const EDGE_MARGIN = 0.04;
/** Fader tracks stand on the bottom edge: size, spacing and bottom margin, view-height units. */
const BAR_HALF = { x: 0.036, y: 0.26 };
const FULL_HALF = { x: 0.048, y: 0.26 };
const BAR_PITCH = 0.21;
/** Gap between deck A's bars and deck B's, at the middle of the screen (view-height units). */
const CENTER_GAP = 0.2;
/** Spacing the records and crossfader are laid out on (each deck's space at its side; wider than the bars). */
const DECK_PITCH = 0.165;
const BOTTOM_MARGIN = 0.035;

/** Colors shared with the decks screen: stems keep one color everywhere; a full mix takes its deck's color. */
export function channelColor(deck: DeckId, channel: ChannelKey): string {
  return channel === 'full' ? DECK_COLORS[deck] : STEM_COLORS[channel];
}

/** Width (view-height units) the full layout needs: two decks of four bars and a gap for the crossfader. */
const LAYOUT_WIDTH = 2 * (EDGE_MARGIN + 4 * DECK_PITCH) + 0.25;

/** Shrinks bars, records and spacing sideways on narrow (e.g. portrait) frames so both decks fit. */
export function layoutScale(aspect: number): number {
  return Math.min(1, aspect / LAYOUT_WIDTH);
}

/**
 * Where a deck channel's bar stands: each deck's bars together near the middle of the screen
 * (A just left of it, B just right, mirrored, a small gap between), away from the tempo lines
 * at the edges. Bars run left to right in the decks screen's order on both sides.
 */
export function deckSlot(aspect: number, deck: DeckId, index: number, count: number): { position: Point2; halfSize: Point2 } {
  const k = layoutScale(aspect);
  const half = count > 1 ? BAR_HALF : FULL_HALF;
  // Each deck's bars span at most 40% of the frame's width from the middle (clear of the edges).
  const spread = Math.min(k, (0.4 * aspect) / (CENTER_GAP / 2 + 4 * BAR_PITCH));
  const fromCenter = spread * (CENTER_GAP / 2 + BAR_PITCH / 2 + (deck === 'A' ? count - 1 - index : index) * BAR_PITCH);
  const x = deck === 'A' ? 0.5 - fromCenter / aspect : 0.5 + fromCenter / aspect;
  return { position: { x, y: 1 - BOTTOM_MARGIN - half.y }, halfSize: { x: half.x * k, y: half.y } };
}

/** Label shown on a deck channel: `A · VOCALS`, or the song title for a full mix. */
export function channelLabel(deck: DeckId, channel: ChannelKey, title?: string | null): string {
  const name = channel === 'full' ? (title ? truncate(title, 14) : 'Song') : STEM_LABELS[channel];
  return `${deck} · ${name}`;
}

/** Record size and height, view-height units / view space. */
const PLATTER_RADIUS = 0.085;
const PLATTER_Y = 0.2;

/** The record above a deck's bars. Just a picture: an open palm anywhere on that side scratches it. */
export function deckPlatter(aspect: number, deck: DeckId, barCount: number): Platter {
  const k = layoutScale(aspect);
  const fromEdge = k * (EDGE_MARGIN + (Math.max(1, barCount) * DECK_PITCH) / 2);
  const x = deck === 'A' ? fromEdge / aspect : 1 - fromEdge / aspect;
  const radius = PLATTER_RADIUS * Math.max(0.7, k);
  return { deck, position: { x, y: PLATTER_Y }, radius, color: DECK_COLORS[deck], hover: 0, hand: null, offsetSec: 0 };
}

/** The open-palm crossfader zone: the space between the two decks' bars. */
export function crossfadeZone(aspect: number): CrossfadeZone {
  const x0 = (layoutScale(aspect) * (EDGE_MARGIN + 4 * DECK_PITCH) + 0.02) / aspect;
  return { x0, x1: 1 - x0, y0: 0.35, y1: 1, arming: 0, hand: null };
}

/** Keep one record per loaded deck (same objects while loaded, so a scratch in progress isn't lost). */
export function syncPlatters(engine: AudioStateSource, interaction: InteractionController, aspect: number): void {
  const ids = [...engine.stems.entries()].filter(([, s]) => !s.clipOf).map(([id]) => id);
  const next: Platter[] = [];
  for (const deck of ['A', 'B'] as DeckId[]) {
    const count = sortedChannels(ids, deck).length;
    if (count === 0) continue;
    const existing = interaction.platters.find((p) => p.deck === deck);
    const fresh = deckPlatter(aspect, deck, count);
    if (existing) {
      existing.position = fresh.position;
      existing.radius = fresh.radius;
      next.push(existing);
    } else next.push(fresh);
  }
  interaction.platters = next;
  // Each deck's tempo is a line at its screen edge (left = A, right = B), where the decks
  // screen's tempo fader has it.
  interaction.tempoStrips = next.map((pl) => {
    const existing = interaction.tempoStrips.find((s) => s.deck === pl.deck);
    if (existing) return existing;
    return { deck: pl.deck, position: { x: pl.deck === 'A' ? 0 : 1, y: 0.5 }, color: pl.color, hover: 0, hand: null, value: null } satisfies TempoStrip;
  });
}

/** Default positions of every deck channel currently shown, for "reset layout". */
export function deckPositions(aspect: number, ids: string[]): Map<string, Point2> {
  const out = new Map<string, Point2>();
  for (const deck of ['A', 'B'] as DeckId[]) {
    const chans = sortedChannels(ids, deck);
    chans.forEach((ch, i) => out.set(`${deck}:${ch}`, deckSlot(aspect, deck, i, chans.length).position));
  }
  return out;
}

/**
 * Keep deck-channel holograms in step with the engine: create one when a
 * track loads, remove them when it unloads (or switches between full mix and
 * stems), and keep full-mix labels showing the current song. Clips are
 * handled by syncClips.
 */
/**
 * Stem fader bars on the spatial screen (small, dim until a hand is near, each deck's bars
 * close together near the middle). Set false to hide them: records, tempo, crossfader,
 * scratch and build/drop don't need them.
 */
export const SHOW_STEM_BARS = true;

export function syncDeckStems(
  engine: AudioStateSource,
  interaction: InteractionController,
  aspect: number,
  titleOf: (deck: DeckId) => string | null,
): void {
  if (!SHOW_STEM_BARS) {
    for (const obj of [...interaction.objects]) if (!obj.clipOf) interaction.removeObject(obj.id);
    return;
  }
  const ids = [...engine.stems.entries()].filter(([, s]) => !s.clipOf).map(([id]) => id);
  for (const obj of [...interaction.objects]) {
    if (!obj.clipOf && !ids.includes(obj.id)) interaction.removeObject(obj.id);
  }
  for (const deck of ['A', 'B'] as DeckId[]) {
    const chans = sortedChannels(ids, deck);
    chans.forEach((ch, i) => {
      const id = `${deck}:${ch}`;
      const existing = interaction.objects.find((o) => o.id === id);
      const label = channelLabel(deck, ch, titleOf(deck));
      const slot = deckSlot(aspect, deck, i, chans.length);
      if (existing) {
        // Bars never move by hand, so keep them on their slot (the frame may have changed shape).
        existing.label = label;
        existing.position = slot.position;
        existing.halfSize = slot.halfSize;
        return;
      }
      const init: HoloObjectInit = { id, label, color: channelColor(deck, ch), ...slot };
      const obj = createHoloObject(init);
      // Deck stems stand in place like the decks screen's faders: grab + move up/down = volume.
      obj.locked = true;
      obj.vertical = true;
      interaction.addObject(obj);
    });
  }
}

function sortedChannels(ids: string[], deck: DeckId): ChannelKey[] {
  return ids
    .map((id) => parseId(id))
    .filter((t): t is NonNullable<typeof t> => !!t && t.deck === deck && !t.clipId)
    .map((t) => t.channel)
    .sort((a, b) => CHANNEL_ORDER.indexOf(a) - CHANNEL_ORDER.indexOf(b));
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
