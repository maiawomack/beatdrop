import type { LoopBeats } from '../audio/AudioCommands';
import type { GrabGesture, HandId, HandState, PerceptionFrame, Point2 } from '../perception';
import {
  CAP_GAP,
  CAP_RADIUS,
  capCenter,
  capOffset,
  effectiveHalfHeight,
  effectiveHalfWidth,
  hasCap,
  LEVEL_HANDLE_ENABLED,
  levelHandle,
  STRETCH_GESTURE_SPAN,
  type CrossfadeZone,
  type HoloObject,
  type Platter,
  type StemControl,
  type TempoStrip,
} from './HoloObject';

/**
 * Invisible hitbox padding around the visual body, in view-height units.
 * Waveforms are thin, so the vertical padding is especially generous.
 */
const HIT_PAD = { x: 0.07, y: 0.11 };
/** Standing bars sit side by side, so their padding is much tighter sideways. */
const BAR_HIT_PAD = { x: 0.025, y: 0.04 };
/** Level handle hit area: half width and extra length beyond the track ends. */
const HANDLE_HIT = { halfWidth: 0.04, pad: 0.03 };
/** Vertical hand travel (view-height units) that sweeps the fader 0 → 1. */
export const LEVEL_TRAVEL = 0.4;
/** Hand jitter (view-height units) ignored before the fader starts moving. */
export const LEVEL_DEADZONE = 0.02;
// --- Open-palm controls -------------------------------------------------------
/**
 * An open palm facing the camera must be held still this long before it takes a record (ms),
 * so hands passing by, reaching for a drink or opening after a drop don't scratch.
 */
export const SCRATCH_ARM_MS = 450;
/** While arming, the palm must stay within this distance of where it started (view-height units). */
export const SCRATCH_ARM_STILL = 0.05;
/** No palm scratch this soon after the hand's lift pose or a drop (ms): opening the hand to drop isn't a scratch. */
export const SCRATCH_AFTER_LIFT_MS = 1200;
/** Extra reach around a record for the palm or pinch (view-height units). */
const PLATTER_PAD = 0.06;
/** A pinch this close to a fader bar's fill line (above / below, view-height units) grabs it. */
export const FADER_GRAB_ABOVE = 0.1;
export const FADER_GRAB_BELOW = 0.12;
const FADER_GRAB_PAD_X = 0.03;
/** Moving the palm this far off the record lets go (× radius). */
const PLATTER_LEAVE = 2.2;
/**
 * Scratching follows how far the hand turns the record around its center,
 * like a real deck: one full turn = one revolution at 33⅓ rpm (1.8 s of audio),
 * clockwise (as you see it) = forward.
 */
export const RECORD_TURNS_PER_SEC = 33.333 / 60;
/**
 * Away from a record, the hand turns an invisible record whose center is this
 * far below where the hand started (view-height units), so an arc back and
 * forth over its top edge (or plain side-to-side) scratches.
 */
export const SCRATCH_VIRTUAL_RADIUS = 0.15;
/** Seconds of audio per view-height of sideways movement at the top of the invisible record (small moves). */
export const SCRATCH_SEC_PER_UNIT = 1 / (SCRATCH_VIRTUAL_RADIUS * 2 * Math.PI * RECORD_TURNS_PER_SEC);
/** Tempo strip: pinch within this reach (view-height units) of it; dragging TEMPO_TRAVEL changes the tempo by TEMPO_RANGE. */
const TEMPO_REACH = { x: 0.045, y: 0.03 };
export const TEMPO_TRAVEL = 0.3;
export const TEMPO_RANGE = 0.16;
/** Tempo within this of normal snaps to exactly ×1.00. */
const TEMPO_DETENT = 0.005;
/** A pinch held this long (without closing into a fist) takes what's under it. */
export const PINCH_ARM_MS = 150;
/** Two fingers up held this long takes the crossfader. */
export const TWO_UP_ARM_MS = 120;
/** Sideways palm travel (view-height units) that sweeps the crossfader from A all the way to B. */
export const FADE_TRAVEL = 0.5;
const FADE_MAX_RATE = 4;

/** Max volume change per second on a locked stem, so a tracking glitch can't jump the level. */
export const VOLUME_MAX_RATE = 3;
/** Fader bars: smaller dead zone, since the bar's top tracks the hand 1:1. */
export const BAR_DEADZONE = 0.01;
/** A targeted object stays targeted until the hand is this far outside its hitbox (hover hysteresis). */
const TARGET_EXIT = 0.05;
/** A second hand may join a held stem (to stretch it) from this much further out. */
const STRETCH_JOIN_REACH = 0.1;
/** After a grab gesture starts, keep trying to grab for this long (ms). */
const GRAB_WINDOW_MS = 300;
/** At grab time the hand's current point may be at most this far outside the hitbox. */
const GRAB_REACH = 0.03;
/** Above this gesture strength the fingers are closing, so targeting uses the pre-closing aim. */
const CLOSING_STRENGTH = 0.35;
/** Hover glow ramps up over this distance outside the hitbox. */
const HOVER_FALLOFF = 0.1;
/**
 * Closing your fingers moves the aim point ("Heisenberg effect"). Aim with
 * where the hand was this long before the grab registered, and on release put
 * the object back where it was this long before the fingers opened.
 */
const AIM_LOOKBACK_MS = 80;
const RELEASE_LOOKBACK_MS = 90;
const HISTORY_MS = 250;
/** A grab released this quickly, having moved less than TAP_MOVE, is a tap (toggles mute). */
const TAP_MS = 280;
const TAP_MOVE = 0.02;
/** Reset-layout easing rate (1/s). */
const RESET_RATE = 9;
/** Extra hand spread (view-height units) that sweeps isolation from 0 to 1. */
export const BLEND_SPAN = 0.45;
/** Minimum gap kept between stems' footprints (view-height units). */
const STEM_GAP = 0.02;
/** How quickly overlapping stems slide apart (1/s). Soft so pushes glide. */
const SEPARATE_RATE = 18;
/** Release faster than this (view-height units/s) to flick a stem. */
const FLICK_MIN_SPEED = 0.6;
const FLICK_MAX_SPEED = 3;
/** Flick friction (1/s): higher stops sooner. */
const FLICK_FRICTION = 4.5;
/** Fraction of speed kept when a flicked stem bounces off an edge or stem. */
const BOUNCE = 0.45;

// --- Performance controls ------------------------------------------------------
/** Cap hit radius (view-height units), a bit larger than the visual cap. */
const CAP_HIT = 0.055;
/** Vertical travel per loop-length step while holding the loop cap (view-height units). */
export const LOOP_STEP = 0.06;
export const LOOP_OPTIONS: readonly (LoopBeats | null)[] = [null, 1, 2, 4, 8];
/** A tap on the loop cap toggles a loop of this length. */
export const TAP_LOOP_BEATS: LoopBeats = 4;
/** Vertical travel (view-height units) from neutral to a fully closed / open filter. */
export const FILTER_TRAVEL = 0.3;
const FILTER_DEADZONE = 0.02;
/** Filter values this close to 0 snap to off, so neutral is easy to find. */
const FILTER_DETENT = 0.06;
/** Max filter change per second, so a tracking glitch can't slam the filter. */
export const FILTER_MAX_RATE = 4;
/**
 * Vertical travel (view-height units) above where the lift pose started for a full build:
 * a long pull. Starting high, it shortens (to BUILD_TRAVEL_MIN at least) so the top of
 * the build stays reachable inside the frame.
 */
export const BUILD_TRAVEL = 0.55;
export const BUILD_TRAVEL_MIN = 0.25;
/** Below this the lift pose is armed but not building yet; from here, letting go drops. */
export const BUILD_MIN = 0.25;
/** Build rate limits (1/s): rises quickly, falls slowly so dipping the hand before letting go keeps the build. */
const BUILD_RISE_RATE = 4;
const BUILD_FALL_RATE = 0.9;
/** Letting go of the lift pose with at least this much build drops (below it, it cancels). */
export const RELEASE_DROP_MIN = BUILD_MIN;
/** A build hand lost above this line (view y) went out the top of the frame: that cancels, never drops. */
const BUILD_TOP_EDGE = 0.08;
/** Full build is reachable this far below the top of the frame (view y). */
const BUILD_TOP_REACH = 0.12;
/** Minimum time between drops (ms). */
export const DROP_COOLDOWN_MS = 1500;
/** Drag the loop cap this far sideways (view-height units) to pull a loop clip out of the stem. */
export const CLIP_PULL_DIST = 0.14;
/** Bring it back within this distance to cancel the pull (loop in place instead). */
const CLIP_UNPULL_DIST = 0.08;
/** Clip length when pulled out with the length ladder at OFF. */
export const DEFAULT_CLIP_BEATS: LoopBeats = 4;
/**
 * Twist-to-filter while holding a stem: hand rotation past TWIST_DEADZONE
 * (radians, ~17°) starts it; each further TWIST_RANGE (~52°) sweeps the
 * filter fully. Clockwise (as you see it) = highpass, counterclockwise = lowpass.
 */
export const TWIST_DEADZONE = 0.3;
export const TWIST_RANGE = 0.9;

/**
 * Per-hand interaction state (explicit state machine; see docs/spatial-interaction.md).
 * A hand is in exactly one state; each state owns at most one object or control.
 */
export type HandMode =
  | 'idle'
  | 'hover'
  | 'grabbing'
  | 'repositioning'
  | 'stretching'
  | 'blending'
  | 'loopSelecting'
  | 'filterControl'
  | 'volume'
  | 'scratching'
  | 'scratchArming'
  | 'tempo'
  | 'crossfading'
  | 'clipPulling'
  | 'buildArmed'
  | 'building'
  | 'dropPending'
  | 'trackingLost';

