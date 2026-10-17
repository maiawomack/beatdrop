const EXTENSIONS = ['mp3', 'wav', 'ogg', 'm4a'];

/**
 * Load `<base><id>.<ext>` for every stem id. Returns null unless ALL stems
 * are found, so we never mix stems from different songs.
 */
export async function loadStemFiles(
  ctx: BaseAudioContext,
  ids: string[],
  base = '/stems/',
): Promise<Record<string, AudioBuffer> | null> {
  const found: Record<string, AudioBuffer> = {};

  await Promise.all(
    ids.map(async (id) => {
      for (const ext of EXTENSIONS) {
        try {
          const res = await fetch(`${base}${id}.${ext}`);
          // Dev servers answer missing files with index.html, so check the type.
          if (!res.ok || res.headers.get('content-type')?.includes('text/html')) continue;
          found[id] = await ctx.decodeAudioData(await res.arrayBuffer());
          return;
        } catch {
          // Try the next extension.
        }
      }
    }),
  );

  const missing = ids.filter((id) => !found[id]);
  if (missing.length === 0) return found;
  if (missing.length < ids.length) {
    console.warn(`[audio] Found some stem files but missing: ${missing.join(', ')}. Using the demo song.`);
  }
  return null;
}
