import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Plugin } from 'vite';

/**
 * Local music library served by the Vite dev/preview server.
 *
 * Drop audio files into `libraryDir` (subfolders are fine). Files are rescanned on
 * every request, so new uploads appear without restarting. Metadata comes from the
 * filename: "Artist - Title.mp3" (anything without " - " uses the whole name as title).
 *
 * Stems for a track go in `stemsDir/<track id>/` (or a folder named exactly like the
 * audio file without its extension). Files named vocals/drums/bass/instrumental
 * (or "other" for instrumental) are detected automatically; a manifest.json such as
 * { "vocals": "v.wav" } overrides detection.
 *
 *   GET /api/library?q=<search>          → { tracks: LibraryTrack[] }
 *   GET /api/library/audio/<id>          → full mix (Range supported)
 *   GET /api/library/stems/<id>/<stem>   → one stem (Range supported)
 */

const AUDIO_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
};

const STEM_KEYS = ['vocals', 'drums', 'bass', 'instrumental'] as const;
type StemKey = (typeof STEM_KEYS)[number];
const STEM_ALIASES: Record<string, StemKey> = {
  vocals: 'vocals',
  vocal: 'vocals',
  drums: 'drums',
  bass: 'bass',
  instrumental: 'instrumental',
  other: 'instrumental',
};

interface LibraryEntry {
  id: string;
  /** Path relative to libraryDir, for display. */
  fileName: string;
  absPath: string;
  title: string;
  artists: string[];
  stems: Partial<Record<StemKey, string>>;
}

/** Shape sent to the browser; matches TrackInfo in src/shared/types.ts. */
interface LibraryTrack {
  id: string;
  title: string;
  artists: string[];
  album: string | null;
  artworkUrl: string | null;
  durationMs: number | null;
  fileName: string;
  audioUrl: string;
  stems: Partial<Record<StemKey, string>> | null;
  bpm: number | null;
}

export function audioLibrary(options: { libraryDir: string; stemsDir: string }): Plugin {
  const { libraryDir, stemsDir } = options;

  const handler = (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const url = new URL(req.url ?? '/', 'http://local');
    const parts = url.pathname.split('/').filter(Boolean).map(safeDecode); // ['api','library',...]
    if (parts[0] !== 'api' || parts[1] !== 'library' || (req.method !== 'GET' && req.method !== 'HEAD')) return next();

    route(req, res, url, parts).catch((err) => sendJson(res, 500, { error: errorMessage(err) }));
  };

  async function route(req: IncomingMessage, res: ServerResponse, url: URL, parts: string[]): Promise<void> {
    const entries = await scan(libraryDir, stemsDir);

    if (parts.length === 2) {
      const tokens = (url.searchParams.get('q') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const tracks = entries
        .filter((e) => {
          const haystack = `${e.artists.join(' ')} ${e.title} ${e.fileName}`.toLowerCase();
          return tokens.every((t) => haystack.includes(t));
        })
        .map(toTrack);
      return sendJson(res, 200, { tracks });
    }

    const entry = entries.find((e) => e.id === parts[3]);
    if (!entry) return sendJson(res, 404, { error: 'Track not found' });

    if (parts[2] === 'audio' && parts.length === 4) return sendFile(req, res, entry.absPath);
    if (parts[2] === 'stems' && parts.length === 5) {
      const file = entry.stems[parts[4] as StemKey];
      if (!file) return sendJson(res, 404, { error: 'Stem not found' });
      return sendFile(req, res, file);
    }
    return sendJson(res, 404, { error: 'Not found' });
  }

  return {
    name: 'beatdrop-audio-library',
    configureServer: (server) => void server.middlewares.use(handler),
    configurePreviewServer: (server) => void server.middlewares.use(handler),
  };
}

function toTrack(e: LibraryEntry): LibraryTrack {
  const base = `/api/library/stems/${encodeURIComponent(e.id)}`;
  const stems: Partial<Record<StemKey, string>> = {};
  for (const key of STEM_KEYS) if (e.stems[key]) stems[key] = `${base}/${key}`;
  return {
    id: e.id,
    title: e.title,
    artists: e.artists,
    album: null,
    artworkUrl: null,
    durationMs: null,
    fileName: e.fileName,
    audioUrl: `/api/library/audio/${encodeURIComponent(e.id)}`,
    stems: Object.keys(stems).length > 0 ? stems : null,
    bpm: null,
  };
}

// --- Scanning ----------------------------------------------------------------

async function scan(libraryDir: string, stemsDir: string): Promise<LibraryEntry[]> {
  const files = (await walk(libraryDir)).filter((f) => AUDIO_TYPES[path.extname(f).toLowerCase()]);
  files.sort((a, b) => a.localeCompare(b));

  const usedIds = new Set<string>();
  const entries: LibraryEntry[] = [];
  for (const absPath of files) {
    const fileName = path.relative(libraryDir, absPath).split(path.sep).join('/');
    const baseName = path.basename(absPath, path.extname(absPath));
    const baseId = slugify(fileName.slice(0, fileName.length - path.extname(fileName).length)) || 'track';
    let id = baseId;
    for (let n = 2; usedIds.has(id); n++) id = `${baseId}-${n}`;
    usedIds.add(id);

    const { title, artists } = parseName(baseName);
    const stems =
      (await findStems(path.join(stemsDir, id))) ?? (await findStems(path.join(stemsDir, baseName))) ?? {};
    entries.push({ id, fileName, absPath, title, artists, stems });
  }
  return entries;
}

async function walk(dir: string): Promise<string[]> {
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const d of dirents) {
    if (d.name.startsWith('.')) continue;
    const full = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...(await walk(full)));
    else if (d.isFile()) out.push(full);
  }
  return out;
}