/** Live build gesture, for visuals. */
export interface BuildView {
  hand: HandId;
  /** Current build amount 0..1 (what the engine was asked for). */
  value: number;
  state: 'armed' | 'building' | 'dropped';
  /** Hand anchor where the lift pose started, and now (view space). */
  from: Point2;
  point: Point2;
  /** Height (view units) above `from` for a full build. */
  travel: number;
}

export type InteractionEvent =
  /** Body went from free to held (repositioning only; no audio meaning). */
  | { type: 'grab'; object: HoloObject; hand: HandId }
  /** Body went from held to free. */
  | { type: 'release'; object: HoloObject; hand: HandId }
  /** Quick pinch-and-release on the body without moving it. */
  | { type: 'tap'; object: HoloObject; hand: HandId }
  /** Second hand joined: object is now stretched between two hands. */
  | { type: 'stretchStart'; object: HoloObject; hand: HandId }
  /** One of two hands let go: back to single-hand drag. */
  | { type: 'stretchEnd'; object: HoloObject; hand: HandId }
  /** Held object moved or was re-stretched this frame. */
  | { type: 'move'; object: HoloObject }
  /** Level handle grabbed / dragged / released. `value` is the requested volume. */
  | { type: 'levelStart'; object: HoloObject; hand: HandId }
  | { type: 'level'; object: HoloObject; hand: HandId; value: number }
  | { type: 'levelEnd'; object: HoloObject; hand: HandId }
  /**
   * Two hands each hold a different stem ("blend pair"). `value` is the
   * isolation amount: 0 = full mix, 1 = only the pair is heard. Pull the
   * hands apart to isolate, bring them together to blend back into the mix.
   * `others` are the stems outside the pair (the ones that get ducked).
   */
  | { type: 'blendStart'; object: HoloObject; partner: HoloObject }
  | { type: 'blend'; object: HoloObject; partner: HoloObject; value: number; others: HoloObject[] }
  | { type: 'blendEnd'; object: HoloObject; partner: HoloObject }
  /** Loop cap: `loopSelect` previews a length while held (no audio); `loopCommit` asks for it. */
  | { type: 'loopSelect'; object: HoloObject; hand: HandId; beats: LoopBeats | null }
  | { type: 'loopCommit'; object: HoloObject; hand: HandId; beats: LoopBeats | null }
  | { type: 'loopCancel'; object: HoloObject; hand: HandId }
  /** Filter cap: requested filter value -1..1; release holds it, a tap resets it to 0. */
  | { type: 'filter'; object: HoloObject; hand: HandId; value: number }
  | { type: 'filterEnd'; object: HoloObject; hand: HandId }
  /**
   * Build gesture (master bus, no stem): the "lift" pose (fingertips bunched,
   * pointing down, like holding the beat by a string) builds as it rises;
   * letting go or pulling down drops. `drop` fires at most once per lift.
   */
  | { type: 'buildStart'; hand: HandId }
  | { type: 'build'; hand: HandId; value: number }
  | { type: 'drop'; hand: HandId; build: number }
  /** Lift ended. dropped = false means cancel: the build should fall back to 0. */
  | { type: 'buildEnd'; hand: HandId; dropped: boolean }
  /** Loop cap dragged out and released: pull a `beats` clip out of `object` as `clipId`, landing `at`. */
  | { type: 'clipCreate'; object: HoloObject; hand: HandId; clipId: string; beats: LoopBeats; at: Point2 }
  /** A clip was dropped or thrown back into its source stem. */
  | { type: 'clipReturn'; object: HoloObject; source: HoloObject }
  /** Open palm on a deck's record. `offsetSec` = how far the record has been moved (negative = back). */
  | { type: 'scratchStart'; deck: 'A' | 'B'; hand: HandId }
  | { type: 'scratch'; deck: 'A' | 'B'; hand: HandId; offsetSec: number }
  | { type: 'scratchEnd'; deck: 'A' | 'B'; hand: HandId }
  /** Open palm holding the crossfader. `value` -1 (A) .. 1 (B). */
  | { type: 'crossfadeStart'; hand: HandId }
  | { type: 'crossfade'; hand: HandId; value: number }
  | { type: 'crossfadeEnd'; hand: HandId }
  /** Pinched tempo strip: the deck's playback rate (1 = normal). */
  | { type: 'tempo'; deck: 'A' | 'B'; hand: HandId; rate: number };

interface Sample {
  t: number;
  p: Point2;
}

interface BodyGrab {
  kind: 'body';
  object: HoloObject;
  startT: number;
  startPos: Point2;
  /** Furthest the object travelled from startPos, view-height units. */
  maxTravel: number;
  /** Twist-to-filter: hand roll and filter value at grab; latched once past the dead zone. */
  rollStart: number | null;
  filterStart: number;
  filterValue: number;
  twisting: boolean;
  /** Locked stems: hand drag point at grab, and the volume control it drives. */
  startHand: Point2;
  startVolume: number;
  volumeValue: number;
  volumeActive: boolean;
}

interface LevelGrab {
  kind: 'level';
  object: HoloObject;
  startVolume: number;
  startY: number;
}

/** Loop or filter cap: relative vertical control from where the hand engaged. */
interface CapGrab {
  kind: StemControl;
  object: HoloObject;
  startT: number;
  startY: number;
  /** Filter: value at grab. Loop: index into LOOP_OPTIONS at grab. */
  start: number;
  /** Filter: current value. Loop: current index. */
  current: number;
  maxTravel: number;
  /** Loop cap: hand anchor at grab, and whether it has been dragged out into a clip. */
  startX: number;
  pulled: boolean;
}

interface BuildGrab {
  kind: 'build';
  startY: number;
  from: Point2;
  value: number;
  dropped: boolean;
  /** Travel for a full build from where this one started. */
  travel: number;
}

interface ScratchGrab {
  kind: 'scratch';
  platter: Platter;
  startX: number;
  /** Which hand shape holds the record (it lets go when that shape ends). */
  via: 'palm' | 'pinch';
  /** Center the hand turns the record around (view space). */
  center: Point2;
  /** Hand angle around the center last frame, and the total turned since the start (radians). */
  lastAngle: number;
  turned: number;
  /** Hand tilt last frame (wrist rocking, like a windshield wiper), if known. */
  lastRoll: number | null;
}

/** Pinch on a fader bar's top: drag up/down for volume. */
interface FaderGrab {
  kind: 'fader';
  object: HoloObject;
  startY: number;
  startVolume: number;
  value: number;
  active: boolean;
}

interface FadeGrab {
  kind: 'crossfade';
  startX: number;
  start: number;
  value: number;
}

/** Pinch on a deck's tempo strip: drag up/down for faster/slower. */
interface TempoGrab {
  kind: 'tempo';
  strip: TempoStrip;
  startT: number;
  startY: number;
  start: number;
  value: number;
  maxTravel: number;
}

type Grab = BodyGrab | LevelGrab | CapGrab | BuildGrab | ScratchGrab | FadeGrab | FaderGrab | TempoGrab;

/**
 * Consumes perception frames and turns them into spatial interactions.
 * Knows nothing about audio or drawing; audio meaning is assigned by whoever
 * listens to the events (see bridge/stemAudioBridge.ts).
 *
 * Interaction model:
 *  - pinch the body          -> reposition (layout only)
 *  - quick pinch-tap on body -> tap (mute toggle)
 *  - pinch the level handle  -> drag up/down to set level, release to lock
 *  - second hand on the body -> stretch / compress (FX amount)
 * Each hand owns at most one thing at a time, and each stem has one owner:
 * a hand can't take a stem the other hand is moving or leveling, except by
 * joining a body grab on purpose to stretch it.
 */
export class InteractionController {
  private grabs = new Map<HandId, Grab>();
  /** When each hand's current grab gesture started (for the grab retry window). */
  private gestureStart = new Map<HandId, number>();
  /** Object position minus its drag anchor, so grabs never snap. */
  private offsets = new Map<string, Point2>();
  /** Sticky hover target per free hand. */
  private targets = new Map<HandId, HoloObject>();
  private aimHistory = new Map<HandId, Sample[]>();
  private positionHistory = new Map<string, Sample[]>();
  /** Stretch amount and hand span when the current two-hand hold began. */
  private stretchBase = new Map<string, { amount: number; span: number }>();
  /** Pending reset-layout destinations. */
  private resetTargets = new Map<string, Point2>();
  private lastT: number | null = null;
  /**
   * Per-hand drag point: the smoothed knuckle anchor. Aiming uses the
   * fingertips, but motion follows the knuckles, which don't shift as the
   * fingers curl into a grip, so held stems don't jitter.
   */
  private dragPoints = new Map<HandId, Point2>();
  /**
   * Isolation of the current (or last) blend pair, 0..1. Persists after
   * release, like stretch, until the hands blend it back down.
   */
  isolation = 0;
  /** The two stems currently held one-per-hand, if any (for visuals). */
  blendPair: [HoloObject, HoloObject] | null = null;
  private blendBase: { amount: number; span: number } | null = null;
  /** Flick velocity of free stems, view units per second. */
  private velocity = new Map<string, Point2>();
  /** Set false to disable the lift build gesture. */
  buildEnabled = true;
  /** Mirror of engine performance state (set each frame, like each stem's `audio`). */
  perfView = { dropPending: false, crossfader: 0, tempo: { A: 1, B: 1 } };
  /** Decks' tempo strips (set by the page as decks load). */
  tempoStrips: TempoStrip[] = [];
  /** Decks' records (set by the page as decks load). */
  platters: Platter[] = [];
  /** Open-palm crossfader zone, or null to disable. */
  crossfadeZone: CrossfadeZone | null = null;
  /** Live crossfader value while a palm holds it (for visuals). */
  crossfadeValue: number | null = null;
  /** Per hand: since when an open palm has been arming a record or the crossfader. */
  private palmArm = new Map<HandId, { kind: 'scratch'; since: number; start: Point2; platter?: Platter }>();
  /** When each hand was last in the lift pose (build/drop), to keep the drop's open hand from scratching. */
  private lastLift = new Map<HandId, number>();
  /** Per hand: since when a pinch has been arming the crossfader. */
  private pinchArm = new Map<HandId, number>();
  /** Per hand: since when two fingers up have been arming the crossfader. */
  private twoUpArm = new Map<HandId, number>();
  /** Per hand: current pinch point (pinched faders and records follow it). */
  private pinchPoints = new Map<HandId, Point2>();
  /** Live build gesture, or null. */
  build: BuildView | null = null;
  /** Current state of each hand in the frame. */
  readonly handModes = new Map<HandId, HandMode>();
  private lastDropT = -Infinity;
  private clipSeq = 0;
  private clipSpawns = new Map<string, Point2>();

