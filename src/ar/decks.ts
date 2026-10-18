import type { AudioStateSource } from '../audio/AudioCommands';
import { parseId } from '../bridge/task1Adapter';
import type { Point2 } from '../perception';
import type { ChannelKey, DeckId } from '../shared/types';
import { CAP_ROOM, createHoloObject, type HoloObjectInit } from './HoloObject';
import type { InteractionController } from './InteractionController';

/**
 * Deck-aware layout for the shared two-deck engine: deck A's channels in a
 * column on the left, deck B's on the right, center left clear for you.
 * Each deck has its own color family so A's vocals and B's vocals never look alike.
 */

const CHANNEL_ORDER: ChannelKey[] = ['vocals', 'drums', 'bass', 'instrumental', 'full'];
const LABELS: Record<ChannelKey, string> = {
  vocals: 'Vocals',
  drums: 'Drums',
  bass: 'Bass',
  instrumental: 'Music',
  full: 'Song',
};
const COLORS: Record<DeckId, Record<ChannelKey, string>> = {
  A: { vocals: '#b47cff', drums: '#ff5e62', bass: '#2ee6ff', instrumental: '#ffc857', full: '#8fa8ff' },
  B: { vocals: '#ff7ad9', drums: '#ff9f43', bass: '#3dffa8', instrumental: '#fff36b', full: '#ffb3e6' },
};
const EDGE_MARGIN = 0.04;

/** Where a deck channel sits by default. */
export function deckSlot(aspect: number, deck: DeckId, index: number, count: number): { position: Point2; halfSize: Point2 } {
  const halfW = Math.min(0.18, 0.12 * aspect);
  const halfH = count > 1 ? 0.045 : 0.065;
  const sideX = (EDGE_MARGIN + halfW + CAP_ROOM) / aspect;
  const x = deck === 'A' ? sideX : 1 - sideX;
  const y = count === 1 ? 0.45 : 0.2 + (0.6 * index) / (count - 1);
  return { position: { x, y }, halfSize: { x: halfW, y: halfH } };
}

/** Label shown on a deck channel: `A · VOCALS`, or the song title for a full mix. */
export function channelLabel(deck: DeckId, channel: ChannelKey, title?: string | null): string {
  const name = channel === 'full' && title ? truncate(title, 22) : LABELS[channel];
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
      const init: HoloObjectInit = { id, label, color: COLORS[deck][ch], ...slot };
      interaction.addObject(createHoloObject(init));
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
