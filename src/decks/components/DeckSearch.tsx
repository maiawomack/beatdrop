import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { searchLibrary, separateTrack } from '../../library/api';
import type { DeckId, TrackInfo } from '../../shared/types';
import { fetchTrackIndex, separateAudio, type SeparationJob } from '../../stems';
import { formatTime, trackLabel } from '../hooks';

export interface DeckSearchHandle {
  focus(): void;
  /** Split a library track that's only a full mix, then load it with stems. */
  split(track: TrackInfo): void;
  /** Split a dropped audio file and load it onto this deck. */
  separateFile(file: File): void;
}

interface Props {
  deck: DeckId;
  current: TrackInfo | null;
  serverReady: boolean | null;
  onLoad(track: TrackInfo): void;
}

interface Job {
  name: string;
  progress: number;
  error: string | null;
}

/** All split tracks, including ones whose song file isn't in mp3/ (served by the library). */
const STEMS_INDEX = '/api/library/stems/index.json';

/** The stems folder id inside a manifest URL (".../<id>/manifest.json"). */
function stemsIdOf(manifestUrl: string | null): string | null {
  return manifestUrl?.match(/([^/]+)\/manifest\.json$/)?.[1] ?? null;
}

/**
 * Everything playable: Task 1's library (mp3/, full mix or split) plus songs that were
 * split from files outside the library (dropped files, CLI runs), which only exist as stems.
 */
async function loadCatalog(signal: AbortSignal): Promise<TrackInfo[]> {
  const [library, index] = await Promise.all([
    searchLibrary('', signal),
    fetchTrackIndex(`${STEMS_INDEX}?ts=${Date.now()}`, signal).catch(() => []),
  ]);
  const linked = new Set(library.map((t) => stemsIdOf(t.stemsManifestUrl)).filter(Boolean));
  const stemsOnly: TrackInfo[] = index
    .filter((e) => !linked.has(e.id))
    .map((e) => ({
      id: `stems-${e.id}`,
      title: e.title,
      artists: e.artist && e.artist !== 'Unknown Artist' ? [e.artist] : [],
      album: null,
      artworkUrl: null,
      durationMs: Math.round(e.durationSec * 1000),
      fileName: e.id,
      audioUrl: null,
      stemsManifestUrl: e.manifestUrl,
      bpm: e.bpm,
    }));
  return [...library, ...stemsOnly];
}

/**
 * The deck's search bar. Idle, it shows the loaded song. Type to filter; Enter loads,
 * Shift+Enter (or the Split button) splits a full-mix song into stems first.
 */
export const DeckSearch = forwardRef<DeckSearchHandle, Props>(function DeckSearch(props, ref) {
  const { deck, current, serverReady, onLoad } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [catalog, setCatalog] = useState<TrackInfo[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async (signal = new AbortController().signal) => {
    const tracks = await loadCatalog(signal);
    setCatalog(tracks);
    return tracks;
  }, []);

  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    refresh(abort.signal).catch(() => {});
    return () => abort.abort();
  }, [open, refresh]);

  const results = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return catalog.filter((t) => {
      const haystack = `${t.artists.join(' ')} ${t.title} ${t.fileName}`.toLowerCase();
      return words.every((w) => haystack.includes(w));
    });
  }, [catalog, query]);
  const uploadRow = results.length;

  const close = () => {
    setOpen(false);
    input.current?.blur();
  };

  /** Runs a separation, then loads whichever catalog entry now has its stems. */
  const runSplit = async (name: string, work: (onProgress: (j: SeparationJob) => void) => Promise<string | null>) => {
    close();
    setJob({ name, progress: 0, error: null });
    try {
      let trackId: string | null = null;
      const knownId = await work((j) => {
        trackId = j.trackId;
        setJob({ name, progress: j.progress, error: null });
      });
      const tracks = await refresh();
      const match = knownId
        ? tracks.find((t) => t.id === knownId && t.stemsManifestUrl)
        : tracks.find((t) => trackId && stemsIdOf(t.stemsManifestUrl) === trackId);
      if (!match) throw new Error('separated, but the stems did not show up in the library');
      onLoad(match);
      setJob(null);
    } catch (err) {
      setJob({ name, progress: 0, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const split = (track: TrackInfo) =>
    void runSplit(track.title, async (onProgress) => {
      await separateTrack(track, onProgress);
      return track.id;
    });

  const separateFile = (file: File) =>
    void runSplit(file.name, async (onProgress) => {
      await separateAudio(file, { onProgress, saveToLibrary: true });
      return null;
    });

  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus(), split, separateFile }));

  const choose = (index: number, splitFirst = false) => {
    if (index === uploadRow) {
      filePicker.current?.click();
      return;
    }
    const track = results[index];
    if (!track) return;
    if (splitFirst && !track.stemsManifestUrl) split(track);
    else {
      onLoad(track);
      close();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') setHighlight((i) => Math.min(uploadRow, i + 1));
    else if (e.key === 'ArrowUp') setHighlight((i) => Math.max(0, i - 1));
    else if (e.key === 'Enter') choose(highlight, e.shiftKey);
    else if (e.key === 'Escape') close();
    else return;
    e.preventDefault();
  };

  const idleText = job
    ? job.error
      ? `Couldn't split ${job.name}: ${job.error}`
      : `Splitting ${job.name} into stems… ${Math.round(job.progress * 100)}%`
    : current
      ? trackLabel(current)
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
          if (file) separateFile(file);
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
              <span className="r-artist">{t.artists.join(', ') || t.fileName}</span>
              <span className="r-num">{t.bpm ? t.bpm.toFixed(1) : '—'}</span>
              <span className="r-num dim">{t.durationMs ? formatTime(t.durationMs / 1000) : ''}</span>
              <span className="r-source">
                {t.stemsManifestUrl ? (
                  <span className="badge-stems">stems</span>
                ) : (
                  <button
                    className="split"
                    disabled={serverReady === false}
                    onClick={(e) => {
                      e.stopPropagation();
                      split(t);
                    }}
                    title={serverReady === false ? 'Start the separation server first' : 'Split into stems (Shift+Enter)'}
                  >
                    full mix · Split
                  </button>
                )}
              </span>
            </li>
          ))}
          {results.length === 0 && <li className="empty">{catalog.length ? `No songs match “${query}”` : 'Loading library…'}</li>}
          <li
            className={`upload${highlight === uploadRow ? ' hl' : ''}`}
            onMouseEnter={() => setHighlight(uploadRow)}
            onClick={() => choose(uploadRow)}
          >
            + Split a song file from your computer
            <span className="r-artist">
              {serverReady === false ? 'separation server offline' : 'or drop a file on this deck · Shift+Enter splits a full mix'}
            </span>
          </li>
        </ul>
      )}
    </div>
  );
});