  /**
   * @param aspect  video width / height, for undistorted hitboxes
   * @param gesture which hand gesture grabs objects
   */
  constructor(
    readonly objects: HoloObject[],
    private aspect: number,
    private onEvent: (e: InteractionEvent) => void = () => {},
    private gesture: GrabGesture = 'grab',
  ) {}

  setAspect(aspect: number): void {
    this.aspect = aspect;
  }

  /** Smoothly move free objects to these positions (held ones are left alone). */
  resetLayout(positions: ReadonlyMap<string, Point2>): void {
    for (const [id, p] of positions) {
      this.resetTargets.set(id, { ...p });
      this.velocity.delete(id);
    }
  }

  update(frame: PerceptionFrame): void {
    const t = frame.timestamp;
    const dt = this.lastT === null ? 0 : Math.min(0.1, (t - this.lastT) / 1000);
    this.lastT = t;

    const points = new Map<HandId, Point2>();
    this.dragPoints.clear();
    for (const hand of frame.hands) {
      points.set(hand.id, hand[this.gesture].point);
      this.dragPoints.set(hand.id, hand.anchor);
      if (hand.tracked) record(this.aimHistory, hand.id, t, hand[this.gesture].point);
    }

    // Releases first, so a hand can let go and re-grab in the same frame.
    for (const hand of frame.hands) {
      // A build is held by the lift pose; everything else by the grab gesture.
      const g = this.grabs.get(hand.id);
      const ended =
        g?.kind === 'build'
          ? !hand.lift?.active
          : g?.kind === 'scratch'
            ? g.via === 'palm'
              ? !hand.palm?.active
              : !hand.pinch.active
            : g?.kind === 'fader' || g?.kind === 'tempo'
              ? // Once a pinch has a target it keeps it until the pinch opens (curling fingers doesn't drop it).
                !hand.pinch.active
              : g?.kind === 'crossfade'
                ? !hand.twoUp?.active
                : hand[this.gesture].phase === 'end';
      if (ended) this.release(hand.id, points, t, !hand.tracked);
    }
    // Safety net: release hands that vanished without an 'end'.
    for (const id of [...this.grabs.keys()]) {
      if (!points.has(id)) this.release(id, points, t, true);
    }

    this.updateTargets(frame, t);

    for (const hand of frame.hands) {
      const phase = hand[this.gesture].phase;
      this.pinchPoints.set(hand.id, { ...hand.pinch.point });
      if (hand.lift?.active) this.lastLift.set(hand.id, t);
      // Two fingers up (✌) takes the crossfader.
      if (hand.twoUp?.active && !hand.lift?.active) {
        this.armTwoUp(hand, t);
        this.pinchArm.delete(hand.id);
        this.gestureStart.delete(hand.id);
        continue;
      }
      this.twoUpArm.delete(hand.id);
      // A pinch that isn't closing into a fist arms the crossfader.
      if (hand.pinch.active && !hand.grip.active && !hand.lift?.active && !hand.palm?.active) this.armPinch(hand, t);
      else this.pinchArm.delete(hand.id);
      // An open palm (fingers not hanging down) scratches the deck on its side of the screen; never stems.
      if (hand.palm?.active && !hand.fingersDown && !hand.lift?.active) {
        this.armPalm(hand, t);
        this.gestureStart.delete(hand.id);
        continue;
      }
      this.palmArm.delete(hand.id);
      // The lift pose starts a build (one at a time), and never grabs stems.
      if (hand.lift?.active) {
        if (this.buildEnabled && hand.tracked && !this.grabs.has(hand.id) && !this.build) this.startBuild(hand.id);
        this.gestureStart.delete(hand.id);
        continue;
      }
      if (phase === 'start') this.gestureStart.set(hand.id, t);
      if (phase !== 'start' && phase !== 'held') {
        this.gestureStart.delete(hand.id);
        continue;
      }
      // Retry for a short window after the gesture starts, so closing the hand
      // a moment before (or while) arriving on a stem still grabs it.
      const started = this.gestureStart.get(hand.id);
      if (hand.tracked && started !== undefined && t - started <= GRAB_WINDOW_MS) this.grab(hand, points, t);
    }

    for (const [hand, g] of this.grabs) {
      const state = frame.hands.find((h) => h.id === hand)!;
      if (g.kind === 'level') this.adjustLevel(hand, g, points.get(hand)!);
      // Controls freeze while tracking is shaky, so glitches can't jump values.
      if (!state.tracked) continue;
      if (g.kind === 'loop') this.adjustLoop(hand, g);
      if (g.kind === 'filter') this.adjustFilter(hand, g, dt);
      if (g.kind === 'build') this.adjustBuild(hand, g, dt);
      if (g.kind === 'scratch') this.adjustScratch(hand, g, points, state.roll);
      if (g.kind === 'crossfade') this.adjustFade(hand, g, dt);
      if (g.kind === 'fader') this.adjustFader(hand, g, dt);
      if (g.kind === 'tempo') this.adjustTempo(hand, g);
    }
    for (const obj of this.objects) {
      obj.twist = null;
      if (!obj.vertical || obj.holders.length === 0) obj.volumeAdjust = null; // a pinched fader sets its own
      if (obj.holders.length === 0 || obj.vertical) continue; // fader bars are driven by their pinch grab
      this.follow(obj, points, dt);
      record(this.positionHistory, obj.id, t, obj.position);
      this.onEvent({ type: 'move', object: obj });
    }
    for (const [hand, g] of this.grabs) {
      if (g.kind !== 'body') continue;
      const state = frame.hands.find((h) => h.id === hand)!;
      if (state.tracked) this.adjustTwist(hand, g, state.roll, dt);
      if (g.twisting) g.object.twist = g.filterValue;
    }

    this.updateBlend(points);
    this.stepReset(dt);
    this.stepPhysics(dt);
    this.updateHover(frame);
    this.updatePalmHover(t);
    this.updateModes(frame);
    for (const id of [...this.aimHistory.keys()]) if (!points.has(id)) this.aimHistory.delete(id);
    for (const id of [...this.gestureStart.keys()]) if (!points.has(id)) this.gestureStart.delete(id);
    for (const id of [...this.palmArm.keys()]) if (!points.has(id)) this.palmArm.delete(id);
    for (const id of [...this.pinchArm.keys()]) if (!points.has(id)) this.pinchArm.delete(id);
    for (const id of [...this.twoUpArm.keys()]) if (!points.has(id)) this.twoUpArm.delete(id);
    for (const id of [...this.pinchPoints.keys()]) if (!points.has(id)) this.pinchPoints.delete(id);
  }

  // --- Open-palm controls: records and crossfader -----------------------------

  /**
   * An open palm: arm, then take, the record under it (or the deck on its side). It has to be
   * a deliberate pose: facing the camera, held still for SCRATCH_ARM_MS, and not right after
   * a lift or a drop.
   */
  private armPalm(hand: HandState, t: number): void {
    if (!hand.tracked || this.grabs.has(hand.id)) return;
    const sinceLift = t - Math.max(this.lastLift.get(hand.id) ?? -Infinity, this.lastDropT);
    if (hand.facing === false || sinceLift < SCRATCH_AFTER_LIFT_MS) {
      this.palmArm.delete(hand.id);
      return;
    }
    const p = hand.palm!.point;
    // On a record: that record. Anywhere else: the deck on that side of the screen.
    const onRecord = this.platters.find((pl) => !pl.hand && viewDist(p, pl.position, this.aspect) <= pl.radius + PLATTER_PAD);
    const platter = onRecord ?? this.platterForSide(p);
    const kind = platter ? 'scratch' : null;
    const arm = this.palmArm.get(hand.id);
    if (!kind) {
      this.palmArm.delete(hand.id);
      return;
    }
    // Moving restarts the hold: a hand on its way somewhere (a drink, the next gesture) never arms.
    if (!arm || arm.kind !== kind || arm.platter !== platter || viewDist(p, arm.start, this.aspect) > SCRATCH_ARM_STILL) {
      this.palmArm.set(hand.id, { kind, since: t, start: { ...p }, platter: platter ?? undefined });
      return;
    }
    if (t - arm.since < SCRATCH_ARM_MS || !platter) return;
    this.palmArm.delete(hand.id);
    const anchor = this.dragPoints.get(hand.id) ?? p;
    platter.hand = hand.id;
    platter.offsetSec = 0;
    this.grabs.set(hand.id, {
      kind: 'scratch',
      platter,
      startX: anchor.x,
      via: 'palm',
      ...this.scratchCenter(anchor, onRecord),
      lastRoll: hand.roll ?? null,
    });
    this.onEvent({ type: 'scratchStart', deck: platter.deck, hand: hand.id });
  }

