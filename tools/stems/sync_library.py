#!/usr/bin/env python3
"""Keep the music library pre-split: every song in mp3/ gets stems in mp3/.stems/.

Stems live next to the songs (in a hidden folder the library scanner skips), so once
they're committed, everyone who pulls has them and songs load with stems, BPM, beat
grid, waveform and lyrics straight away.

    .venv/bin/python tools/stems/sync_library.py              # split every song missing stems
    .venv/bin/python tools/stems/sync_library.py --watch      # ...then keep watching mp3/ for new songs
    .venv/bin/python tools/stems/sync_library.py --watch --only-new   # watch only; leave the backlog alone
    .venv/bin/python tools/stems/sync_library.py --migrate    # reuse old splits in public/stems (no Demucs)
    .venv/bin/python tools/stems/sync_library.py --dry-run    # just list what would happen

Each song's stems folder is named like the separation server names a whole-file upload
("t-" + sha256("None|None|" + file bytes)[:12]), which is also how server/audioLibrary.ts
links songs to stems. So songs split here, from the app's Split button, or by dropping a
file on a deck all end up in the same place under the same name.

Title/artist come from "Artist - Title.mp3" file names, same as the library. Separation
takes about 0.4x the song's length on CPU (~80 s for a 3.5 min song).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import urllib.request
from pathlib import Path

import prepare_stems as ps

AUDIO_EXTENSIONS = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus"}
LEGACY_STEMS = ps.REPO_ROOT / "public" / "stems"
SERVER = "http://127.0.0.1:8765"
WATCH_INTERVAL_SEC = 5
#: A new file must keep the same size this long before it's split (it may still be copying).
SETTLE_SEC = 3


_id_cache: dict[Path, tuple[int, float, str]] = {}


def stems_id(path: Path) -> str:
    """The id the separation server gives a whole-file upload of this song (cached until
    the file changes, so watch mode doesn't re-hash the whole library every few seconds)."""
    st = path.stat()
    cached = _id_cache.get(path)
    if cached and cached[:2] == (st.st_size, st.st_mtime):
        return cached[2]
    digest = hashlib.sha256(b"None|None|")
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    track_id = f"t-{digest.hexdigest()[:12]}"
    _id_cache[path] = (st.st_size, st.st_mtime, track_id)
    return track_id


def library_songs(library: Path) -> list[Path]:
    return sorted(
        p for p in library.rglob("*")
        if p.is_file() and p.suffix.lower() in AUDIO_EXTENSIONS
        and not any(part.startswith(".") for part in p.relative_to(library).parts)
    )


def server_has_job(track_id: str) -> bool:
    """True if the separation server is already splitting (or has split) this song."""
    try:
        with urllib.request.urlopen(f"{SERVER}/jobs/{track_id}", timeout=2) as response:
            return json.load(response).get("state") != "error"
    except Exception:
        return False


def migrate(track_id: str, out_root: Path, fmt: str) -> bool:
    """Re-encode an existing split from public/stems into the library, without re-running Demucs."""
    old = LEGACY_STEMS / track_id
    manifest_path = old / "manifest.json"
    if not manifest_path.exists():
        return False
    m = json.loads(manifest_path.read_text())
    sr = m["sampleRate"]
    stems = {sid: ps.read_audio(old / m["stems"][sid]["file"], sr) for sid in ps.STEM_IDS}
    lyrics = json.loads((old / m["lyrics"]).read_text()) if m.get("lyrics") else None
    cover_name = m.get("cover")
    cover = ((old / cover_name).read_bytes(), Path(cover_name).suffix.lstrip(".")) if cover_name else None
    ps.prepare_track(stems, out_root=out_root, track_id=track_id, title=m["title"], artist=m["artist"],
                     sample_rate=sr, fmt=fmt, source=m.get("source", "demucs"), bpm=m["bpm"],
                     first_beat=m["firstBeatSec"], lyrics=lyrics, cover=cover,
                     clip_start=m.get("clipStartSec", 0.0), source_duration=m.get("sourceDurationSec"))
    return True


def sync(library: Path, out_root: Path, fmt: str, *, use_legacy: bool, dry_run: bool,
         seen_sizes: dict[Path, tuple[int, float]] | None = None, ignore: set[Path] = frozenset()) -> int:
    """Split (or migrate) every song that has no stems yet. Returns how many were processed."""
    done = 0
    for song in library_songs(library):
        if song in ignore:
            continue
        if seen_sizes is not None:
            # In watch mode, wait until a newly added file stops growing.
            size, now = song.stat().st_size, time.time()
            prev = seen_sizes.get(song)
            if prev is None or prev[0] != size:
                seen_sizes[song] = (size, now)
                continue
            if now - prev[1] < SETTLE_SEC:
                continue
        track_id = stems_id(song)
        if (out_root / track_id / "manifest.json").exists():
            continue
        name = song.relative_to(library)
        if use_legacy and (LEGACY_STEMS / track_id / "manifest.json").exists():
            print(f"migrate  {name}  ({track_id}, reusing public/stems)", flush=True)
            if not dry_run:
                migrate(track_id, out_root, fmt)
            done += 1
            continue
        if server_has_job(track_id):
            print(f"skip     {name}  (the separation server is already splitting it)", flush=True)
            continue
        print(f"split    {name}  ({track_id})", flush=True)
        if dry_run:
            done += 1
            continue
        title, artist = ps.parse_name(song.stem)
        started = time.time()
        try:
            ps.separate_file(song, out_root=out_root, track_id=track_id, title=title, artist=artist,
                             fallback_title=song.stem, fmt=fmt)
            print(f"         done in {time.time() - started:.0f}s", flush=True)
            done += 1
        except ps.StemError as exc:
            print(f"         FAILED: {exc}", flush=True)
    return done


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--library", type=Path, default=ps.LIBRARY_DIR, help="music folder (default: mp3/)")
    parser.add_argument("--out", type=Path, default=ps.DEFAULT_OUT, help="stems folder (default: mp3/.stems/)")
    parser.add_argument("--format", choices=ps.FORMATS, default=ps.DEFAULT_FORMAT)
    parser.add_argument("--watch", action="store_true", help="keep running and split songs as they're added")
    parser.add_argument("--migrate", action="store_true",
                        help="reuse existing splits from public/stems instead of re-separating them")
    parser.add_argument("--only-new", action="store_true",
                        help="with --watch: skip songs already in the library, split only ones added later")
    parser.add_argument("--dry-run", action="store_true", help="only list what would be split")
    args = parser.parse_args()

    library, out_root = args.library.resolve(), args.out.resolve()
    out_root.mkdir(parents=True, exist_ok=True)
    try:
        ignore: set[Path] = set()
        if args.watch and args.only_new:
            ignore = set(library_songs(library))
            print(f"ignoring the {len(ignore)} songs already in the library")
        else:
            count = sync(library, out_root, args.format, use_legacy=args.migrate, dry_run=args.dry_run)
            print(f"{'would process' if args.dry_run else 'processed'} {count} song(s); "
                  f"{len(library_songs(library))} in the library")
        if not args.watch:
            return
        print(f"watching {library} for new songs (Ctrl+C to stop)…", flush=True)
        seen: dict[Path, tuple[int, float]] = {}
        while True:
            sync(library, out_root, args.format, use_legacy=args.migrate, dry_run=args.dry_run, seen_sizes=seen,
                 ignore=ignore)
            time.sleep(WATCH_INTERVAL_SEC)
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
