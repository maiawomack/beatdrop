import type { DeckId, TrackInfo } from '../shared/types';
import './SearchBar.css';

export interface SearchBarOptions {
  /** Any track source (the local library today). Must honour `signal`. */
  search: (query: string, signal: AbortSignal) => Promise<TrackInfo[]>;
  onSelect: (track: TrackInfo, deck: DeckId) => void;
  /** Extra per-result buttons, e.g. download. Errors thrown by `run` show in the status line. */
  extraActions?: SearchAction[];
  placeholder?: string;
  debounceMs?: number;
  /** 0 lists every track when the query is empty (and on focus). */
  minChars?: number;
}

export interface SearchAction {
  label: string;
  title: string;
  /** Hide the button for tracks it doesn't apply to. */
  isAvailable?: (track: TrackInfo) => boolean;
  /** Return a message to show in the status line on success. */
  run: (track: TrackInfo) => void | string | Promise<void | string>;
}

export interface SearchBar {
  readonly element: HTMLElement;
  focus(): void;
  clear(): void;
  /** Re-runs the current query, e.g. after files were added to the library. */
  refresh(): void;
  setDisabled(disabled: boolean, message?: string): void;
  destroy(): void;
}

let instanceCount = 0;

/**
 * Framework-free track search. Styling lives entirely in SearchBar.css (`bd-search*`
 * classes and `--bd-search-*` custom properties) so the DJ UI can restyle it.
 *
 * Keyboard: ↑/↓ choose a result · Enter loads it to deck A · Shift+Enter to deck B · Esc clears.
 */
export function createSearchBar(options: SearchBarOptions): SearchBar {
  const {
    search,
    onSelect,
    extraActions = [],
    placeholder = 'Search songs…',
    debounceMs = 300,
    minChars = 2,
  } = options;
  const listId = `bd-search-results-${++instanceCount}`;

  const root = el('div', 'bd-search');
  const input = el('input', 'bd-search__input');
  input.type = 'search';
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-controls', listId);
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-autocomplete', 'list');

  const status = el('div', 'bd-search__status');
  status.setAttribute('aria-live', 'polite');

  const list = el('ul', 'bd-search__results');
  list.id = listId;
  list.setAttribute('role', 'listbox');

  root.append(input, status, list);

  let results: TrackInfo[] = [];
  let active = -1;
  let timer: number | undefined;
  let inflight: AbortController | null = null;
  let disabled = false;

  function setStatus(text: string, kind: 'idle' | 'loading' | 'error' = 'idle'): void {
    status.textContent = text;
    status.dataset.kind = kind;
  }

  function render(): void {
    list.replaceChildren(
      ...results.map((track, i) => {
        const item = el('li', 'bd-search__item');
        item.id = `${listId}-${i}`;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(i === active));

        const art = el('img', 'bd-search__art');
        art.alt = '';
        art.loading = 'lazy';
        if (track.artworkUrl) art.src = track.artworkUrl;

        const meta = el('div', 'bd-search__meta');
        const title = el('span', 'bd-search__title');
        title.textContent = track.title;
        const artist = el('span', 'bd-search__artist');
        artist.textContent = track.artists.join(', ');
        meta.append(title, artist);

        const badge = el('span', 'bd-search__badge');
        badge.textContent = track.stems ? 'stems' : '';
        badge.hidden = !track.stems;

        const duration = el('span', 'bd-search__duration');
        duration.textContent = track.durationMs === null ? '' : formatDuration(track.durationMs);

        const actions = el('div', 'bd-search__actions');
        for (const deck of ['A', 'B'] as const) {
          const button = el('button', 'bd-search__load');
          button.type = 'button';
          button.dataset.deck = deck;
          button.textContent = deck;
          button.title = `Load to deck ${deck}`;
          button.addEventListener('click', () => select(i, deck));
          actions.append(button);
        }
        for (const action of extraActions) {
          if (action.isAvailable && !action.isAvailable(track)) continue;
          const button = el('button', 'bd-search__action');
          button.type = 'button';
          button.textContent = action.label;
          button.title = action.title;
          button.addEventListener('click', () => void runAction(action, track, button));
          actions.append(button);
        }

        item.addEventListener('mouseenter', () => setActive(i));
        art.hidden = !track.artworkUrl;
        item.append(art, meta, badge, duration, actions);
        return item;
      }),
    );
    const open = results.length > 0;
    root.classList.toggle('bd-search--open', open);
    input.setAttribute('aria-expanded', String(open));
    if (active >= 0) input.setAttribute('aria-activedescendant', `${listId}-${active}`);
    else input.removeAttribute('aria-activedescendant');
  }

  function setActive(index: number): void {
    active = results.length === 0 ? -1 : (index + results.length) % results.length;
    list.querySelectorAll<HTMLElement>('.bd-search__item').forEach((node, i) => {
      node.setAttribute('aria-selected', String(i === active));
    });
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', `${listId}-${active}`);
      list.children[active]?.scrollIntoView({ block: 'nearest' });
    }
  }

  function select(index: number, deck: DeckId): void {
    const track = results[index];
    if (!track) return;
    onSelect(track, deck);
    setStatus(`Loaded “${track.title}” to deck ${deck}`);
  }

  async function runAction(action: SearchAction, track: TrackInfo, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    setStatus(`${action.title}: “${track.title}”…`, 'loading');
    try {
      const message = await action.run(track);
      setStatus(message || `${action.title}: done`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : `${action.title} failed`, 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function run(query: string): Promise<void> {
    inflight?.abort();
    if (query.length < minChars) {
      results = [];
      active = -1;
      render();
      setStatus('');
      return;
    }
    const controller = new AbortController();
    inflight = controller;
    setStatus('Searching…', 'loading');
    try {
      const found = await search(query, controller.signal);
      if (controller.signal.aborted) return;
      results = found;
      active = found.length > 0 ? 0 : -1;
      render();
      setStatus(found.length === 0 ? 'No results' : '');
    } catch (err) {
      if (controller.signal.aborted) return;
      setStatus(err instanceof Error ? err.message : 'Search failed', 'error');
    } finally {
      if (inflight === controller) inflight = null;
    }
  }

  function clear(): void {
    window.clearTimeout(timer);
    inflight?.abort();
    input.value = '';
    results = [];
    active = -1;
    render();
    setStatus('');
  }

  const onInput = (): void => {
    window.clearTimeout(timer);
    const query = input.value.trim();
    timer = window.setTimeout(() => void run(query), debounceMs);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    // Keep DJ shortcuts from firing while typing.
    e.stopPropagation();
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive(active + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive(active - 1);
        break;
      case 'Enter':
        e.preventDefault();
        if (active >= 0) select(active, e.shiftKey ? 'B' : 'A');
        break;
      case 'Escape':
        e.preventDefault();
        if (input.value || results.length) clear();
        else input.blur();
        break;
    }
  };

  const onFocus = (): void => {
    if (minChars === 0 && results.length === 0) void run(input.value.trim());
  };

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKeyDown);
  input.addEventListener('focus', onFocus);

  return {
    element: root,
    focus: () => input.focus(),
    clear,
    refresh: () => void run(input.value.trim()),
    setDisabled(value, message) {
      if (value && !disabled) clear();
      disabled = value;
      input.disabled = disabled;
      root.classList.toggle('bd-search--disabled', disabled);
      if (message !== undefined) setStatus(message);
    },
    destroy() {
      clear();
      input.removeEventListener('input', onInput);
      input.removeEventListener('keydown', onKeyDown);
      input.removeEventListener('focus', onFocus);
      root.remove();
    },
  };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