  /**
   * The pinch (thumb + index) is the grab for the deck controls. Once held a
   * moment without closing into a fist, what it takes depends on where it is:
   * a record -> scratch, the top of a fader bar -> volume (elsewhere: nothing).
   * It keeps that target until the pinch opens.
   */
  private armPinch(hand: HandState, t: number): void {
    if (!hand.tracked || this.grabs.has(hand.id)) return;
    const since = this.pinchArm.get(hand.id);
    if (since === undefined) {
      this.pinchArm.set(hand.id, t);
      return;
    }
    if (t - since < PINCH_ARM_MS) return;
    this.pinchArm.delete(hand.id);
    const p = hand.pinch.point;
    const platter = this.platters.find((pl) => !pl.hand && viewDist(p, pl.position, this.aspect) <= pl.radius + PLATTER_PAD);
    if (platter) {
      platter.hand = hand.id;
      platter.offsetSec = 0;
      this.grabs.set(hand.id, { kind: 'scratch', platter, startX: p.x, via: 'pinch', ...this.scratchCenter(p, platter), lastRoll: null });
      this.onEvent({ type: 'scratchStart', deck: platter.deck, hand: hand.id });
      return;
    }
    const strip = this.tempoAt(p);
    if (strip) {
      const start = this.perfView.tempo[strip.deck];
      strip.hand = hand.id;
      strip.value = start;
      this.grabs.set(hand.id, { kind: 'tempo', strip, startT: t, startY: p.y, start, value: start, maxTravel: 0 });
      return;
    }
    const bar = this.faderAt(p);
    if (bar) {
      bar.holders = [hand.id];
      bar.holdPoints = [{ ...p }];
      this.grabs.set(hand.id, { kind: 'fader', object: bar, startY: p.y, startVolume: bar.audio.volume, value: bar.audio.volume, active: false });
      this.onEvent({ type: 'levelStart', object: bar, hand: hand.id });
      return;
    }
  }

  /** Two fingers up, held a moment: take the crossfader (it follows the hand sideways). */
  private armTwoUp(hand: HandState, t: number): void {
    if (!hand.tracked || this.grabs.has(hand.id) || !this.crossfadeZone || this.crossfadeZone.hand) return;
    const since = this.twoUpArm.get(hand.id);
    if (since === undefined) {
      this.twoUpArm.set(hand.id, t);
      return;
    }
    if (t - since < TWO_UP_ARM_MS) return;
    this.twoUpArm.delete(hand.id);
    const p = this.dragPoints.get(hand.id) ?? hand.anchor;
    this.crossfadeZone.hand = hand.id;
    const start = this.perfView.crossfader;
    this.crossfadeValue = start;
    this.grabs.set(hand.id, { kind: 'crossfade', startX: p.x, start, value: start });
    this.onEvent({ type: 'crossfadeStart', hand: hand.id });
  }

  /**
   * What the hand turns: the record itself when the hand is on it (not right
   * at its middle), otherwise an invisible record just below the hand.
   */
  private scratchCenter(p: Point2, record: Platter | undefined): { center: Point2; lastAngle: number; turned: number } {
    const onRim = record && viewDist(p, record.position, this.aspect) > record.radius * 0.35;
    const center = onRim ? { ...record!.position } : { x: p.x, y: p.y + SCRATCH_VIRTUAL_RADIUS };
    return { center, lastAngle: this.angleAround(center, p), turned: 0 };
  }

  /** Angle of a point around a center: 0 = straight above it, increasing clockwise as you see it. */
  private angleAround(c: Point2, p: Point2): number {
    return Math.atan2((p.x - c.x) * this.aspect, c.y - p.y);
  }

  /**
   * The record of the deck on this side of the screen: left half = A, right half = B.
   * Strictly by side, even with one deck loaded, so a hand never reaches across the
   * screen to the other deck's record.
   */
  private platterForSide(p: Point2): Platter | undefined {
    return this.platters.find((pl) => !pl.hand && pl.deck === (p.x < 0.5 ? 'A' : 'B'));
  }

  /** The tempo strip under (or near) this point, if free. */
  private tempoAt(p: Point2): TempoStrip | undefined {
    return this.tempoStrips.find(
      (s) =>
        !s.hand &&
        Math.abs(p.x - s.position.x) * this.aspect <= TEMPO_REACH.x &&
        Math.abs(p.y - s.position.y) <= s.halfHeight + TEMPO_REACH.y,
    );
  }

  /** Pinched tempo strip: relative drag, up = faster, with a notch at ×1.00. */
  private adjustTempo(hand: HandId, g: TempoGrab): void {
    const p = this.pinchPoints.get(hand);
    if (!p) return;
    const dy = g.startY - p.y;
    g.maxTravel = Math.max(g.maxTravel, Math.abs(dy));
    let rate = Math.max(0.5, Math.min(2, g.start + (dy / TEMPO_TRAVEL) * TEMPO_RANGE));
    if (Math.abs(rate - 1) < TEMPO_DETENT) rate = 1;
    g.strip.value = rate;
    if (Math.abs(rate - g.value) < 1e-4) return;
    g.value = rate;
    this.onEvent({ type: 'tempo', deck: g.strip.deck, hand, rate });
  }

  /** The fader bar whose fill line (the top of the bar) is near this point, if any. */
  private faderAt(p: Point2): HoloObject | null {
    let best: HoloObject | null = null;
    let bestD = Infinity;
    for (const o of this.objects) {
      if (!o.vertical || o.holders.length > 0) continue;
      const dx = Math.abs(p.x - o.position.x) * this.aspect;
      if (dx > o.halfSize.x + FADER_GRAB_PAD_X) continue;
      const top = o.position.y + o.halfSize.y - 2 * o.halfSize.y * o.audio.volume;
      const dy = p.y - top; // negative = above the line
      if (dy < -FADER_GRAB_ABOVE || dy > FADER_GRAB_BELOW) continue;
      const d = Math.hypot(dx, dy);
      if (d < bestD) {
        best = o;
        bestD = d;
      }
    }
    return best;
  }

  /** Pinched fader: the bar's top follows the pinch 1:1, rate-limited. */
  private adjustFader(hand: HandId, g: FaderGrab, dt: number): void {
    const p = this.pinchPoints.get(hand);
    if (!p) return;
    const obj = g.object;
    obj.holdPoints = [{ ...p }];
    const dy = g.startY - p.y;
    const moved = Math.sign(dy) * Math.max(0, Math.abs(dy) - BAR_DEADZONE);
    if (!g.active && moved === 0) {
      obj.volumeAdjust = g.value;
      return;
    }
    g.active = true;
    const target = clamp01(g.startVolume + moved / (2 * obj.halfSize.y));
    const value = stepToward(g.value, target, VOLUME_MAX_RATE * Math.max(dt, 1 / 60));
    obj.volumeAdjust = value;
    if (value === g.value) return;
    g.value = value;
    this.onEvent({ type: 'level', object: obj, hand, value });
  }

  /** Scratch: sideways movement of the hand moves the record (right = forward). */
  private adjustScratch(hand: HandId, g: ScratchGrab, points: Map<HandId, Point2>, roll?: number): void {
    const p = (g.via === 'pinch' ? this.pinchPoints.get(hand) : this.dragPoints.get(hand)) ?? points.get(hand)!;
    // A pinched record lets go if the hand wanders well off it (an open palm scratches from anywhere).
    if (g.via === 'pinch' && viewDist(p, g.platter.position, this.aspect) > g.platter.radius * PLATTER_LEAVE) {
      this.release(hand, points, this.lastT ?? 0);
      return;
    }
    // Turn the record by whichever arc the hand makes this frame (no double counting):
    //  - the hand moving around the record's center (an arm arc), or
    //  - the hand tilting at the wrist (rocking like a windshield wiper).
    const angle = this.angleAround(g.center, p);
    const arc = wrapAngle(angle - g.lastAngle);
    g.lastAngle = angle;
    let rock = 0;
    if (roll !== undefined && g.lastRoll !== null) rock = wrapAngle(roll - g.lastRoll);
    if (roll !== undefined) g.lastRoll = roll;
    g.turned += Math.abs(rock) > Math.abs(arc) ? rock : arc;
    const offsetSec = g.turned / (2 * Math.PI) / RECORD_TURNS_PER_SEC;
    g.platter.offsetSec = offsetSec;
    this.onEvent({ type: 'scratch', deck: g.platter.deck, hand, offsetSec });
  }

  /** Crossfader: follows the hand (knuckles) sideways, relative to where it took it, rate-limited. */
  private adjustFade(hand: HandId, g: FadeGrab, dt: number): void {
    const p = this.dragPoints.get(hand);
    if (!p) return;
    const target = Math.max(-1, Math.min(1, g.start + ((p.x - g.startX) * this.aspect * 2) / FADE_TRAVEL));
    const value = stepToward(g.value, target, FADE_MAX_RATE * Math.max(dt, 1 / 60));
    this.crossfadeValue = value;
    if (value === g.value) return;
    g.value = value;
    this.onEvent({ type: 'crossfade', hand, value });
  }

  /** Arming feedback for the records and the crossfader zone. */
  private updatePalmHover(t: number): void {
    for (const pl of this.platters) pl.hover = pl.hand ? 1 : 0;
    if (this.crossfadeZone) this.crossfadeZone.arming = this.crossfadeZone.hand ? 1 : 0;
    for (const arm of this.palmArm.values()) {
      if (arm.platter) arm.platter.hover = Math.max(arm.platter.hover, Math.min(1, 0.4 + (t - arm.since) / SCRATCH_ARM_MS));
    }
    // Bar tops and tempo strips light up under a hand that could pinch them.
    for (const st of this.tempoStrips) st.hover = st.hand ? 1 : 0;
    for (const [hand, p] of this.pinchPoints) {
      if (this.grabs.has(hand)) continue;
      const strip = this.tempoAt(p);
      if (strip) {
        strip.hover = 1;
        continue;
      }
      const bar = this.faderAt(p);
      if (bar) bar.hover = 1;
    }
    if (this.crossfadeZone) {
      for (const since of this.twoUpArm.values()) {
        this.crossfadeZone.arming = Math.max(this.crossfadeZone.arming, Math.min(1, (t - since) / TWO_UP_ARM_MS));
      }
    }
  }

