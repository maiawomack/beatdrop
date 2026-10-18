"""Song metadata and cover art from file tags, and lyrics from LRCLIB (https://lrclib.net, free, no key).

Synced (timestamped) lyrics are only trusted when the LRCLIB recording's length is within
SYNC_TOLERANCE_SEC of ours: a radio edit vs. album version would put every line off.
Otherwise only the plain text is kept. Lookups never raise; no match means no lyrics.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

LRCLIB_SEARCH = "https://lrclib.net/api/search"
USER_AGENT = "BeatDrop/1 (DubHacks 2026 student project; https://github.com/maiawomack/beatdrop)"
SYNC_TOLERANCE_SEC = 3.0
LYRICS_VERSION = 1
LRC_LINE = re.compile(r"^\[(\d+):(\d+(?:\.\d+)?)\](.*)$")


def read_tags(path: Path) -> dict[str, str]:
    """Title / artist / album from ID3, MP4, FLAC or Vorbis tags (empty strings if absent)."""
    try:
        import mutagen

        audio = mutagen.File(str(path), easy=True)
    except Exception:  # unreadable or untagged files just have no tags
        return {"title": "", "artist": "", "album": ""}
    tags = (audio.tags if audio is not None else None) or {}
    first = lambda key: str((tags.get(key) or [""])[0]).strip()  # noqa: E731
    return {"title": first("title"), "artist": first("artist") or first("albumartist"), "album": first("album")}


def clean_title(text: str) -> str:
    """Drop "(feat. ...)", "[Explicit]", "- Remastered 2011" style additions store files carry."""
    text = re.sub(r"[\(\[].*?[\)\]]", " ", text)
    text = re.sub(r"\s-\s.*(remaster|version|edit|mix|live).*$", " ", text, flags=re.IGNORECASE)
    # Unbracketed featured artists, as in file names like "Song ft. Someone".
    text = re.sub(r"\s(ft\.?|feat\.?|featuring)\s.*$", " ", text, flags=re.IGNORECASE)
    return " ".join(text.split())


def read_cover(path: Path) -> tuple[bytes, str] | None:
    """Embedded cover art as (image bytes, "jpg" | "png"), or None. Front cover preferred."""
    try:
        import mutagen

        audio = mutagen.File(str(path))
    except Exception:
        return None
    if audio is None:
        return None
    pictures: list[tuple[bytes, str, int]] = []  # (data, mime, picture type; 3 = front cover)
    tags = audio.tags
    if hasattr(tags, "getall"):  # ID3 (MP3, AIFF)
        pictures += [(p.data, p.mime, p.type) for p in tags.getall("APIC")]
    if tags is not None and "covr" in tags:  # MP4 / M4A
        pictures += [(bytes(c), "image/png" if c.imageformat == 14 else "image/jpeg", 3) for c in tags["covr"]]
    pictures += [(p.data, p.mime, p.type) for p in getattr(audio, "pictures", [])]  # FLAC
    if tags is not None and hasattr(tags, "get"):  # Ogg Vorbis / Opus
        import base64

        from mutagen.flac import Picture

        for block in tags.get("metadata_block_picture", []) or []:
            try:
                p = Picture(base64.b64decode(block))
                pictures.append((p.data, p.mime, p.type))
            except Exception:
                continue
    if not pictures:
        return None
    data, mime, _ = max(pictures, key=lambda p: (p[2] == 3, len(p[0])))
    return data, ("png" if "png" in mime or data[:4] == b"\x89PNG" else "jpg")


def normalize(text: str) -> str:
    """clean_title, lowercased, punctuation removed: for comparing titles and artists."""
    return " ".join(re.sub(r"[^a-z0-9]+", " ", clean_title(text).lower()).split())


def search_lrclib(params: dict[str, str], timeout: float, attempts: int = 2) -> list[dict]:
    url = f"{LRCLIB_SEARCH}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                results = json.load(response)
            return results if isinstance(results, list) else []  # errors come back as an object
        except urllib.error.HTTPError as exc:  # LRCLIB returns brief 5xx under load; retry those
            if exc.code < 500 or attempt == attempts - 1:
                raise
            time.sleep(1.5)
    return []


def parse_lrc(text: str) -> list[dict]:
    lines = []
    for raw in text.splitlines():
        match = LRC_LINE.match(raw.strip())
        if match:
            minutes, seconds, words = match.groups()
            lines.append({"timeSec": round(int(minutes) * 60 + float(seconds), 3), "text": words.strip()})
    return sorted(lines, key=lambda line: line["timeSec"])


def clip_lines(lines: list[dict], start: float, duration: float | None) -> list[dict]:
    """Shift lines onto a clip that starts `start` seconds into the song."""
    end = None if duration is None else start + duration
    out = []
    for i, line in enumerate(lines):
        t = line["timeSec"]
        next_t = lines[i + 1]["timeSec"] if i + 1 < len(lines) else float("inf")
        if t < start < next_t:  # line already being sung when the clip starts
            out.append({"timeSec": 0.0, "text": line["text"]})
        elif start <= t and (end is None or t < end):
            out.append({"timeSec": round(t - start, 3), "text": line["text"]})
    return out


def fetch_lyrics(title: str, artist: str, duration_sec: float, *, start: float = 0.0,
                 clip_duration: float | None = None, timeout: float = 8.0) -> dict | None:
    """Look up lyrics for a song. Returns the lyrics.json document, or None."""
    if not title or not artist:
        return None
    try:
        candidates = search_lrclib({"track_name": clean_title(title), "artist_name": artist}, timeout)
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
        print(f"lyrics: lookup failed ({exc}); continuing without lyrics")
        return None

    want_title, want_artist = normalize(title), normalize(artist)
    matches = [c for c in candidates
               if normalize(c.get("trackName", "")) == want_title
               and (want_artist in normalize(c.get("artistName", ""))
                    or normalize(c.get("artistName", "")) in want_artist)]
    if not matches:
        return None

    def rank(c: dict) -> tuple:
        close = abs((c.get("duration") or 0) - duration_sec) <= SYNC_TOLERANCE_SEC
        return (close and bool(c.get("syncedLyrics")), bool(c.get("plainLyrics")),
                -abs((c.get("duration") or 0) - duration_sec))

    best = max(matches, key=rank)
    synced = abs((best.get("duration") or 0) - duration_sec) <= SYNC_TOLERANCE_SEC and bool(best.get("syncedLyrics"))
    lines = clip_lines(parse_lrc(best["syncedLyrics"]), start, clip_duration) if synced else []
    return {
        "version": LYRICS_VERSION,
        "source": "lrclib",
        "sourceId": best.get("id"),
        "matchedTitle": best.get("trackName"),
        "matchedArtist": best.get("artistName"),
        "matchedDurationSec": best.get("duration"),
        "instrumental": bool(best.get("instrumental")),
        "synced": synced,
        "lines": lines,
        "plain": best.get("plainLyrics") or "",
    }
