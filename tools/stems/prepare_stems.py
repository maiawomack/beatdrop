#!/usr/bin/env python3
"""BeatDrop stem preparation (Task 5).

Turns songs into sample-aligned stem sets the audio engine can play in lockstep:

    vocals, drums, bass, instrumental   (instrumental = everything else, Demucs "other")

Every track written by this tool satisfies the same guarantees:
  * all stems share one sample rate, channel count (stereo) and exact frame count
  * all stems start at frame 0 of the same timeline, so starting every stem with the
    same `when`/`offset` in Web Audio keeps them in sync
  * one gain is applied to all stems of a track (stems keep their relative balance),
    chosen so tracks play at similar loudness and nothing clips
  * lossless output (WAV/FLAC) -- no MP3/AAC encoder delay to break alignment

Subcommands:
    separate  run Demucs on a full song and prepare the result (+ lyrics from LRCLIB)
              (the web app does the same through separation_server.py)
    import    prepare stems you already have (optionally aligned against the full mix)
    demo      synthesize two copyright-free demo tracks (no Demucs needed)
    verify    re-check prepared tracks on disk
    lyrics    (re)fetch lyrics for a prepared track, e.g. with a corrected title/artist
    cover     add cover art to a prepared track from its original song file
    index     rebuild <out>/index.json from the track folders

Output layout (default --out public/stems):
    index.json
    <track-id>/manifest.json
    <track-id>/waveform.json
    <track-id>/lyrics.json      (when found; manifest "lyrics" is null otherwise)
    <track-id>/cover.jpg|png    (embedded art, when the file has it; manifest "cover")
    <track-id>/{vocals,drums,bass,instrumental}.wav
"""

from __future__ import annotations

import argparse
import collections
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from math import gcd
from pathlib import Path
from typing import Callable

import lyrics as lyrics_lookup

try:
    import numpy as np
    import soundfile as sf
    from scipy import signal
except ImportError as exc:  # pragma: no cover - friendly message for a missing venv
    sys.exit(f"Missing dependency ({exc.name}). Run: pip install -r tools/stems/requirements.txt")

MANIFEST_VERSION = 1
STEM_IDS = ("vocals", "drums", "bass", "instrumental")
DEMUCS_TO_STEM = {"vocals": "vocals", "drums": "drums", "bass": "bass", "other": "instrumental"}

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = REPO_ROOT / "public" / "stems"
DEFAULT_MODEL = "htdemucs"
MIN_SONG_SEC = 5.0
DEFAULT_SAMPLE_RATE = 44100
DEFAULT_TARGET_RMS_DB = -14.0  # loudness target for the summed mix (approximate, RMS-based)
DEFAULT_CEILING_DB = -1.0  # no stem and no mix may peak above this
WAVEFORM_BUCKETS_PER_SEC = 50
SILENCE = 1e-9

# Called with (stage, fraction of that stage done). Stages: decoding, separating, analyzing, done.
ProgressFn = Callable[[str, float], None]


class StemError(Exception):
    """An expected failure with a user-facing message (bad input, Demucs missing or failing)."""


def default_demucs_python() -> str:
    """The repo's .venv-demucs interpreter if it exists (see README), else this one."""
    venv = REPO_ROOT / ".venv-demucs" / "bin" / "python"
    return str(venv) if venv.exists() else sys.executable


# --------------------------------------------------------------------------- audio io


def read_audio(path: Path, sample_rate: int) -> np.ndarray:
    """Read an audio file as float32 stereo (frames, 2) at `sample_rate`.

    libsndfile reads WAV/FLAC/OGG/MP3; anything else (e.g. AAC .m4a) is converted with
    macOS `afconvert` or `ffmpeg`, whichever is available.
    """
    try:
        data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    except sf.LibsndfileError:
        data, sr = read_via_converter(Path(path))
    if data.shape[1] == 1:
        data = np.repeat(data, 2, axis=1)
    elif data.shape[1] > 2:
        data = data[:, :2]
    return resample(data, sr, sample_rate)