  /** Derive each hand's state from what it holds / targets. */
  private updateModes(frame: PerceptionFrame): void {
    this.handModes.clear();
    for (const hand of frame.hands) {
      const g = this.grabs.get(hand.id);
      let mode: HandMode;
      if (!hand.tracked) mode = 'trackingLost';
      else if (!g) {
        const hovering =
          this.targets.has(hand.id) ||
          this.pinchArm.has(hand.id) ||
          this.twoUpArm.has(hand.id) ||
          this.objects.some((o) => o.capHover.loop > 0.99 || o.capHover.filter > 0.99);
        mode = this.palmArm.has(hand.id) ? 'scratchArming' : hovering ? 'hover' : 'idle';
      } else if (g.kind === 'body') {
        if (g.twisting) mode = 'filterControl';
        else if (g.object.holders.length === 2) mode = 'stretching';
        else if (g.volumeActive) mode = 'volume';
        else if (this.blendPair?.includes(g.object)) mode = 'blending';
        else mode = g.maxTravel < TAP_MOVE ? 'grabbing' : 'repositioning';
      } else if (g.kind === 'loop') mode = g.pulled ? 'clipPulling' : 'loopSelecting';
      else if (g.kind === 'scratch') mode = 'scratching';
      else if (g.kind === 'crossfade') mode = 'crossfading';
      else if (g.kind === 'fader') mode = 'volume';
      else if (g.kind === 'tempo') mode = 'tempo';
      else if (g.kind === 'filter') mode = 'filterControl';
      else if (g.kind === 'build') {
        mode = g.dropped || this.perfView.dropPending ? 'dropPending' : g.value >= BUILD_MIN ? 'building' : 'buildArmed';
      } else mode = 'grabbing'; // level handle
      this.handModes.set(hand.id, mode);
    }
  }

  // --- Grab / release ----------------------------------------------------------

  private grab(hand: HandState, points: Map<HandId, Point2>, t: number): void {
    if (this.grabs.has(hand.id)) return;
    const aim = sampleAt(this.aimHistory.get(hand.id), t - AIM_LOOKBACK_MS) ?? points.get(hand.id)!;
    const current = points.get(hand.id)!;
    const anchorNow = this.dragPoints.get(hand.id) ?? current;

    // Caps win over stem bodies: they're small, deliberate targets.
    const cap = this.pickCap(aim);
    if (cap && this.capDistance(current, cap.obj, cap.kind) <= CAP_HIT + GRAB_REACH) {
      const obj = cap.obj;
      const start = cap.kind === 'filter' ? obj.audio.filter : loopIndex(obj.audio.loop?.beats ?? null);
      this.grabs.set(hand.id, {
        kind: cap.kind,
        object: obj,
        startT: t,
        startY: anchorNow.y,
        startX: anchorNow.x,
        start,
        current: start,
        maxTravel: 0,
        pulled: false,
      });
      obj.control = { kind: cap.kind, hand: hand.id };
      this.velocity.delete(obj.id);
      this.resetTargets.delete(obj.id);
      this.targets.delete(hand.id);
      if (cap.kind === 'loop') {
        obj.loopPreview = LOOP_OPTIONS[start];
        this.onEvent({ type: 'loopSelect', object: obj, hand: hand.id, beats: obj.loopPreview });
      }
      return;
    }

    // The level handle wins over the body: it's the smaller, more deliberate target.
    const handleObj = this.pickHandle(aim);
    if (handleObj) {
      handleObj.levelHand = hand.id;
      // Relative to where the hand is now, so engaging never jumps the level.
      const startY = points.get(hand.id)!.y;
      this.grabs.set(hand.id, { kind: 'level', object: handleObj, startVolume: handleObj.audio.volume, startY });
      this.onEvent({ type: 'levelStart', object: handleObj, hand: hand.id });
      return;
    }

    const sticky = this.targets.get(hand.id);
    const target =
      (sticky && canTake(sticky) && !sticky.levelHand && !sticky.control && !sticky.vertical ? sticky : null) ??
      this.pick(aim) ??
      this.pickStretchJoin(points.get(hand.id)!);
    if (!target) return;
    // The hand must actually be on the object NOW, not just a moment ago:
    // otherwise closing the hand while moving away grabs from a distance.
    const reach = target.holders.length === 1 ? GRAB_REACH + STRETCH_JOIN_REACH : GRAB_REACH;
    if (this.hitMetrics(points.get(hand.id)!, target).outside > reach) return;

    target.holders.push(hand.id);
    this.resetTargets.delete(target.id);
    this.velocity.delete(target.id);
    const roll = hand.roll ?? null;
    this.grabs.set(hand.id, {
      kind: 'body',
      object: target,
      startT: t,
      startPos: { ...target.position },
      maxTravel: 0,
      rollStart: roll,
      filterStart: target.audio.filter,
      filterValue: target.audio.filter,
      twisting: false,
      startHand: { ...anchorNow },
      startVolume: target.audio.volume,
      volumeValue: target.audio.volume,
      volumeActive: false,
    });
    this.targets.delete(hand.id);
    this.rebaseOffset(target, points);
    target.holdPoints = target.holders.map((h) => ({ ...points.get(h)! }));
    // Stretch continues from the current amount, relative to the starting span.
    if (target.holders.length === 2) {
      this.stretchBase.set(target.id, { amount: target.stretchAmount, span: this.span(target, points) });
    }
    this.onEvent({ type: target.holders.length === 1 ? 'grab' : 'stretchStart', object: target, hand: hand.id });
  }

  private startBuild(hand: HandId): void {
    const from = this.dragPoints.get(hand)!;
    const travel = Math.max(BUILD_TRAVEL_MIN, Math.min(BUILD_TRAVEL, from.y - BUILD_TOP_REACH));
    const g: BuildGrab = { kind: 'build', startY: from.y, from: { ...from }, value: 0, dropped: false, travel };
    this.grabs.set(hand, g);
    this.targets.delete(hand);
    this.build = { hand, value: 0, state: 'armed', from: { ...from }, point: { ...this.dragPoints.get(hand)! }, travel };
    this.onEvent({ type: 'buildStart', hand });
    this.adjustBuild(hand, g, 0);
  }

  /** @param lost the hand was lost (not deliberately opened): cancel rather than commit. */
  private release(hand: HandId, points: Map<HandId, Point2>, t: number, lost = false): void {
    const g = this.grabs.get(hand);
    if (!g) return;
    this.grabs.delete(hand);

    if (g.kind === 'scratch') {
      g.platter.hand = null;
      g.platter.offsetSec = 0;
      this.onEvent({ type: 'scratchEnd', deck: g.platter.deck, hand });
      return;
    }
    if (g.kind === 'tempo') {
      g.strip.hand = null;
      g.strip.value = null;
      // A quick pinch-tap without dragging resets to normal speed.
      if (!lost && t - g.startT < TAP_MS + 150 && g.maxTravel < TAP_MOVE) this.onEvent({ type: 'tempo', deck: g.strip.deck, hand, rate: 1 });
      return;
    }
    if (g.kind === 'fader') {
      g.object.holders = [];
      g.object.holdPoints = [];
      g.object.volumeAdjust = null;
      this.onEvent({ type: 'levelEnd', object: g.object, hand });
      return;
    }
    if (g.kind === 'crossfade') {
      if (this.crossfadeZone) this.crossfadeZone.hand = null;
      this.crossfadeValue = null;
      this.onEvent({ type: 'crossfadeEnd', hand });
      return;
    }
    if (g.kind === 'build') {
      // Letting go of the lift pose is the drop, once it's building. A hand that vanishes
      // (fast opening blurs the camera) counts as letting go too, unless it left through
      // the top of the frame. To cancel, lower the hand first: the build falls with it.
      const offCooldown = t - this.lastDropT >= DROP_COOLDOWN_MS;
      const p = this.dragPoints.get(hand) ?? this.build?.point;
      const outTheTop = lost && (!p || p.y < BUILD_TOP_EDGE);
      if (!g.dropped && !outTheTop && g.value >= RELEASE_DROP_MIN && offCooldown) this.fireDrop(hand, g, t);
      this.build = null;
      this.onEvent({ type: 'buildEnd', hand, dropped: g.dropped });
      return;
    }
    if (isCap(g)) {
      this.releaseCap(hand, g, t, lost);
      return;
    }
    const obj = g.object;

    if (g.kind === 'level') {
      obj.levelHand = null;
      this.onEvent({ type: 'levelEnd', object: obj, hand });
      return;
    }

    obj.holders = obj.holders.filter((h) => h !== hand);
    obj.holdPoints = obj.holders.map((h) => ({ ...points.get(h)! }));
    // The stretch amount persists; only the active two-hand state ends.
    obj.stretch = null;
    this.stretchBase.delete(obj.id);

    if (obj.holders.length > 0) {
      this.rebaseOffset(obj, points);
      // The remaining hand picks up volume control from where it is now (no jump).
      for (const h of obj.holders) {
        const other = this.grabs.get(h);
        const p = this.dragPoints.get(h);
        if (other?.kind === 'body' && p) {
          other.startHand = { ...p };
          other.startVolume = obj.audio.volume;
          other.volumeValue = obj.audio.volume;
          other.volumeActive = false;
        }
      }
      this.onEvent({ type: 'stretchEnd', object: obj, hand });
      return;
    }

    const isTap = t - g.startT < TAP_MS && g.maxTravel < TAP_MOVE;
    if (isTap) {
      obj.position = { ...g.startPos };
    } else {
      // Undo the drift caused by the fingers opening.
      const history = this.positionHistory.get(obj.id);
      const before = sampleAt(history, t - RELEASE_LOOKBACK_MS);
      if (before) obj.position = { ...before };
      // Flick: carry the hand's speed from just before the fingers opened.
      const earlier = sampleAt(history, t - RELEASE_LOOKBACK_MS - 100);
      const span = before && earlier ? sampleTime(history, t - RELEASE_LOOKBACK_MS) - sampleTime(history, t - RELEASE_LOOKBACK_MS - 100) : 0;
      if (before && earlier && span > 0) {
        let vx = ((before.x - earlier.x) * 1000) / span;
        let vy = ((before.y - earlier.y) * 1000) / span;
        const speed = Math.hypot(vx * this.aspect, vy);
        if (speed > FLICK_MIN_SPEED) {
          const k = Math.min(1, FLICK_MAX_SPEED / speed);
          vx *= k;
          vy *= k;
          this.velocity.set(obj.id, { x: vx, y: vy });
        }
      }
    }
    this.onEvent({ type: 'move', object: obj });
    this.offsets.delete(obj.id);
    this.positionHistory.delete(obj.id);
    this.onEvent({ type: 'release', object: obj, hand });
    if (g.twisting) this.onEvent({ type: 'filterEnd', object: obj, hand });
    if (isTap && !obj.vertical) this.onEvent({ type: 'tap', object: obj, hand }); // fader bars: no tap-to-mute
    else this.maybeReturnClip(obj);
  }

