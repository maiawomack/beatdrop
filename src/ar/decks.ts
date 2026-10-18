import type { AudioStateSource } from '../audio/AudioCommands';
import { parseId } from '../bridge/task1Adapter';
import type { Point2 } from '../perception';
import { DECK_COLORS, STEM_COLORS, STEM_LABELS } from '../decks/theme';
import type { ChannelKey, DeckId } from '../shared/types';
import { createHoloObject, type HoloObjectInit } from './HoloObject';
import type { InteractionController } from './InteractionController';

/**
 * Deck-aware layout for the shared two-deck engine, mirroring the decks
 * screen (Monitor 1): each deck's stems stand as vertical bars side by side,
 * in the same order and the same colors as its stem faders. Deck A on the
 * left, deck B on the right, center left clear for you.
 */

const CHANNEL_ORDER: ChannelKey[] = ['vocals', 'drums', 'bass', 'instrumental', 'full'];
const EDGE_MARGIN = 0.04;
/** Bar size and spacing, view-height units. */
const BAR_HALF = { x: 0.05, y: 0.16 };
const FULL_HALF = { x: 0.06, y: 0.19 };
const BAR_PITCH = 0.135;
const BARS_Y = 0.52;

/** Colors shared with the decks screen: stems keep one color everywhere; a full mix takes its deck's color. */
export function channelColor(deck: DeckId, channel: ChannelKey): string {
  return channel === 'full' ? DECK_COLORS[deck] : STEM_COLORS[channel];
}

/** Where a deck channel's bar stands. Bars run left to right in the decks screen's order on both sides. */
export function deckSlot(aspect: number, deck: DeckId, index: number, count: number): { position: Point2; halfSize: Point2 } {
  const half = count > 1 ? BAR_HALF : FULL_HALF;
  const fromEdge = EDGE_MARGIN + BAR_PITCH / 2 + (deck === 'A' ? index : count - 1 - index) * BAR_PITCH;
  const x = deck === 'A' ? fromEdge / aspect : 1 - fromEdge / aspect;
  return { position: { x, y: BARS_Y }, halfSize: { ...half } };
}

/** Label shown on a deck channel: `A · VOCALS`, or the song title for a full mix. */
export function channelLabel(deck: DeckId, channel: ChannelKey, title?: string | null): string {
  const name = channel === 'full' ? (title ? truncate(title, 14) : 'Song') : STEM_LABELS[channel];
  return `${deck} · ${name}`;
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
export function syncDeckStems(
  engine: AudioStateSource,
  interaction: InteractionController,
  aspect: number,
  titleOf: (deck: DeckId) => string | null,
): void {
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
      if (existing) {
        existing.label = label;
        return;
      }
      const slot = deckSlot(aspect, deck, i, chans.length);
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
