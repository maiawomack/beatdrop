import { createHash } from 'node:crypto';
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
 * Stems come from the Task 5 pipeline (tools/stems), which writes
 * `stemsDir/<stems id>/manifest.json`. A library file is matched to its stems by either id
 * the pipeline uses:
 *   - separation_server.py: "t-" + sha256("None|None|" + file bytes)[:12]  (whole-song uploads)
 *   - prepare_stems.py separate: slug of the title, i.e. the library id for untagged files
 *
 *   GET /api/library?q=<search>                 → { tracks: TrackInfo[] }
 *   GET /api/library/audio/<id>                 → full mix (Range supported)
 *   GET /api/library/stems/<stems id>/<file>    → manifest.json, waveform.json, lyrics.json, stem audio
 *   GET /api/library/stems/index.json           → every split track (built from the manifests on each request)
 */

const CONTENT_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.json': 'application/json',
};
const AUDIO_EXTENSIONS = new Set(Object.keys(CONTENT_TYPES).filter((ext) => ext !== '.json'));
const SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

interface LibraryEntry {
  id: string;
  /** Path relative to libraryDir, for display. */
  fileName: string;
  absPath: string;
  title: string;
  artists: string[];
  /** Folder name under stemsDir, when the track has been separated. */
  stemsId: string | null;
  bpm: number | null;
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
  stemsManifestUrl: string | null;
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
    if (parts[2] === 'stems' && parts.length === 4 && parts[3] === 'index.json') {
      return sendJson(res, 200, await stemsIndex(stemsDir));
    }
    if (parts[2] === 'stems' && parts.length === 5) {
      const [, , , stemsId, file] = parts as [string, string, string, string, string];
      if (!SAFE_SEGMENT.test(stemsId) || !SAFE_SEGMENT.test(file)) return sendJson(res, 400, { error: 'Bad path' });
      return sendFile(req, res, path.join(stemsDir, stemsId, file));
    }

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

    if (parts[2] === 'audio' && parts.length === 4) {
      const entry = entries.find((e) => e.id === parts[3]);
      if (!entry) return sendJson(res, 404, { error: 'Track not found' });
      return sendFile(req, res, entry.absPath);
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
  return {
    id: e.id,
    title: e.title,
    artists: e.artists,
    album: null,
    artworkUrl: null,
    durationMs: null,
    fileName: e.fileName,
    audioUrl: `/api/library/audio/${encodeURIComponent(e.id)}`,
    stemsManifestUrl: e.stemsId ? `/api/library/stems/${encodeURIComponent(e.stemsId)}/manifest.json` : null,
    bpm: e.bpm,
  };
}

// --- Scanning ----------------------------------------------------------------

async function scan(libraryDir: string, stemsDir: string): Promise<LibraryEntry[]> {
  const files = (await walk(libraryDir)).filter((f) => AUDIO_EXTENSIONS.has(path.extname(f).toLowerCase()));
  files.sort((a, b) => a.localeCompare(b));

  const usedIds = new Set<string>();
  const entries: LibraryEntry[] = [];
  for (const absPath of files) {
    const fileName = path.relative(libraryDir, absPath).split(path.sep).join('/');
    const baseName = path.basename(absPath, path.extname(absPath));
    const baseId = slugify(fileName.slice(0, fileName.length - path.extname(fileName).length));
    let id = baseId;
    for (let n = 2; usedIds.has(id); n++) id = `${baseId}-${n}`;
    usedIds.add(id);

    const { title, artists } = parseName(baseName);
    let stemsId: string | null = null;
    let bpm: number | null = null;
    for (const candidate of [await separationServerId(absPath), slugify(baseName)]) {
      const manifest = await readManifest(path.join(stemsDir, candidate));
      if (manifest) {
        stemsId = candidate;
        bpm = typeof manifest.bpm === 'number' ? manifest.bpm : null;
        break;
      }
    }
    entries.push({ id, fileName, absPath, title, artists, stemsId, bpm });
  }
  return entries;
}

/**
 * Same shape as the index.json the stem pipeline writes, but generated from the manifests,
 * so the committed stems folder needs no shared index file that teammates would conflict on.
 */
async function stemsIndex(stemsDir: string) {
  const dirents = await readdir(stemsDir, { withFileTypes: true }).catch(() => []);
  const tracks: Record<string, unknown>[] = [];
  for (const d of dirents) {
    if (!d.isDirectory() || d.name.startsWith('.') || !SAFE_SEGMENT.test(d.name)) continue;
    try {
      const m = JSON.parse(await readFile(path.join(stemsDir, d.name, 'manifest.json'), 'utf8')) as Record<string, unknown>;
      tracks.push({
        id: d.name,
        title: m.title,
        artist: m.artist,
        bpm: m.bpm,
        durationSec: m.durationSec,
        manifest: `${d.name}/manifest.json`,
      });
    } catch {
      // not a finished track (still being written, or not a stems folder)
    }
  }
  return { version: 1, tracks };
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

async function readManifest(dir: string): Promise<{ bpm?: unknown } | null> {
  try {
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as unknown;
    return manifest && typeof manifest === 'object' ? (manifest as { bpm?: unknown }) : null;
  } catch {
    return null;
  }
}

const hashCache = new Map<string, { size: number; mtimeMs: number; id: string }>();

/**
 * The track id separation_server.py assigns to a whole-file upload:
 * "t-" + sha256(f"{start}|{duration}|" + bytes)[:12], with start/duration unset (Python None).
 * Cached per file so rescans only hash new or changed files.
 */
async function separationServerId(file: string): Promise<string> {
  const { size, mtimeMs } = await stat(file);
  const cached = hashCache.get(file);
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.id;

  const hash = createHash('sha256').update('None|None|');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  const id = `t-${hash.digest('hex').slice(0, 12)}`;
  hashCache.set(file, { size, mtimeMs, id });
  return id;
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

/** Same as slugify() in tools/stems/prepare_stems.py, so CLI-separated tracks match library ids. */
function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'track'
  );
}

// --- Responses ---------------------------------------------------------------

async function sendFile(req: IncomingMessage, res: ServerResponse, file: string): Promise<void> {
  let size: number;
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    size = info.size;
  } catch {
    return sendJson(res, 404, { error: 'File not found' });
  }
  res.setHeader('Content-Type', CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
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