def read_via_converter(path: Path) -> tuple[np.ndarray, int]:
    with tempfile.TemporaryDirectory(prefix="beatdrop-decode-") as tmp:
        wav = Path(tmp) / "decoded.wav"
        if shutil.which("afconvert"):
            cmd = ["afconvert", "-f", "WAVE", "-d", "LEI16", str(path), str(wav)]
        elif shutil.which("ffmpeg"):
            cmd = ["ffmpeg", "-loglevel", "error", "-i", str(path), str(wav)]
        else:
            raise StemError(f"cannot decode {path.name}: use WAV, FLAC, MP3 or OGG, or install ffmpeg")
        if subprocess.run(cmd, capture_output=True).returncode != 0 or not wav.exists():
            raise StemError(f"cannot decode {path.name}: unsupported or corrupt audio file")
        return sf.read(str(wav), dtype="float32", always_2d=True)


def resample(x: np.ndarray, sr: int, target: int) -> np.ndarray:
    if sr == target:
        return x
    g = gcd(sr, target)
    return signal.resample_poly(x, target // g, sr // g, axis=0).astype(np.float32)


def write_audio(path: Path, x: np.ndarray, sample_rate: int, fmt: str) -> None:
    sf.write(str(path), x, sample_rate, format=fmt.upper(), subtype="PCM_16")


def to_mono(x: np.ndarray) -> np.ndarray:
    return x.mean(axis=1) if x.ndim == 2 else x


def fit_length(x: np.ndarray, frames: int) -> np.ndarray:
    if len(x) >= frames:
        return x[:frames]
    return np.pad(x, ((0, frames - len(x)), (0, 0)))


def clip_region(x: np.ndarray, sr: int, start: float | None, duration: float | None) -> np.ndarray:
    begin = int(round((start or 0.0) * sr))
    end = len(x) if duration is None else begin + int(round(duration * sr))
    return x[begin:end]


def peak(x: np.ndarray) -> float:
    return float(np.max(np.abs(x))) if x.size else 0.0


def rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(x, dtype=np.float64)))) if x.size else 0.0


def to_db(v: float) -> float:
    return round(20 * math.log10(max(v, SILENCE)), 2)


# --------------------------------------------------------------------------- alignment


def estimate_lag(ref: np.ndarray, sig: np.ndarray, sr: int, max_lag_sec: float = 5.0,
                 window_sec: float = 60.0) -> tuple[int, float]:
    """Frames `sig` must be delayed by to line up with `ref` (negative = advance).

    Cross-correlates the first `window_sec` seconds. Returns (lag, normalized peak).
    """
    n = int(window_sec * sr)
    a = to_mono(ref[:n]).astype(np.float64)
    b = to_mono(sig[:n]).astype(np.float64)
    if rms(a) < 1e-6 or rms(b) < 1e-6:
        return 0, 0.0
    size = 1 << int(math.ceil(math.log2(len(a) + len(b))))
    xcorr = np.fft.irfft(np.fft.rfft(a, size) * np.conj(np.fft.rfft(b, size)), size)
    max_lag = int(max_lag_sec * sr)
    lags = np.concatenate([np.arange(0, max_lag + 1), np.arange(-max_lag, 0)])
    values = np.concatenate([xcorr[: max_lag + 1], xcorr[-max_lag:]])
    best = int(np.argmax(values))
    norm = float(values[best] / (np.linalg.norm(a) * np.linalg.norm(b)))
    return int(lags[best]), norm


def shift(x: np.ndarray, lag: int) -> np.ndarray:
    if lag > 0:
        return np.pad(x, ((lag, 0), (0, 0)))
    if lag < 0:
        return x[-lag:]
    return x


# --------------------------------------------------------------------------- tempo