  /** A free clip resting on (or thrown into) its source stem goes back in. */
  private maybeReturnClip(obj: HoloObject): void {
    if (!obj.clipOf || obj.returning || obj.holders.length > 0) return;
    const source = this.objects.find((o) => o.id === obj.clipOf);
    if (!source || this.hitMetrics(obj.position, source).outside > 0) return;
    obj.returning = true;
    this.velocity.delete(obj.id);
    this.onEvent({ type: 'clipReturn', object: obj, source });
  }

  // --- Dynamic objects (loop clips) -------------------------------------------

  /** Add an object (e.g. a loop clip the engine just created). */
  addObject(obj: HoloObject): void {
    if (!this.objects.includes(obj)) this.objects.push(obj);
  }

  /** Remove an object (e.g. a clip the engine removed), letting go of anything holding it. */
  removeObject(id: string): void {
    const i = this.objects.findIndex((o) => o.id === id);
    if (i < 0) return;
    const obj = this.objects[i];
    for (const [hand, g] of [...this.grabs]) if ('object' in g && g.object === obj) this.grabs.delete(hand);
    for (const [hand, o] of [...this.targets]) if (o === obj) this.targets.delete(hand);
    if (this.blendPair?.includes(obj)) {
      this.blendPair = null;
      this.blendBase = null;
    }
    for (const m of [this.offsets, this.positionHistory, this.stretchBase, this.resetTargets, this.velocity]) m.delete(id);
    this.objects.splice(i, 1);
  }

  /** Where a just-pulled clip should appear (consumed once). */
  takeClipSpawn(clipId: string): Point2 | undefined {
    const p = this.clipSpawns.get(clipId);
    this.clipSpawns.delete(clipId);
    return p;
  }

  private releaseCap(hand: HandId, g: CapGrab, t: number, lost: boolean): void {
    const obj = g.object;
    obj.control = null;
    const isTap = !lost && t - g.startT < TAP_MS && g.maxTravel < TAP_MOVE;
    if (g.kind === 'loop') {
      obj.loopPreview = undefined;
      const at = obj.clipPreview;
      obj.clipPreview = null;
      const currentBeats = obj.audio.loop?.beats ?? null;
      if (g.pulled && at && !lost) {
        const beats = LOOP_OPTIONS[g.current] ?? DEFAULT_CLIP_BEATS;
        const clipId = `${obj.id}~${++this.clipSeq}`;
        this.clipSpawns.set(clipId, { ...at });
        this.onEvent({ type: 'clipCreate', object: obj, hand, clipId, beats, at: { ...at } });
      } else if (lost) {
        this.onEvent({ type: 'loopCancel', object: obj, hand });
      } else if (isTap) {
        // Tap toggles: exit a running loop, or start the default one.
        this.onEvent({ type: 'loopCommit', object: obj, hand, beats: currentBeats === null ? TAP_LOOP_BEATS : null });
      } else {
        const beats = LOOP_OPTIONS[g.current];
        if (beats !== currentBeats) this.onEvent({ type: 'loopCommit', object: obj, hand, beats });
        else this.onEvent({ type: 'loopCancel', object: obj, hand });
      }
    } else {
      // Release holds the filter where it is; a tap resets it.
      if (isTap) this.onEvent({ type: 'filter', object: obj, hand, value: 0 });
      this.onEvent({ type: 'filterEnd', object: obj, hand });
    }
  }

  // --- Per-frame manipulation ----------------------------------------------------

  /**
   * Twist-to-filter on a single-hand body grab: rotate the fist like a knob.
   * Latches past the dead zone (so ordinary dragging doesn't filter), then
   * maps further rotation to the filter, rate-limited against glitches.
   */
  private adjustTwist(hand: HandId, g: BodyGrab, roll: number | undefined, dt: number): void {
    if (roll === undefined || g.rollStart === null || g.object.holders.length !== 1 || g.object.vertical) return;
    const d = wrapAngle(roll - g.rollStart);
    if (!g.twisting) {
      if (Math.abs(d) < TWIST_DEADZONE) return;
      g.twisting = true;
    }
    const moved = Math.sign(d) * Math.max(0, Math.abs(d) - TWIST_DEADZONE);
    let target = Math.max(-1, Math.min(1, g.filterStart + moved / TWIST_RANGE));
    if (Math.abs(target) < FILTER_DETENT) target = 0;
    const maxStep = FILTER_MAX_RATE * Math.max(dt, 1 / 60);
    const value = stepToward(g.filterValue, target, maxStep);
    if (value === g.filterValue) return;
    g.filterValue = value;
    this.onEvent({ type: 'filter', object: g.object, hand, value });
  }

  /** Loop cap: each LOOP_STEP of vertical travel steps the length (up = longer, bottom = off). */
  private adjustLoop(hand: HandId, g: CapGrab): void {
    const p = this.dragPoints.get(hand)!;
    const y = p.y;
    const dy = g.startY - y;
    const dx = Math.abs(p.x - g.startX) * this.aspect;
    g.maxTravel = Math.max(g.maxTravel, Math.abs(dy), dx);
    // Dragged sideways out of the stem: this becomes a floating clip, following the hand.
    if (!g.pulled && dx > CLIP_PULL_DIST) g.pulled = true;
    else if (g.pulled && dx < CLIP_UNPULL_DIST) g.pulled = false;
    if (g.pulled) {
      g.object.clipPreview = { ...p };
      if (LOOP_OPTIONS[g.current] === null) {
        g.current = LOOP_OPTIONS.indexOf(DEFAULT_CLIP_BEATS);
        g.object.loopPreview = DEFAULT_CLIP_BEATS;
      }
      return;
    }
    g.object.clipPreview = null;
    const index = Math.min(LOOP_OPTIONS.length - 1, Math.max(0, g.start + Math.round(dy / LOOP_STEP)));
    if (index === g.current) return;
    g.current = index;
    g.object.loopPreview = LOOP_OPTIONS[index];
    this.onEvent({ type: 'loopSelect', object: g.object, hand, beats: LOOP_OPTIONS[index] });
  }

  /** Filter cap: relative vertical control, up = highpass, down = lowpass, rate-limited, with a detent at 0. */
  private adjustFilter(hand: HandId, g: CapGrab, dt: number): void {
    const y = this.dragPoints.get(hand)!.y;
    const dy = g.startY - y;
    g.maxTravel = Math.max(g.maxTravel, Math.abs(dy));
    const moved = Math.sign(dy) * Math.max(0, Math.abs(dy) - FILTER_DEADZONE);
    let target = Math.max(-1, Math.min(1, g.start + moved / FILTER_TRAVEL));
    if (Math.abs(target) < FILTER_DETENT) target = 0;
    const maxStep = FILTER_MAX_RATE * Math.max(dt, 1 / 60);
    const value = stepToward(g.current, target, maxStep);
    if (value === g.current && g.maxTravel < TAP_MOVE) return;
    g.current = value;
    this.onEvent({ type: 'filter', object: g.object, hand, value });
  }

  /** Lift pose: raise to build (rate-limited). The drop is letting go (see release). */
  private adjustBuild(hand: HandId, g: BuildGrab, dt: number): void {
    const p = this.dragPoints.get(hand)!;
    if (this.build) this.build.point = { ...p };
    if (g.dropped) return;
    const target = clamp01((g.startY - p.y) / g.travel);
    const step = Math.max(dt, 1 / 60);
    const value = target > g.value ? Math.min(target, g.value + BUILD_RISE_RATE * step) : Math.max(target, g.value - BUILD_FALL_RATE * step);
    if (value !== g.value) {
      g.value = value;
      this.onEvent({ type: 'build', hand, value });
    }
    if (this.build) {
      this.build.value = value;
      this.build.state = value >= BUILD_MIN ? 'building' : 'armed';
    }
  }

  private fireDrop(hand: HandId, g: BuildGrab, t: number): void {
    g.dropped = true;
    this.lastDropT = t;
    if (this.build) this.build.state = 'dropped';
    this.onEvent({ type: 'drop', hand, build: g.value });
  }

  /**
   * Relative fader with a dead zone: small hand drift while pinching does
   * nothing, then LEVEL_TRAVEL of vertical movement sweeps the full range.
   */
  private adjustLevel(hand: HandId, g: LevelGrab, point: Point2): void {
    const dy = g.startY - point.y;
    const moved = Math.sign(dy) * Math.max(0, Math.abs(dy) - LEVEL_DEADZONE);
    const value = clamp01(g.startVolume + moved / LEVEL_TRAVEL);
    this.onEvent({ type: 'level', object: g.object, hand, value });
  }