/** Returns stem key → absolute path, or null when the folder doesn't exist / has no stems. */
async function findStems(dir: string): Promise<Partial<Record<StemKey, string>> | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const stems: Partial<Record<StemKey, string>> = {};

  if (names.includes('manifest.json')) {
    try {
      const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
      for (const [key, value] of Object.entries(manifest)) {
        const stem = STEM_ALIASES[key.toLowerCase()];
        if (!stem || typeof value !== 'string') continue;
        const file = path.resolve(dir, value);
        if (file.startsWith(path.resolve(dir) + path.sep) && names.includes(path.basename(file))) stems[stem] = file;
      }
    } catch {
      // malformed manifest; fall back to detection
    }
  }

  for (const name of names) {
    const ext = path.extname(name).toLowerCase();
    const stem = STEM_ALIASES[path.basename(name, path.extname(name)).toLowerCase()];
    if (stem && AUDIO_TYPES[ext] && !stems[stem]) stems[stem] = path.join(dir, name);
  }
  return Object.keys(stems).length > 0 ? stems : null;
}

function parseName(baseName: string): { title: string; artists: string[] } {
  const split = baseName.indexOf(' - ');
  if (split === -1) return { title: baseName.trim(), artists: [] };
  const artistPart = baseName.slice(0, split);
  return {
    title: baseName.slice(split + 3).trim(),
    artists: artistPart.split(/\s*(?:,|&| x | feat\.? | ft\.? )\s*/i).map((a) => a.trim()).filter(Boolean),
  };
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// --- Responses ---------------------------------------------------------------

async function sendFile(req: IncomingMessage, res: ServerResponse, file: string): Promise<void> {
  const { size } = await stat(file);
  res.setHeader('Content-Type', AUDIO_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-cache');

  let start = 0;
  let end = size - 1;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), size - 1);
    } else {
      start = Math.max(0, size - Number(range[2]));
    }
    if (start > end || start >= size) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${size}`);
      res.end();
      return;
    }
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  } else {
    res.statusCode = 200;
  }
  res.setHeader('Content-Length', String(end - start + 1));

  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  req.on('close', () => stream.destroy());
  stream.pipe(res);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