def onset_envelope(mono: np.ndarray, sr: int, hop: int = 128,
                   n_fft: int = 512) -> tuple[np.ndarray, float, float]:
    """Spectral-flux onset strength at 22.05 kHz.

    Returns (envelope, frames per second, seconds to add to a frame's start time to get
    the onset time). With log compression the flux jumps as soon as a transient enters
    the tail of the window, so onsets sit ~3/4 of a window after the frame start
    (measured on synthetic drums: residual error < 2 ms).
    """
    env_sr = 22050
    y = resample(mono[:, None], sr, env_sr)[:, 0] if sr != env_sr else mono
    if len(y) < n_fft:
        return np.zeros(1), env_sr / hop, 0.0
    window = np.hanning(n_fft).astype(np.float32)
    frames = np.lib.stride_tricks.sliding_window_view(y, n_fft)[::hop]
    flux = np.zeros(len(frames), dtype=np.float32)
    prev = None
    for start in range(0, len(frames), 4096):  # chunked to bound memory on long songs
        mag = np.log1p(100.0 * np.abs(np.fft.rfft(frames[start:start + 4096] * window, axis=1)))
        if prev is not None:
            mag = np.vstack([prev, mag])
            flux[start:start + len(mag) - 1] = np.maximum(0.0, np.diff(mag, axis=0)).sum(axis=1)
        else:
            flux[1:len(mag)] = np.maximum(0.0, np.diff(mag, axis=0)).sum(axis=1)
        prev = mag[-1:]
    fps = env_sr / hop
    # Remove the slow-moving loudness trend so only transients remain.
    trend = np.convolve(flux, np.ones(int(fps)) / int(fps), mode="same")
    env = np.maximum(0.0, flux - trend)
    env = np.convolve(env, [0.25, 0.5, 0.25], mode="same")
    return env / (env.max() or 1.0), fps, 0.75 * n_fft / env_sr


def estimate_tempo(mono: np.ndarray, sr: int, min_bpm: float = 70.0,
                   max_bpm: float = 180.0) -> tuple[float, float]:
    """Constant-tempo estimate. Returns (bpm, first beat time in seconds)."""
    env, fps, onset_offset = onset_envelope(mono, sr)
    if len(env) < fps * 4 or env.max() <= 0:
        raise ValueError("audio too short or silent for tempo estimation")

    # Coarse: autocorrelation with a log-normal prior around 120 BPM against octave errors.
    centered = env - env.mean()
    size = 1 << int(math.ceil(math.log2(2 * len(env))))
    spec = np.fft.rfft(centered, size)
    ac = np.fft.irfft(spec * np.conj(spec), size)[: len(env)]
    bpms = np.arange(min_bpm, max_bpm, 0.25)
    lags = 60.0 * fps / bpms
    prior = np.exp(-0.5 * np.log2(bpms / 120.0) ** 2)
    coarse = float(bpms[np.argmax(np.interp(lags, np.arange(len(ac)), ac) * prior)])

    # Fine: fit a beat grid over the whole track (autocorrelation lag resolution is ~1%).
    best = (-1.0, coarse, 0.0)
    for bpm in np.arange(coarse * 0.98, coarse * 1.02, 0.01):
        period = 60.0 * fps / bpm
        beats = np.arange(int((len(env) - 1) / period)) * period
        phases = np.arange(0.0, period, 0.5)
        idx = np.rint(phases[:, None] + beats[None, :]).astype(int)
        idx = np.minimum(idx, len(env) - 1)
        scores = env[idx].mean(axis=1)
        i = int(np.argmax(scores))
        if scores[i] > best[0]:
            best = (float(scores[i]), float(bpm), float(phases[i]))
    _, bpm, phase = best
    first_beat = (phase / fps + onset_offset) % (60.0 / bpm)
    return round(bpm, 2), round(first_beat, 4)


# --------------------------------------------------------------------------- writing


def waveform_peaks(x: np.ndarray, sr: int, buckets_per_sec: int) -> list[int]:
    """Max |amplitude| per bucket, 0-255 (255 = full scale)."""
    size = sr // buckets_per_sec
    count = int(math.ceil(len(x) / size))
    padded = np.pad(np.abs(x).max(axis=1), (0, count * size - len(x)))
    return np.clip(np.rint(padded.reshape(count, size).max(axis=1) * 255), 0, 255).astype(int).tolist()


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug or "track"


