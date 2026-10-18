import { useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { STEM_IDS, type DeckState, type StemId } from '../../shared/types';
import type { EngineStore } from '../engineStore';
import { useAnimationFrame } from '../hooks';
import { STEM_COLORS, STEM_LABELS } from '../theme';

interface Props {
  deck: DeckState;
  engine: EngineStore;
  /** Keyboard key that toggles each stem's mute, shown on its button. */
  muteKeys: Record<StemId, string>;
}

/**
 * One filled fader per stem: the colored fill is the stem's volume (drag to change it),
 * the glowing core inside it is the live level. The button underneath mutes the stem.
 */
export function StemBars({ deck, engine, muteKeys }: Props) {
  // A full-mix track has no separate stems yet: the faders do nothing until it's split.
  const split = deck.source !== 'full';
  const meters = useRef<Partial<Record<StemId, HTMLDivElement | null>>>({});
  const shown = useRef<Record<StemId, number>>({ vocals: 0, drums: 0, bass: 0, instrumental: 0 });

  useAnimationFrame(() => {
    const levels = engine.levels(deck.id);
    for (const stem of STEM_IDS) {
      // Fast attack, slow release, like a real meter.
      const level = Math.max(levels[stem], shown.current[stem] * 0.9);
      shown.current[stem] = level;
      const el = meters.current[stem];
      const volume = deck.stems[stem].gain;
      if (el) el.style.height = `${volume > 0 ? Math.min(1, level / volume) * 100 : 0}%`;
    }
  });

  const dragVolume = (stem: StemId) => (e: ReactPointerEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    const apply = (clientY: number) => {
      const box = target.getBoundingClientRect();
      const volume = 1 - (clientY - box.top) / box.height;
      engine.dispatch({ type: 'SET_STEM_GAIN', deck: deck.id, stem, gain: volume });
    };
    target.setPointerCapture(e.pointerId);
    apply(e.clientY);
    target.onpointermove = (ev) => apply(ev.clientY);
    target.onpointerup = () => {
      target.onpointermove = null;
      target.onpointerup = null;
    };
  };

  return (
    <div className={`stems${split ? '' : ' unsplit'}`} title={split ? undefined : 'Split this song into stems to use these'}>
      {STEM_IDS.map((stem) => {
        const { muted, gain: volume } = deck.stems[stem];
        return (
          <div key={stem} className={`stem${muted ? ' muted' : ''}`} style={{ '--c': STEM_COLORS[stem] } as CSSProperties}>
            <div
              className="fader"
              onPointerDown={split ? dragVolume(stem) : undefined}
              title={split ? `Drag to set ${STEM_LABELS[stem]} volume` : undefined}
            >
              <div className="fill" style={{ height: `${volume * 100}%` }}>
                <div className="meter" ref={(el) => (meters.current[stem] = el)} />
              </div>
              <div className="rungs" />
              <span className="pct">{Math.round(volume * 100)}</span>
            </div>
            <button
              className="mute"
              onClick={() => engine.dispatch({ type: 'SET_STEM_MUTE', deck: deck.id, stem, muted: !muted })}
              disabled={!split}
              title={muted ? `Unmute ${STEM_LABELS[stem]}` : `Mute ${STEM_LABELS[stem]}`}
            >
              <span>{muted ? 'Muted' : STEM_LABELS[stem]}</span>
              <kbd>{muteKeys[stem]}</kbd>
            </button>
          </div>
        );
      })}
    </div>
  );
}
