import { forwardRef, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { DeckId, LoadedTrackInfo } from '../../shared/contracts';
import { separateAudio, type ResolvedTrackIndexEntry } from '../../stems';
import { formatTime } from '../hooks';

export interface DeckSearchHandle {
  focus(): void;
  /** Separate a dropped file and load it onto this deck when it's ready. */
  separate(file: File): void;
}

interface Props {
  deck: DeckId;
  current: LoadedTrackInfo | null;
  tracks: ResolvedTrackIndexEntry[];
  serverReady: boolean | null;
  onLoad(track: ResolvedTrackIndexEntry): void;
  /** Called after a new song is separated; resolves once the track list includes it. */
  onSeparated(trackId: string): Promise<ResolvedTrackIndexEntry | undefined>;
}

/**
 * The deck's search bar. Shows the loaded track when idle; type to filter the library,
 * ↑/↓ + Enter to load, Esc to leave. The last row splits a new song into stems.
 */
export const DeckSearch = forwardRef<DeckSearchHandle, Props>(function DeckSearch(props, ref) {
  const { deck, current, tracks, serverReady, onLoad, onSeparated } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [job, setJob] = useState<{ name: string; progress: number; error: string | null } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? tracks.filter((t) => `${t.title} ${t.artist}`.toLowerCase().includes(q)) : tracks;
  }, [tracks, query]);
  const uploadRow = results.length; // index of the "split a new song" row

  const separate = async (file: File) => {
    setOpen(false);
    input.current?.blur();
    setJob({ name: file.name, progress: 0, error: null });
    try {
      let trackId = '';
      await separateAudio(file, {
        onProgress: (j) => {
          trackId = j.trackId;
          setJob({ name: file.name, progress: j.progress, error: null });
        },
      });
      const entry = await onSeparated(trackId);
      if (entry) onLoad(entry);
      setJob(null);
    } catch (err) {
      setJob({ name: file.name, progress: 0, error: err instanceof Error ? err.message : String(err) });
    }
  };

  useImperativeHandle(ref, () => ({
    focus: () => input.current?.focus(),
    separate: (file) => void separate(file),
  }));

  const choose = (index: number) => {
    if (index === uploadRow) {
      filePicker.current?.click();
      return;
    }
    const track = results[index];
    if (!track) return;
    onLoad(track);
    setOpen(false);
    input.current?.blur();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') setHighlight((i) => Math.min(uploadRow, i + 1));
    else if (e.key === 'ArrowUp') setHighlight((i) => Math.max(0, i - 1));
    else if (e.key === 'Enter') choose(highlight);
    else if (e.key === 'Escape') input.current?.blur();
    else return;
    e.preventDefault();
  };

  const idleText = job
    ? job.error
      ? `Couldn't split ${job.name}: ${job.error}`
      : `Splitting ${job.name}… ${Math.round(job.progress * 100)}%`
    : current
      ? `${current.title} — ${current.artist}`
      : '';

  return (
    <div className={`search${open ? ' open' : ''}${job?.error ? ' failed' : ''}`}>
      {job && !job.error && <div className="search-progress" style={{ width: `${job.progress * 100}%` }} />}
      <svg className="search-icon" viewBox="0 0 24 24" aria-hidden>
        <circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" strokeWidth="2.6" />
        <line x1="15" y1="15" x2="21" y2="21" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
      </svg>
      <input
        ref={input}
        value={open ? query : idleText}
        placeholder={open ? 'Search songs' : `Load a song on deck ${deck}`}
        onFocus={() => {
          setOpen(true);
          setQuery('');
          setHighlight(0);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlight(0);
        }}
        onKeyDown={onKeyDown}
        spellCheck={false}
        aria-label={`Search songs for deck ${deck}`}
      />
      <kbd>{deck === 'A' ? '[' : ']'}</kbd>
      <input
        ref={filePicker}
        type="file"
        accept="audio/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void separate(file);
          e.target.value = '';
        }}
      />

      {open && (
        <ul className="results" onMouseDown={(e) => e.preventDefault()}>
          {results.map((t, i) => (
            <li
              key={t.id}
              className={i === highlight ? 'hl' : ''}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => choose(i)}
            >
              <span className="r-title">{t.title}</span>
              <span className="r-artist">{t.artist}</span>
              <span className="r-num">{t.bpm.toFixed(1)}</span>
              <span className="r-num dim">{formatTime(t.durationSec)}</span>
            </li>
          ))}
          {results.length === 0 && <li className="empty">No songs match “{query}”</li>}
          <li
            className={`upload${highlight === uploadRow ? ' hl' : ''}`}
            onMouseEnter={() => setHighlight(uploadRow)}
            onClick={() => choose(uploadRow)}
          >
            + Split a new song into stems
            <span className="r-artist">
              {serverReady === false ? 'separation server offline' : 'or drop a file on this deck'}
            </span>
          </li>
        </ul>
      )}
    </div>
  );
});
