import { useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { STEM_IDS, type AudioController, type DeckState, type StemId } from '../../shared/contracts';
import { useAnimationFrame } from '../hooks';
import { STEM_COLORS, STEM_LABELS } from '../theme';

interface Props {
  deck: DeckState;
  controller: AudioController;
  /** Keyboard key that toggles each stem's mute, shown on its button. */
  muteKeys: Record<StemId, string>;
}

/**
 * One filled fader per stem: the colored fill is the stem's volume (drag to change it),
 * the glowing core inside it is the live level. The button underneath mutes the stem.
 */
export function StemBars({ deck, controller, muteKeys }: Props) {
  const meters = useRef<Partial<Record<StemId, HTMLDivElement | null>>>({});
  const shown = useRef<Record<StemId, number>>({ vocals: 0, drums: 0, bass: 0, instrumental: 0 });

  useAnimationFrame(() => {
    const levels = controller.getLevels(deck.id);
    for (const stem of STEM_IDS) {
      // Fast attack, slow release, like a real meter.
      const level = Math.max(levels[stem], shown.current[stem] * 0.9);
      shown.current[stem] = level;
      const el = meters.current[stem];
      const volume = deck.stems[stem].volume;
      if (el) el.style.height = `${volume > 0 ? Math.min(1, level / volume) * 100 : 0}%`;
    }
  });

  const dragVolume = (stem: StemId) => (e: ReactPointerEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    const apply = (clientY: number) => {
      const box = target.getBoundingClientRect();
      const volume = 1 - (clientY - box.top) / box.height;
      controller.dispatch({ type: 'stem/setVolume', deck: deck.id, stem, volume });
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
    <div className="stems">
      {STEM_IDS.map((stem) => {
        const { muted, volume } = deck.stems[stem];
        return (
          <div key={stem} className={`stem${muted ? ' muted' : ''}`} style={{ '--c': STEM_COLORS[stem] } as CSSProperties}>
            <div className="fader" onPointerDown={dragVolume(stem)} title={`Drag to set ${STEM_LABELS[stem]} volume`}>
              <div className="fill" style={{ height: `${volume * 100}%` }}>
                <div className="meter" ref={(el) => (meters.current[stem] = el)} />
              </div>
              <div className="rungs" />
              <span className="pct">{Math.round(volume * 100)}</span>
            </div>
            <button
              className="mute"
              onClick={() => controller.dispatch({ type: 'stem/setMuted', deck: deck.id, stem, muted: !muted })}
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
