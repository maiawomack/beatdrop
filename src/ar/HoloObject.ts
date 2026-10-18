import type { LoopBeats, LoopState, StemState } from '../audio/AudioCommands';
import type { HandId, Point2 } from '../perception';

/**
 * Extra width (view-height units) a fully stretched object gains visually.
 * Equal to STRETCH_GESTURE_SPAN so the stem's ends follow the hands 1:1
 * while stretching. Neighbours are pushed aside (no overlaps), and grabs need
 * the hand on the object, so a wide stem doesn't swallow other grabs.
 */
export const FULL_STRETCH_SPAN = 0.55;

/** How far (view-height units) the hands must spread to sweep FX from 0 to 1. */
export const STRETCH_GESTURE_SPAN = 0.55;

/** Set while an object is actively held by two hands and being stretched. */
export interface StretchState {
  /** The two hand grab points, view space. */
  ends: [Point2, Point2];
}

/**
 * Read-only mirror of the stem's authoritative audio state, refreshed from
 * the engine every frame. The spatial layer reads it for visuals and for
 * relative adjustments, but only ever changes audio by dispatching commands.
 */
export interface StemView {
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  audible: boolean;
  fx: number;
  /** DJ filter, -1 (lowpass) .. 0 .. 1 (highpass). */
  filter: number;
  loop: LoopState | null;
  /** Silenced because a loop clip was pulled out of it. */
  ducked: boolean;
}

/** Per-stem performance controls on the stem's end caps. */
export type StemControl = 'loop' | 'filter';

/** A draggable holographic object positioned in view space. */
export interface HoloObject {
  id: string;
  label: string;
  /** Center, view space [0, 1]. Spatial layout only: never mapped to audio. */
  position: Point2;
  /**
   * Half width / half height of the visual body, in view-HEIGHT units
   * (so x is not stretched by aspect). The hitbox is larger; see
   * InteractionController.
   */
  halfSize: Point2;
  color: string;
  /** Hands currently holding the body (0, 1 or 2). */
  holders: HandId[];
  /** Grab point of each holder (parallel to `holders`), view space. */
  holdPoints: Point2[];
  /** Hand currently dragging the level handle, if any. */
  levelHand: HandId | null;
  /** Non-null only while two hands are actively stretching it. */
  stretch: StretchState | null;
  /** 0..1 persistent stretch amount; stays after the hands let go. Drives FX. */
  stretchAmount: number;
  /** 0..1 proximity of the nearest free hand (1 = targeted by a hand). */
  hover: number;
  /** 0..1 a free hand is over the level handle. */
  handleHover: number;
  /** 0..1 how far the targeting hand has closed toward a grab. For anticipation visuals. */
  intent: number;
  /**
   * Visual-only displacement from `position` (view space), driven by nearby
   * hand motion. Rendering uses position + drift; hit tests use `position`.
   */
  drift: Point2;
  audio: StemView;
  /**
   * Cap control currently held, and by which hand. While set, the stem is
   * locked in place (no body grabs) so control and movement never mix.
   */
  control: { kind: StemControl; hand: HandId } | null;
  /** 0..1 a free hand is over the loop cap / filter cap. */
  capHover: { loop: number; filter: number };
  /** Loop length being chosen while the loop cap is held (undefined = not selecting). */
  loopPreview: LoopBeats | null | undefined;
  /** While a loop is being pulled out of this stem: where the new clip would land (view space). */
  clipPreview: Point2 | null;
  /** For a loop clip: the stem it came from (and returns to). Null for real stems. */
  clipOf: string | null;
  /** A clip on its way back into its source (waiting for the engine to remove it). */
  returning: boolean;
  /** While a holding hand twists the filter: the filter value it's asking for. */
  twist: number | null;
}

/**
 * Volume faders next to each stem. Off for now (2026-10-17, Ruhi: simplify
 * the spatial view); flip to true to bring them back.
 */
export const LEVEL_HANDLE_ENABLED = false; // NOTE: would overlap the filter cap if re-enabled

/** Cap geometry, view-height units: centers sit just outside each end of the body. */
export const CAP_RADIUS = 0.037;
export const CAP_GAP = 0.05;
/** Room each cap adds beyond the body, for layout and separation. */
export const CAP_ROOM = CAP_GAP + CAP_RADIUS + 0.005;

/** Loop clips are smaller than stems. */
export const CLIP_HALF_SIZE = { x: 0.11, y: 0.045 };

/** Which caps an object has: clips always loop, so they only get a filter cap. */
export function hasCap(obj: HoloObject, kind: StemControl): boolean {
  return kind === 'filter' || obj.clipOf === null;
}

/** Center offset (view-height units, from the stem center) of a cap. Loop = left end, filter = right end. */
export function capOffset(obj: HoloObject, kind: StemControl): number {
  const d = effectiveHalfWidth(obj) + CAP_GAP;
  return kind === 'loop' ? -d : d;
}


/** Half width including persistent stretch, view-height units. */
export function effectiveHalfWidth(obj: HoloObject): number {
  return obj.halfSize.x + (obj.stretchAmount * FULL_STRETCH_SPAN) / 2;
}

/**
 * Level handle geometry: a vertical fader just right of the body, in
 * view-height units relative to the object's center. Shared by hit testing
 * and rendering so they always agree.
 */
export function levelHandle(obj: HoloObject): { dx: number; halfLength: number; knobDy: number } {
  const halfLength = obj.halfSize.y * 1.5;
  return {
    dx: effectiveHalfWidth(obj) + obj.halfSize.y * 0.55,
    halfLength,
    // volume 1 at the top, 0 at the bottom
    knobDy: halfLength * (1 - 2 * obj.audio.volume),
  };
}

export type HoloObjectInit = Pick<HoloObject, 'id' | 'label' | 'position' | 'halfSize' | 'color'>;

export function createHoloObject(init: HoloObjectInit): HoloObject {
  return {
    ...init,
    position: { ...init.position },
    halfSize: { ...init.halfSize },
    holders: [],
    holdPoints: [],
    levelHand: null,
    stretch: null,
    stretchAmount: 0,
    hover: 0,
    handleHover: 0,
    intent: 0,
    drift: { x: 0, y: 0 },
    audio: { volume: 1, pan: 0, muted: false, solo: false, audible: true, fx: 0, filter: 0, loop: null, ducked: false },
    control: null,
    capHover: { loop: 0, filter: 0 },
    loopPreview: undefined,
    clipPreview: null,
    clipOf: null,
    returning: false,
    twist: null,
  };
}

/** The spatial mirror of one stem's authoritative engine state. */
export function stemView(s: Readonly<StemState>): StemView {
  return {
    volume: s.volume,
    pan: s.pan,
    muted: s.muted,
    solo: s.solo,
    audible: s.audible,
    fx: s.fx,
    filter: s.filter,
    loop: s.loop ? { ...s.loop } : null,
    ducked: s.ducked,
  };
}