  /** One hand: follow it. Two hands: follow their midpoint and stretch between them. */
  private follow(obj: HoloObject, points: Map<HandId, Point2>, dt: number): void {
    if (obj.locked) {
      this.holdLocked(obj, points, dt);
      return;
    }
    const anchor = this.anchor(obj, this.dragPoints);
    const offset = this.offsets.get(obj.id) ?? { x: 0, y: 0 };
    obj.position = { x: clamp01(anchor.x + offset.x), y: clamp01(anchor.y + offset.y) };
    obj.holdPoints = obj.holders.map((h) => ({ ...points.get(h)! }));

    for (const h of obj.holders) {
      const g = this.grabs.get(h);
      if (g?.kind === 'body') {
        const travel = Math.hypot((obj.position.x - g.startPos.x) * this.aspect, obj.position.y - g.startPos.y);
        g.maxTravel = Math.max(g.maxTravel, travel);
      }
    }

    if (obj.holders.length === 2) {
      const [a, b] = obj.holdPoints;
      // Pull apart to stretch further, push together to shrink.
      const base = this.stretchBase.get(obj.id) ?? { amount: obj.stretchAmount, span: this.span(obj, points) };
      obj.stretchAmount = clamp01(base.amount + (this.span(obj, points) - base.span) / STRETCH_GESTURE_SPAN);
      obj.stretch = { ends: [a, b] };
    }
  }

  /**
   * A locked stem stays in its slot. One hand: vertical movement sets the
   * volume (relative to where it grabbed, with a dead zone and a rate limit).
   * Two hands: their vertical spread stretches it taller (echo FX).
   */
  private holdLocked(obj: HoloObject, points: Map<HandId, Point2>, dt: number): void {
    obj.holdPoints = obj.holders.map((h) => ({ ...points.get(h)! }));
    for (const h of obj.holders) {
      const g = this.grabs.get(h);
      const p = this.dragPoints.get(h);
      if (g?.kind !== 'body' || !p) continue;
      // Taps are judged by how far the hand moved (the stem itself never moves).
      g.maxTravel = Math.max(g.maxTravel, Math.hypot((p.x - g.startHand.x) * this.aspect, p.y - g.startHand.y));
      if (obj.holders.length === 1) this.adjustVolume(h, g, p, dt);
    }
    if (obj.holders.length === 2) {
      const base = this.stretchBase.get(obj.id) ?? { amount: obj.stretchAmount, span: this.span(obj, points) };
      obj.stretchAmount = clamp01(base.amount + (this.span(obj, points) - base.span) / STRETCH_GESTURE_SPAN);
      const [a, b] = obj.holdPoints;
      obj.stretch = { ends: [a, b] };
    }
  }

  private adjustVolume(hand: HandId, g: BodyGrab, p: Point2, dt: number): void {
    const obj = g.object;
    const dy = g.startHand.y - p.y; // up = louder
    // Fader bars: the bar's top follows the hand 1:1 (full track = full range).
    const deadzone = obj.vertical ? BAR_DEADZONE : LEVEL_DEADZONE;
    const travel = obj.vertical ? 2 * obj.halfSize.y : LEVEL_TRAVEL;
    const moved = Math.sign(dy) * Math.max(0, Math.abs(dy) - deadzone);
    if (!g.volumeActive && moved === 0) return;
    g.volumeActive = true;
    const target = clamp01(g.startVolume + moved / travel);
    const value = stepToward(g.volumeValue, target, VOLUME_MAX_RATE * Math.max(dt, 1 / 60));
    obj.volumeAdjust = value;
    if (value === g.volumeValue) return;
    g.volumeValue = value;
    this.onEvent({ type: 'level', object: obj, hand, value });
  }

  /** Two different stems held one-per-hand form a blend pair; their hand spread sets isolation. */
  private updateBlend(points: Map<HandId, Point2>): void {
    const single = this.objects.filter((o) => o.holders.length === 1 && !o.vertical);
    const pair: [HoloObject, HoloObject] | null =
      single.length === 2 && single[0].holders[0] !== single[1].holders[0] ? [single[0], single[1]] : null;
    const same = pair && this.blendPair && pair[0] === this.blendPair[0] && pair[1] === this.blendPair[1];

    if (this.blendPair && !same) {
      this.onEvent({ type: 'blendEnd', object: this.blendPair[0], partner: this.blendPair[1] });
      this.blendPair = null;
      this.blendBase = null;
    }
    if (!pair) return;

    const pa = points.get(pair[0].holders[0])!;
    const pb = points.get(pair[1].holders[0])!;
    const span = Math.hypot((pa.x - pb.x) * this.aspect, pa.y - pb.y);
    if (!this.blendPair) {
      this.blendPair = pair;
      // Relative to where the hands are now, so grabbing two stems never jumps the mix.
      this.blendBase = { amount: this.isolation, span };
      this.onEvent({ type: 'blendStart', object: pair[0], partner: pair[1] });
    }
    this.isolation = clamp01(this.blendBase!.amount + (span - this.blendBase!.span) / BLEND_SPAN);
    const others = this.objects.filter((o) => o !== pair[0] && o !== pair[1]);
    this.onEvent({ type: 'blend', object: pair[0], partner: pair[1], value: this.isolation, others });
  }

  /**
   * Footprint (view-height units, relative to the center) used to keep stems
   * apart and on screen: body on the left, body + fader on the right, plus
   * room for the label above.
   */
  private footprint(obj: HoloObject): { left: number; right: number; y: number } {
    const body = effectiveHalfWidth(obj) + 0.01;
    if (obj.vertical) {
      // Caps above and below, plus the label on top.
      return { left: body, right: body, y: effectiveHalfHeight(obj) + CAP_GAP + CAP_RADIUS + 0.04 };
    }
    const caps = Math.abs(capOffset(obj, 'filter')) + CAP_RADIUS + 0.005;
    if (!LEVEL_HANDLE_ENABLED) return { left: caps, right: caps, y: effectiveHalfHeight(obj) + 0.035 };
    const { dx, halfLength } = levelHandle(obj);
    return { left: body, right: dx + 0.02, y: Math.max(obj.halfSize.y, halfLength) + 0.035 };
  }

  /** Flick glide, edge bounces, and soft separation so stems never overlap. */
  private stepPhysics(dt: number): void {
    if (dt <= 0) return;
    const a = this.aspect;
    const friction = Math.exp(-FLICK_FRICTION * dt);

    for (const obj of this.objects) {
      const v = this.velocity.get(obj.id);
      if (!v || obj.holders.length > 0) continue;
      obj.position = { x: obj.position.x + v.x * dt, y: obj.position.y + v.y * dt };
      v.x *= friction;
      v.y *= friction;
      if (Math.hypot(v.x * a, v.y) < 0.02) this.velocity.delete(obj.id);
      this.maybeReturnClip(obj); // thrown back into its source
    }

    // Separate overlapping footprints along the axis of least overlap.
    const k = 1 - Math.exp(-SEPARATE_RATE * dt);
    for (let i = 0; i < this.objects.length; i++) {
      for (let j = i + 1; j < this.objects.length; j++) {
        const p = this.objects[i];
        const q = this.objects[j];
        // A clip may overlap its own source (that's how it goes back in); returning clips are ghosts.
        if (p.clipOf === q.id || q.clipOf === p.id || p.returning || q.returning) continue;
        const pHeld = p.holders.length > 0 || p.levelHand !== null || p.locked;
        const qHeld = q.holders.length > 0 || q.levelHand !== null || q.locked;
        if (pHeld && qHeld) continue;
        const fp = this.footprint(p);
        const fq = this.footprint(q);
        const dx = (q.position.x - p.position.x) * a;
        const dy = q.position.y - p.position.y;
        // q right of p: p's right side meets q's left side, and vice versa.
        const ox = (dx >= 0 ? fp.right + fq.left : fp.left + fq.right) + STEM_GAP - Math.abs(dx);
        const oy = fp.y + fq.y + STEM_GAP - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        // Push along whichever axis needs the smaller move.
        const alongX = ox < oy;
        const sign = alongX ? Math.sign(dx) || 1 : Math.sign(dy) || 1;
        const push = (alongX ? ox : oy) * k;
        const share = pHeld ? [0, 1] : qHeld ? [1, 0] : [0.5, 0.5];
        const move = (obj: HoloObject, amount: number) => {
          if (alongX) obj.position = { x: obj.position.x + amount / a, y: obj.position.y };
          else obj.position = { x: obj.position.x, y: obj.position.y + amount };
          const v = this.velocity.get(obj.id);
          if (v) {
            if (alongX && Math.sign(v.x) !== Math.sign(amount)) v.x = -v.x * BOUNCE;
            if (!alongX && Math.sign(v.y) !== Math.sign(amount)) v.y = -v.y * BOUNCE;
          }
        };
        if (share[0]) move(p, -sign * push * share[0]);
        if (share[1]) move(q, sign * push * share[1]);
      }
    }

    // Keep every stem fully on screen; flicked ones bounce off the edges.
    for (const obj of this.objects) {
      if (obj.locked) continue;
      const f = this.footprint(obj);
      const minX = Math.min(0.5, f.left / a);
      const maxX = Math.max(0.5, 1 - f.right / a);
      const minY = Math.min(0.5, f.y);
      const x = Math.min(maxX, Math.max(minX, obj.position.x));
      const y = Math.min(1 - minY, Math.max(minY, obj.position.y));
      const v = this.velocity.get(obj.id);
      if (v && x !== obj.position.x) v.x = -v.x * BOUNCE;
      if (v && y !== obj.position.y) v.y = -v.y * BOUNCE;
      obj.position = { x, y };
    }
  }