def prepare_track(stems: dict[str, np.ndarray], *, out_root: Path, track_id: str, title: str,
                  artist: str, sample_rate: int, fmt: str, source: str, mix: np.ndarray | None = None,
                  bpm: float | None = None, first_beat: float | None = None,
                  target_rms_db: float = DEFAULT_TARGET_RMS_DB, ceiling_db: float = DEFAULT_CEILING_DB,
                  lyrics: dict | None = None, cover: tuple[bytes, str] | None = None,
                  clip_start: float = 0.0, source_duration: float | None = None) -> dict:
    """Make stems sample-aligned, level them, analyze tempo, and write the track folder."""
    missing = [s for s in STEM_IDS if s not in stems]
    if missing:
        raise ValueError(f"missing stems: {', '.join(missing)}")

    frames = max(len(x) for x in stems.values())
    stems = {sid: fit_length(stems[sid], frames).astype(np.float32) for sid in STEM_IDS}
    summed = sum(stems.values())

    report: dict = {}
    if mix is not None:
        mix = fit_length(mix, frames)
        err = rms(mix - summed)
        report["reconstructionDb"] = round(to_db(rms(mix)) - to_db(err), 2) if err > SILENCE else None

    # One gain for the whole track: hit the loudness target unless that would clip.
    ceiling = 10 ** (ceiling_db / 20)
    loudest = max(peak(summed), *(peak(x) for x in stems.values()))
    gain = 10 ** ((target_rms_db - to_db(rms(summed))) / 20)
    if loudest * gain > ceiling:
        gain = ceiling / loudest
    stems = {sid: x * gain for sid, x in stems.items()}
    summed = summed * gain

    if bpm is None:
        drums = stems["drums"]
        basis = drums if rms(drums) > 1e-4 else summed
        bpm, detected_first_beat = estimate_tempo(to_mono(basis), sample_rate)
        bpm_source = "estimated"
        if first_beat is None:
            first_beat = detected_first_beat
    else:
        bpm_source = "manual"
    if first_beat is None:
        first_beat = 0.0

    # Write into a hidden staging folder and rename it into place at the end, so a
    # reader (e.g. the separation server) never sees a half-written track.
    track_dir = out_root / track_id
    staging = out_root / f".{track_id}.staging"
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)

    ext = "flac" if fmt == "flac" else "wav"
    stem_entries = {}
    for sid in STEM_IDS:
        filename = f"{sid}.{ext}"
        write_audio(staging / filename, stems[sid], sample_rate, fmt)
        stem_entries[sid] = {"file": filename, "peakDb": to_db(peak(stems[sid])),
                             "rmsDb": to_db(rms(stems[sid]))}

    waveform = {
        "version": MANIFEST_VERSION,
        "bucketsPerSecond": WAVEFORM_BUCKETS_PER_SEC,
        "stems": {sid: waveform_peaks(stems[sid], sample_rate, WAVEFORM_BUCKETS_PER_SEC) for sid in STEM_IDS},
        "mix": waveform_peaks(summed, sample_rate, WAVEFORM_BUCKETS_PER_SEC),
    }
    (staging / "waveform.json").write_text(json.dumps(waveform, separators=(",", ":")))
    if lyrics:
        (staging / "lyrics.json").write_text(json.dumps(lyrics, indent=1) + "\n")
    if cover:
        (staging / f"cover.{cover[1]}").write_bytes(cover[0])

    manifest = {
        "version": MANIFEST_VERSION,
        "id": track_id,
        "title": title,
        "artist": artist,
        "sampleRate": sample_rate,
        "channels": 2,
        "frames": frames,
        "durationSec": round(frames / sample_rate, 4),
        # Where this clip sits in the original song (lyrics re-fetching needs it).
        "clipStartSec": round(clip_start, 4),
        "sourceDurationSec": round(source_duration if source_duration else frames / sample_rate, 4),
        "bpm": bpm,
        "bpmSource": bpm_source,
        "firstBeatSec": first_beat,
        "gainDb": to_db(gain),
        "mixPeakDb": to_db(peak(summed)),
        "mixRmsDb": to_db(rms(summed)),
        "source": source,
        "stems": stem_entries,
        "waveform": "waveform.json",
        "lyrics": "lyrics.json" if lyrics else None,
        "cover": f"cover.{cover[1]}" if cover else None,
    }
    (staging / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    if track_dir.exists():
        shutil.rmtree(track_dir)
    staging.rename(track_dir)
    write_index(out_root)

    print(f"[{track_id}] {frames / sample_rate:.1f}s  {bpm} BPM ({bpm_source}), first beat {first_beat}s, "
          f"gain {to_db(gain):+.1f} dB, mix peak {manifest['mixPeakDb']} dBFS")
    if "reconstructionDb" in report:
        rec = report["reconstructionDb"]
        print(f"[{track_id}] stems vs. original mix: {'exact' if rec is None else f'{rec} dB SNR'}")
    for problem in verify_track(track_dir):
        print(f"[{track_id}] VERIFY FAILED: {problem}")
    if lyrics:
        kind = f"synced, {len(lyrics['lines'])} lines" if lyrics["synced"] else "plain text only"
        print(f"[{track_id}] lyrics: {lyrics['matchedArtist']} - {lyrics['matchedTitle']} ({kind})")
    print(f"[{track_id}] wrote {track_dir}")
    return manifest


def write_index(out_root: Path) -> None:
    tracks = []
    for manifest_path in sorted(out_root.glob("*/manifest.json")):
        if manifest_path.parent.name.startswith("."):
            continue
        m = json.loads(manifest_path.read_text())
        tracks.append({"id": m["id"], "title": m["title"], "artist": m["artist"], "bpm": m["bpm"],
                       "durationSec": m["durationSec"], "manifest": f"{m['id']}/manifest.json"})
    tmp = out_root / ".index.json.tmp"
    tmp.write_text(json.dumps({"version": MANIFEST_VERSION, "tracks": tracks}, indent=2) + "\n")
    os.replace(tmp, out_root / "index.json")


def verify_track(track_dir: Path) -> list[str]:
    """Check that files on disk match the manifest and are mutually aligned."""
    problems = []
    manifest_path = track_dir / "manifest.json"
    if not manifest_path.exists():
        return [f"no manifest.json in {track_dir}"]
    m = json.loads(manifest_path.read_text())
    if m.get("version") != MANIFEST_VERSION:
        problems.append(f"manifest version {m.get('version')} != {MANIFEST_VERSION}")
    if set(m.get("stems", {})) != set(STEM_IDS):
        problems.append(f"stems {sorted(m.get('stems', {}))} != {sorted(STEM_IDS)}")
    for sid, entry in m.get("stems", {}).items():
        path = track_dir / entry["file"]
        if not path.exists():
            problems.append(f"{sid}: missing {path.name}")
            continue
        info = sf.info(str(path))
        if info.samplerate != m["sampleRate"]:
            problems.append(f"{sid}: sample rate {info.samplerate} != {m['sampleRate']}")
        if info.frames != m["frames"]:
            problems.append(f"{sid}: {info.frames} frames != {m['frames']}")
        if info.channels != m["channels"]:
            problems.append(f"{sid}: {info.channels} channels != {m['channels']}")
    return problems


# --------------------------------------------------------------------------- separation


def run_demucs(input_wav: Path, out_dir: Path, *, model: str, device: str, demucs_python: str,
               on_progress: ProgressFn | None = None) -> Path:
    """Run Demucs in a subprocess (it lives in its own venv). Returns the folder of its stems."""
    cmd = [demucs_python, "-m", "demucs", "-n", model, "-o", str(out_dir), "--float32", "-d", device,
           str(input_wav)]
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    except OSError as exc:
        raise StemError(f"could not run {demucs_python} ({exc.strerror}); "
                        "install Demucs (see tools/stems/README.md)") from exc

    # Demucs reports progress as a tqdm bar on stderr ("45%|####  | ..."), redrawn with \r.
    tail: collections.deque[str] = collections.deque(maxlen=20)
    pending = b""
    while chunk := proc.stderr.read1(4096):
        *lines, pending = re.split(rb"[\r\n]", pending + chunk)
        for line in lines:
            text = line.decode(errors="replace").strip()
            match = re.search(r"(\d+(?:\.\d+)?)%\|", text)
            if match and on_progress:
                on_progress("separating", float(match.group(1)) / 100)
            elif text and not match:
                tail.append(text)
    if proc.wait() != 0:
        detail = tail[-1] if tail else "no output"
        if "No module named demucs" in " ".join(tail):
            detail = f"Demucs is not installed for {demucs_python} (see tools/stems/README.md)"
        raise StemError(f"Demucs failed (exit {proc.returncode}): {detail}")
    return out_dir / model / input_wav.stem


def song_metadata(song: Path, title: str | None, artist: str | None,
                  fallback_title: str | None = None) -> tuple[str, str]:
    """Explicit values win, then the file's tags, then the file name."""
    tags = lyrics_lookup.read_tags(song)
    return (title or tags["title"] or fallback_title or song.stem,
            artist or tags["artist"] or "Unknown Artist")


def separate_file(song: Path, *, out_root: Path, track_id: str, title: str | None = None,
                  artist: str | None = None, fallback_title: str | None = None,
                  sample_rate: int = DEFAULT_SAMPLE_RATE, fmt: str = "wav", start: float | None = None,
                  duration: float | None = None, bpm: float | None = None, first_beat: float | None = None,
                  model: str = DEFAULT_MODEL, device: str = "cpu", demucs_python: str | None = None,
                  target_rms_db: float = DEFAULT_TARGET_RMS_DB, ceiling_db: float = DEFAULT_CEILING_DB,
                  with_lyrics: bool = True, on_progress: ProgressFn | None = None) -> dict:
    """Raw audio file in, prepared track (aligned stems + manifest) out. Returns the manifest.

    Title/artist default to the file's tags (purchased files have them), which is also
    what the lyrics lookup searches for.
    """
    report = on_progress or (lambda stage, fraction: None)
    report("decoding", 0.0)
    title, artist = song_metadata(song, title, artist, fallback_title)
    full = read_audio(song, sample_rate)
    source_duration = len(full) / sample_rate
    mix = clip_region(full, sample_rate, start, duration)
    del full
    if len(mix) < MIN_SONG_SEC * sample_rate:
        raise StemError(f"audio is {len(mix) / sample_rate:.1f}s long; need at least {MIN_SONG_SEC:.0f}s")

    with tempfile.TemporaryDirectory(prefix="beatdrop-stems-") as tmp:
        tmp_dir = Path(tmp)
        # Decode first so Demucs never has to (avoids its ffmpeg dependency for MP3 input).
        input_wav = tmp_dir / "input.wav"
        sf.write(str(input_wav), mix, sample_rate, subtype="FLOAT")
        report("separating", 0.0)
        result_dir = run_demucs(input_wav, tmp_dir / "out", model=model, device=device,
                                demucs_python=demucs_python or default_demucs_python(), on_progress=report)
        stems = {DEMUCS_TO_STEM[name]: read_audio(result_dir / f"{name}.wav", sample_rate)
                 for name in DEMUCS_TO_STEM}

    report("analyzing", 0.0)
    lyrics = (lyrics_lookup.fetch_lyrics(title, artist, source_duration, start=start or 0.0,
                                         clip_duration=duration) if with_lyrics else None)
    manifest = prepare_track(stems, out_root=out_root, track_id=track_id, title=title, artist=artist,
                             sample_rate=sample_rate, fmt=fmt, source=f"demucs:{model}", mix=mix, bpm=bpm,
                             first_beat=first_beat, target_rms_db=target_rms_db, ceiling_db=ceiling_db,
                             lyrics=lyrics, cover=lyrics_lookup.read_cover(song), clip_start=start or 0.0,
                             source_duration=source_duration)
    report("done", 1.0)
    return manifest


# --------------------------------------------------------------------------- commands


def common_track_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--id", help="track id / folder name (default: slug of title)")
    p.add_argument("--title", help="display title (default: file tags, then file name)")
    p.add_argument("--artist", help="artist (default: file tags)")
    p.add_argument("--start", type=float, help="clip start in seconds (trim long songs to save memory)")
    p.add_argument("--duration", type=float, help="clip length in seconds")
    p.add_argument("--bpm", type=float, help="skip tempo estimation and use this BPM")
    p.add_argument("--first-beat", type=float, help="first beat time in seconds (after --start)")


def track_meta(args: argparse.Namespace, fallback_title: str) -> tuple[str, str]:
    title = args.title or fallback_title
    return (args.id or slugify(title)), title


def cmd_separate(args: argparse.Namespace) -> None:
    song = Path(args.song)
    title, artist = song_metadata(song, args.title, args.artist)
    track_id = args.id or slugify(title)
    shown: set[tuple[str, int]] = set()

    def show(stage: str, fraction: float) -> None:
        if (stage, int(fraction * 10)) not in shown:  # print each stage in 10% steps
            shown.add((stage, int(fraction * 10)))
            print(f"{stage} {fraction:.0%}", flush=True)

    separate_file(song, out_root=args.out, track_id=track_id, title=title, artist=artist,
                  with_lyrics=not args.no_lyrics,
                  sample_rate=args.sample_rate, fmt=args.format, start=args.start, duration=args.duration,
                  bpm=args.bpm, first_beat=args.first_beat, model=args.model, device=args.device,
                  demucs_python=args.demucs_python, target_rms_db=args.target_rms_db,
                  ceiling_db=args.ceiling_db, on_progress=show)


def cmd_import(args: argparse.Namespace) -> None:
    sr = args.sample_rate
    paths = {sid: getattr(args, sid) for sid in STEM_IDS if getattr(args, sid)}
    mix = read_audio(Path(args.mix), sr) if args.mix else None
    missing = [sid for sid in STEM_IDS if sid not in paths]
    if missing and (mix is None or len(missing) > 1):
        sys.exit(f"missing --{' --'.join(missing)} (one stem may be omitted if --mix is given)")

    stems = {sid: read_audio(Path(p), sr) for sid, p in paths.items()}
    if mix is not None and not args.no_align:
        for sid in list(stems):
            lag, corr = estimate_lag(mix, stems[sid], sr)
            if abs(lag) > 2 and corr > 0.1:  # +/-2 frames (<0.05 ms) is correlation noise
                print(f"aligning {sid}: shifting {lag:+d} frames ({lag / sr * 1000:+.1f} ms, corr {corr:.2f})")
                stems[sid] = shift(stems[sid], lag)
            elif abs(lag) > 2:
                print(f"warning: {sid} correlates weakly with the mix (corr {corr:.2f}); not shifting")
    if missing:
        frames = max(len(mix), *(len(x) for x in stems.values()))
        residual = fit_length(mix, frames) - sum(fit_length(x, frames) for x in stems.values())
        print(f"deriving {missing[0]} as mix minus the other stems")
        stems[missing[0]] = residual

    stems = {sid: clip_region(x, sr, args.start, args.duration) for sid, x in stems.items()}
    if mix is not None:
        mix = clip_region(mix, sr, args.start, args.duration)
    fallback = Path(args.mix or paths["vocals"]).stem
    track_id, title = track_meta(args, fallback)
    prepare_track(stems, out_root=args.out, track_id=track_id, title=title,
                  artist=args.artist or "Unknown Artist", sample_rate=sr, fmt=args.format, source="import", mix=mix, bpm=args.bpm,
                  first_beat=args.first_beat, target_rms_db=args.target_rms_db, ceiling_db=args.ceiling_db)


def cmd_demo(args: argparse.Namespace) -> None:
    from demo_synth import synth_track  # local module; only needed for demo tracks

    for spec in (dict(track_id="demo-a", title="Demo A (120 BPM, C major)", bpm=120.0, root=48,
                      minor=False, lead_in=0.3, seed=1),
                 dict(track_id="demo-b", title="Demo B (128 BPM, A minor)", bpm=128.0, root=45,
                      minor=True, lead_in=0.0, seed=2)):
        stems = synth_track(sample_rate=args.sample_rate, bars=args.bars, bpm=spec["bpm"], root=spec["root"],
                            minor=spec["minor"], lead_in=spec["lead_in"], seed=spec["seed"])
        prepare_track(stems, out_root=args.out, track_id=spec["track_id"], title=spec["title"],
                      artist="BeatDrop Synth", sample_rate=args.sample_rate, fmt=args.format,
                      source="synthetic", mix=sum(stems.values()),
                      target_rms_db=args.target_rms_db, ceiling_db=args.ceiling_db)


def cmd_verify(args: argparse.Namespace) -> None:
    dirs = ([args.out / t for t in args.tracks] if args.tracks else
            sorted(p.parent for p in args.out.glob("*/manifest.json") if not p.parent.name.startswith(".")))
    if not dirs:
        sys.exit(f"no prepared tracks in {args.out}")
    failed = False
    for d in dirs:
        problems = verify_track(d)
        failed |= bool(problems)
        print(f"{d.name}: {'OK' if not problems else '; '.join(problems)}")
    sys.exit(1 if failed else 0)


def cmd_lyrics(args: argparse.Namespace) -> None:
    track_dir = args.out / args.track
    manifest_path = track_dir / "manifest.json"
    if not manifest_path.exists():
        raise StemError(f"no prepared track {args.track!r} in {args.out}")
    m = json.loads(manifest_path.read_text())
    title, artist = args.title or m["title"], args.artist or m["artist"]
    lyrics = lyrics_lookup.fetch_lyrics(title, artist, m.get("sourceDurationSec", m["durationSec"]),
                                        start=m.get("clipStartSec", 0.0),
                                        clip_duration=m["durationSec"] if m.get("clipStartSec") else None)
    if not lyrics:
        raise StemError(f"no lyrics found for {artist} - {title}; try --title / --artist")
    (track_dir / "lyrics.json").write_text(json.dumps(lyrics, indent=1) + "\n")
    m["lyrics"] = "lyrics.json"
    tmp = track_dir / ".manifest.json.tmp"
    tmp.write_text(json.dumps(m, indent=2) + "\n")
    os.replace(tmp, manifest_path)
    kind = f"synced, {len(lyrics['lines'])} lines" if lyrics["synced"] else "plain text only"
    print(f"[{args.track}] lyrics: {lyrics['matchedArtist']} - {lyrics['matchedTitle']} ({kind})")


def cmd_cover(args: argparse.Namespace) -> None:
    track_dir = args.out / args.track
    manifest_path = track_dir / "manifest.json"
    if not manifest_path.exists():
        raise StemError(f"no prepared track {args.track!r} in {args.out}")
    cover = lyrics_lookup.read_cover(Path(args.song))
    if not cover:
        raise StemError(f"{args.song} has no embedded cover art")
    m = json.loads(manifest_path.read_text())
    (track_dir / f"cover.{cover[1]}").write_bytes(cover[0])
    m["cover"] = f"cover.{cover[1]}"
    tmp = track_dir / ".manifest.json.tmp"
    tmp.write_text(json.dumps(m, indent=2) + "\n")
    os.replace(tmp, manifest_path)
    print(f"[{args.track}] cover: {m['cover']} ({len(cover[0]) // 1024} KB)")


def cmd_index(args: argparse.Namespace) -> None:
    write_index(args.out)
    print(f"wrote {args.out / 'index.json'}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help=f"output root (default: {DEFAULT_OUT})")
    parser.add_argument("--sample-rate", type=int, default=DEFAULT_SAMPLE_RATE)
    parser.add_argument("--format", choices=("wav", "flac"), default="wav")
    parser.add_argument("--target-rms-db", type=float, default=DEFAULT_TARGET_RMS_DB)
    parser.add_argument("--ceiling-db", type=float, default=DEFAULT_CEILING_DB)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("separate", help="split a full song with Demucs")
    p.add_argument("song")
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--device", default="cpu",
                   help="Demucs device (default cpu; htdemucs crashes on Apple 'mps', use cuda on NVIDIA)")
    p.add_argument("--demucs-python",
                   help="python interpreter that has demucs installed (default: .venv-demucs if present)")
    p.add_argument("--no-lyrics", action="store_true", help="skip the online lyrics lookup")
    common_track_args(p)
    p.set_defaults(func=cmd_separate)

    p = sub.add_parser("import", help="prepare stems you already have")
    for sid in STEM_IDS:
        p.add_argument(f"--{sid}", metavar="FILE")
    p.add_argument("--mix", metavar="FILE", help="full song; used to align stems and check the result")
    p.add_argument("--no-align", action="store_true", help="trust stem offsets as-is")
    common_track_args(p)
    p.set_defaults(func=cmd_import)

    p = sub.add_parser("demo", help="synthesize two demo tracks")
    p.add_argument("--bars", type=int, default=32)
    p.set_defaults(func=cmd_demo)

    p = sub.add_parser("verify", help="check prepared tracks")
    p.add_argument("tracks", nargs="*")
    p.set_defaults(func=cmd_verify)

    p = sub.add_parser("lyrics", help="(re)fetch lyrics for a prepared track")
    p.add_argument("track", help="track id (folder name)")
    p.add_argument("--title", help="search with this title instead of the manifest's")
    p.add_argument("--artist", help="search with this artist instead of the manifest's")
    p.set_defaults(func=cmd_lyrics)

    p = sub.add_parser("cover", help="add cover art to a prepared track from its song file")
    p.add_argument("track", help="track id (folder name)")
    p.add_argument("song", help="the original audio file with embedded art")
    p.set_defaults(func=cmd_cover)

    p = sub.add_parser("index", help="rebuild index.json")
    p.set_defaults(func=cmd_index)

    args = parser.parse_args()
    args.out = args.out.resolve()
    args.out.mkdir(parents=True, exist_ok=True)
    try:
        args.func(args)
    except StemError as exc:
        sys.exit(str(exc))


if __name__ == "__main__":
    main()