  private stepReset(dt: number): void {
    const k = 1 - Math.exp(-RESET_RATE * dt);
    for (const [id, target] of this.resetTargets) {
      const obj = this.objects.find((o) => o.id === id);
      if (!obj || obj.holders.length > 0) {
        this.resetTargets.delete(id);
        continue;
      }
      obj.position = {
        x: obj.position.x + (target.x - obj.position.x) * k,
        y: obj.position.y + (target.y - obj.position.y) * k,
      };
      if (Math.hypot(target.x - obj.position.x, target.y - obj.position.y) < 0.001) {
        obj.position = { ...target };
        this.resetTargets.delete(id);
      }
    }
  }

  /** Distance between the two holding hands, view-height units. */
  /** Distance between the two holding hands, view-height units (vertical only for locked stems). */
  private span(obj: HoloObject, points: Map<HandId, Point2>): number {
    const [da, db] = obj.holders.map((h) => points.get(h)!);
    if (obj.locked) return Math.abs(da.y - db.y);
    return Math.hypot((da.x - db.x) * this.aspect, da.y - db.y);
  }

  private anchor(obj: HoloObject, points: Map<HandId, Point2>): Point2 {
    const ps = obj.holders.map((h) => points.get(h)!);
    return {
      x: ps.reduce((s, p) => s + p.x, 0) / ps.length,
      y: ps.reduce((s, p) => s + p.y, 0) / ps.length,
    };
  }

  private rebaseOffset(obj: HoloObject, _points: Map<HandId, Point2>): void {
    const anchor = this.anchor(obj, this.dragPoints);
    this.offsets.set(obj.id, { x: obj.position.x - anchor.x, y: obj.position.y - anchor.y });
  }

  // --- Hit testing -----------------------------------------------------------------

  /**
   * How far the point is outside the object's hitbox, in view-height units
   * (0 when inside), plus a normalized "how central" score for tie-breaking.
   */
  private hitMetrics(point: Point2, obj: HoloObject): { outside: number; centrality: number } {
    const dx = Math.abs(point.x - obj.position.x) * this.aspect;
    const dy = Math.abs(point.y - obj.position.y);
    const pad = obj.vertical ? BAR_HIT_PAD : HIT_PAD;
    const hx = effectiveHalfWidth(obj) + pad.x;
    const hy = effectiveHalfHeight(obj) + pad.y;
    const outside = Math.hypot(Math.max(0, dx - hx), Math.max(0, dy - hy));
    return { outside, centrality: Math.max(dx / hx, dy / hy) };
  }

  private onHandle(point: Point2, obj: HoloObject): boolean {
    const { dx, halfLength } = levelHandle(obj);
    const hx = obj.position.x + dx / this.aspect;
    return (
      Math.abs(point.x - hx) * this.aspect <= HANDLE_HIT.halfWidth &&
      Math.abs(point.y - obj.position.y) <= halfLength + HANDLE_HIT.pad
    );
  }

  /** Object whose level handle is under the point and free to grab. */
  private pickHandle(point: Point2): HoloObject | null {
    if (!LEVEL_HANDLE_ENABLED) return null;
    for (const obj of this.objects) {
      if (obj.levelHand || obj.holders.length > 0) continue;
      if (this.onHandle(point, obj)) return obj;
    }
    return null;
  }

  /** Distance from a point to a cap's center minus the cap hit radius (<= 0 means on it), view-height units. */
  private capDistance(point: Point2, obj: HoloObject, kind: StemControl): number {
    const c = capCenter(obj, kind);
    const cx = obj.position.x + c.dx / this.aspect;
    return Math.hypot((point.x - cx) * this.aspect, point.y - (obj.position.y + c.dy)) - CAP_HIT;
  }

  /** Nearest free stem cap under the point. Caps only work on stems nobody is holding. */
  private pickCap(point: Point2): { obj: HoloObject; kind: StemControl } | null {
    let best: { obj: HoloObject; kind: StemControl } | null = null;
    let bestD = 0;
    for (const obj of this.objects) {
      if (obj.holders.length > 0 || obj.levelHand || obj.control || obj.returning) continue;
      for (const kind of ['loop', 'filter'] as const) {
        if (!hasCap(obj, kind)) continue;
        const d = this.capDistance(point, obj, kind);
        if (d <= bestD) {
          best = { obj, kind };
          bestD = d;
        }
      }
    }
    return best;
  }

  /** A stem held by exactly one hand, near enough for a second hand to join and stretch it. */
  private pickStretchJoin(point: Point2): HoloObject | null {
    let best: HoloObject | null = null;
    let bestOutside = GRAB_REACH + STRETCH_JOIN_REACH;
    for (const obj of this.objects) {
      if (obj.holders.length !== 1 || obj.levelHand || obj.control || obj.returning || obj.vertical) continue;
      const { outside } = this.hitMetrics(point, obj);
      if (outside <= bestOutside) {
        best = obj;
        bestOutside = outside;
      }
    }
    return best;
  }

  /** Best object with a free body slot whose hitbox contains the point. */
  private pick(point: Point2): HoloObject | null {
    let best: HoloObject | null = null;
    let bestScore = Infinity;
    for (const obj of this.objects) {
      if (!canTake(obj) || obj.levelHand || obj.control || obj.returning || obj.vertical) continue;
      const { outside, centrality } = this.hitMetrics(point, obj);
      if (outside === 0 && centrality < bestScore) {
        best = obj;
        bestScore = centrality;
      }
    }
    return best;
  }

  /**
   * Sticky targeting: enter on hitbox entry, exit only once clearly outside.
   * Uses the aim from just before any closing motion, so closing your fingers
   * can't drag the aim onto a different object.
   */
  private updateTargets(frame: PerceptionFrame, t: number): void {
    for (const hand of frame.hands) {
      if (this.grabs.has(hand.id) || !hand.tracked) continue;
      const g = hand[this.gesture];
      const aim =
        g.strength > CLOSING_STRENGTH ? (sampleAt(this.aimHistory.get(hand.id), t - AIM_LOOKBACK_MS) ?? g.point) : g.point;
      const current = this.targets.get(hand.id);
      const available = current && canTake(current) && !current.levelHand && !current.control;
      if (available && this.hitMetrics(aim, current).outside <= TARGET_EXIT) continue;
      const next = this.pick(aim);
      if (next) this.targets.set(hand.id, next);
      else this.targets.delete(hand.id);
    }
    for (const id of [...this.targets.keys()]) {
      if (this.grabs.has(id) || !frame.hands.some((h) => h.id === id)) this.targets.delete(id);
    }
  }

  /** Proximity glow from free hands; full glow + grab intent on the sticky target. */
  private updateHover(frame: PerceptionFrame): void {
    for (const obj of this.objects) {
      obj.hover = 0;
      obj.handleHover = 0;
      obj.intent = 0;
      obj.capHover = { loop: 0, filter: 0 };
    }
    for (const hand of frame.hands) {
      if (!hand.tracked || this.grabs.has(hand.id)) continue;
      const g = hand[this.gesture];
      // Controls first: when over one, it (not the stem body) is what this hand would grab.
      const cap = this.pickCap(g.point);
      if (cap) {
        cap.obj.capHover[cap.kind] = 1;
        continue;
      }
      for (const obj of this.objects) {
        if (obj.holders.length > 0 || obj.control || obj.returning) continue;
        for (const kind of ['loop', 'filter'] as const) {
          if (!hasCap(obj, kind)) continue;
          const d = this.capDistance(g.point, obj, kind);
          obj.capHover[kind] = Math.max(obj.capHover[kind], 0.5 * (1 - Math.min(1, d / HOVER_FALLOFF)));
        }
      }
      const overHandle = this.pickHandle(g.point);
      if (overHandle) {
        overHandle.handleHover = 1;
        continue; // the handle, not the body, is what this hand would grab
      }
      const target = this.targets.get(hand.id);
      if (target) {
        target.hover = 1;
        target.intent = Math.max(target.intent, g.strength);
      }
      for (const obj of this.objects) {
        if (obj === target || obj.holders.length >= 2) continue;
        const { outside } = this.hitMetrics(g.point, obj);
        obj.hover = Math.max(obj.hover, 0.6 * (1 - Math.min(1, outside / HOVER_FALLOFF)));
      }
    }
  }
}

function record(history: Map<string, Sample[]>, key: string, t: number, p: Point2): void {
  const list = history.get(key) ?? [];
  list.push({ t, p: { ...p } });
  while (list.length > 1 && t - list[0].t > HISTORY_MS) list.shift();
  history.set(key, list);
}

/** Timestamp of the sample sampleAt(list, t) would return. */
function sampleTime(list: Sample[] | undefined, t: number): number {
  if (!list || list.length === 0) return t;
  let best = list[0];
  for (const s of list) if (s.t <= t) best = s;
  return best.t;
}

/** Latest sample at or before time t (oldest available if none that old). */
function sampleAt(list: Sample[] | undefined, t: number): Point2 | null {
  if (!list || list.length === 0) return null;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].t <= t) return list[i].p;
  return list[0].p;
}

/** Move toward target by at most maxStep, landing exactly on it. */
function stepToward(from: number, target: number, maxStep: number): number {
  const d = target - from;
  return Math.abs(d) <= maxStep ? target : from + Math.sign(d) * maxStep;
}

/** Whether another hand may grab this object: fader bars take one hand, other stems two (stretch). */
function canTake(obj: HoloObject): boolean {
  return obj.vertical ? obj.holders.length === 0 : obj.holders.length < 2;
}

/** Distance (view-height units) between two view-space points. */
function viewDist(a: Point2, b: Point2, aspect: number): number {
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y);
}

/** Wrap an angle difference into (-π, π]. */
function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function isCap(g: Grab): g is CapGrab {
  return g.kind === 'loop' || g.kind === 'filter';
}

function loopIndex(beats: LoopBeats | null): number {
  return Math.max(0, LOOP_OPTIONS.indexOf(beats));
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
