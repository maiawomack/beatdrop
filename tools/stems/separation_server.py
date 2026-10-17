#!/usr/bin/env python3
"""BeatDrop stem-separation service (Task 5).

The web app uploads a raw audio file; this separates it with Demucs through the same
pipeline as `prepare_stems.py separate` and serves the aligned stems back. It listens
on 127.0.0.1 only and handles one separation at a time (Demucs uses every CPU core).

    POST /separate?filename=&title=&artist=&start=&duration=   body: the raw file bytes
         -> 202 job (200 with state "done" if this exact audio was separated before)
    GET  /jobs/<id>      -> job
    GET  /tracks         -> index.json of every prepared track
    GET  /stems/<path>   -> prepared files (<track-id>/manifest.json, waveform.json, *.wav)
    GET  /health         -> {"ok": true, "demucs": bool, "queued": int}

    job = {"id", "trackId", "state": queued|decoding|separating|analyzing|done|error,
           "progress": 0..1, "manifestUrl": "/stems/<id>/manifest.json" | null, "error": str | null}

Job ids are a hash of the audio bytes plus start/duration, so re-uploading a song
returns the existing stems immediately, even after a server restart.

Run with the pipeline venv (Demucs itself runs from .venv-demucs):
    .venv/bin/python tools/stems/separation_server.py
"""

from __future__ import annotations

import argparse
import hashlib
import json
import queue
import re
import shutil
import subprocess
import tempfile
import threading
import traceback
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

import prepare_stems as ps

DEFAULT_PORT = 8765
DEFAULT_MAX_UPLOAD_MB = 300
# Share of the overall progress bar each stage covers (separation dominates).
STAGE_SPAN = {"queued": (0.0, 0.0), "decoding": (0.0, 0.05), "separating": (0.05, 0.9),
              "analyzing": (0.9, 1.0), "done": (1.0, 1.0)}
LOCAL_ORIGIN = re.compile(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$")
CONTENT_TYPES = {".json": "application/json", ".wav": "audio/wav", ".flac": "audio/flac"}
AUDIO_SUFFIXES = {".wav", ".flac", ".mp3", ".ogg", ".oga", ".m4a", ".aac", ".mp4", ".aif", ".aiff", ".caf"}


class Separator:
    """Owns the job table and the single worker thread that runs separations."""

    def __init__(self, out_root: Path, settings: dict) -> None:
        self.out_root = out_root
        self.settings = settings
        self.jobs: dict[str, dict] = {}
        self.lock = threading.Lock()
        self.queue: queue.Queue[tuple[str, Path, dict]] = queue.Queue()
        threading.Thread(target=self._work, daemon=True, name="separator").start()

    def submit(self, job_id: str, upload: Path, params: dict) -> tuple[dict, bool]:
        """Queue a separation unless it is done or already in flight. Returns (job, queued)."""
        with self.lock:
            existing = self._lookup(job_id)
            if existing and existing["state"] != "error":
                return existing, False
            job = {"id": job_id, "trackId": job_id, "state": "queued", "progress": 0.0,
                   "manifestUrl": None, "error": None}
            self.jobs[job_id] = job
            self.queue.put((job_id, upload, params))
            return dict(job), True

    def get(self, job_id: str) -> dict | None:
        with self.lock:
            return self._lookup(job_id)

    def _lookup(self, job_id: str) -> dict | None:
        job = self.jobs.get(job_id)
        if job is None and (self.out_root / job_id / "manifest.json").exists():
            job = self.jobs[job_id] = self._done(job_id)
        return dict(job) if job else None

    def _done(self, job_id: str) -> dict:
        return {"id": job_id, "trackId": job_id, "state": "done", "progress": 1.0,
                "manifestUrl": f"/stems/{job_id}/manifest.json", "error": None}

    def _update(self, job_id: str, **fields) -> None:
        with self.lock:
            self.jobs[job_id].update(fields)

    def _work(self) -> None:
        while True:
            job_id, upload, params = self.queue.get()

            def progress(stage: str, fraction: float, job_id: str = job_id) -> None:
                lo, hi = STAGE_SPAN[stage]
                self._update(job_id, state=stage, progress=round(lo + (hi - lo) * min(fraction, 1.0), 3))

            try:
                ps.separate_file(upload, out_root=self.out_root, track_id=job_id, on_progress=progress,
                                 **params, **self.settings)
                with self.lock:
                    self.jobs[job_id] = self._done(job_id)
            except ps.StemError as exc:
                print(f"[{job_id}] failed: {exc}")
                self._update(job_id, state="error", error=str(exc))
            except Exception as exc:  # keep the worker alive whatever happens
                traceback.print_exc()
                self._update(job_id, state="error", error=f"internal error: {exc}")
            finally:
                shutil.rmtree(upload.parent, ignore_errors=True)


def make_handler(separator: Separator, out_root: Path, max_upload: int, extra_origins: set[str],
                 demucs_ok: bool) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "BeatDropStems/1"

        # ------------------------------------------------------------ routing

        def do_OPTIONS(self) -> None:  # CORS preflight (uploads send audio/* content types)
            self.send_response(HTTPStatus.NO_CONTENT)
            self._cors()
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Max-Age", "600")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self) -> None:
            path = urlsplit(self.path).path
            if path == "/health":
                self._json({"ok": True, "demucs": demucs_ok, "queued": separator.queue.qsize()})
            elif path == "/tracks":
                if (out_root / "index.json").exists():
                    self._file(out_root / "index.json")
                else:
                    self._json({"version": ps.MANIFEST_VERSION, "tracks": []})
            elif path.startswith("/jobs/"):
                job = separator.get(unquote(path[len("/jobs/"):]))
                self._json(job) if job else self._error(HTTPStatus.NOT_FOUND, "unknown job")
            elif path.startswith("/stems/"):
                self._static(unquote(path[len("/stems/"):]))
            else:
                self._error(HTTPStatus.NOT_FOUND, "not found")

        def do_POST(self) -> None:
            url = urlsplit(self.path)
            if url.path != "/separate":
                self._error(HTTPStatus.NOT_FOUND, "not found")
                return
            if not self._origin_allowed():
                # CORS alone only hides the response; a foreign page could still start jobs.
                self._error(HTTPStatus.FORBIDDEN, "origin not allowed")
                return
            try:
                params = self._separate_params(parse_qs(url.query))
            except ValueError as exc:
                self._error(HTTPStatus.BAD_REQUEST, str(exc))
                return
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0:
                self._error(HTTPStatus.LENGTH_REQUIRED, "send the audio file as the request body")
                return
            if length > max_upload:
                self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                            f"file is {length / 1e6:.0f} MB; limit is {max_upload / 1e6:.0f} MB")
                return

            # Stream the body to disk while hashing it; the hash is the job/track id.
            upload_dir = Path(tempfile.mkdtemp(prefix="beatdrop-upload-"))
            upload = upload_dir / params.pop("upload_name")
            digest = hashlib.sha256(f"{params.get('start')}|{params.get('duration')}|".encode())
            remaining = length
            with upload.open("wb") as fh:
                while remaining:
                    chunk = self.rfile.read(min(remaining, 1 << 20))
                    if not chunk:
                        break
                    fh.write(chunk)
                    digest.update(chunk)
                    remaining -= len(chunk)
            if remaining:
                shutil.rmtree(upload_dir, ignore_errors=True)
                self._error(HTTPStatus.BAD_REQUEST, "upload ended early")
                return

            job, queued = separator.submit(f"t-{digest.hexdigest()[:12]}", upload, params)
            if not queued:
                shutil.rmtree(upload_dir, ignore_errors=True)
            else:
                print(f"[{job['id']}] queued {params['title']!r}")
            self._json(job, HTTPStatus.ACCEPTED if job["state"] != "done" else HTTPStatus.OK)

        # ------------------------------------------------------------ helpers

        @staticmethod
        def _separate_params(query: dict[str, list[str]]) -> dict:
            first = lambda key: (query.get(key) or [""])[0].strip()  # noqa: E731
            filename = Path(first("filename")).name
            suffix = Path(filename).suffix.lower()
            params: dict = {"title": first("title") or Path(filename).stem or "Untitled",
                            "artist": first("artist") or "Unknown Artist",
                            "upload_name": ps.slugify(Path(filename).stem)[:60]
                            + (suffix if suffix in AUDIO_SUFFIXES else "")}
            for key in ("start", "duration"):
                if first(key):
                    try:
                        value = float(first(key))
                    except ValueError:
                        raise ValueError(f"{key} must be a number of seconds") from None
                    if value < 0 or (key == "duration" and value == 0):
                        raise ValueError(f"{key} must be positive")
                    params[key] = value
            return params

        def _static(self, rel: str) -> None:
            target = (out_root / rel).resolve()
            inside = target.is_relative_to(out_root) and target != out_root
            if not inside or any(part.startswith(".") for part in target.relative_to(out_root).parts) \
                    or not target.is_file():
                self._error(HTTPStatus.NOT_FOUND, "not found")
                return
            self._file(target)

        def _file(self, path: Path) -> None:
            size = path.stat().st_size
            self.send_response(HTTPStatus.OK)
            self._cors()
            self.send_header("Content-Type", CONTENT_TYPES.get(path.suffix, "application/octet-stream"))
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            with path.open("rb") as fh:
                shutil.copyfileobj(fh, self.wfile, 1 << 20)

        def _json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
            body = json.dumps(payload).encode()
            self.send_response(status)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _error(self, status: HTTPStatus, message: str) -> None:
            # An unread upload body would be parsed as the next request; drop the connection.
            if self.command == "POST":
                self.close_connection = True
            self._json({"error": message}, status)

        def _origin_allowed(self) -> bool:
            """Pages served from this machine (or --allow-origin) only. No Origin = curl/scripts."""
            origin = self.headers.get("Origin")
            return origin is None or bool(LOCAL_ORIGIN.match(origin)) or origin in extra_origins

        def _cors(self) -> None:
            origin = self.headers.get("Origin")
            if origin and self._origin_allowed():
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")

        def log_message(self, fmt: str, *args) -> None:
            if not self.path.startswith("/jobs/"):  # job polling would flood the log
                super().log_message(fmt, *args)

    return Handler


def check_demucs(python: str) -> bool:
    try:
        return subprocess.run([python, "-c", "import demucs"], capture_output=True).returncode == 0
    except OSError:
        return False


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--out", type=Path, default=ps.DEFAULT_OUT, help="where prepared tracks are written")
    parser.add_argument("--model", default=ps.DEFAULT_MODEL)
    parser.add_argument("--device", default="cpu", help="Demucs device (cpu, or cuda on NVIDIA)")
    parser.add_argument("--demucs-python", default=ps.default_demucs_python())
    parser.add_argument("--format", choices=("wav", "flac"), default="wav")
    parser.add_argument("--sample-rate", type=int, default=ps.DEFAULT_SAMPLE_RATE)
    parser.add_argument("--max-upload-mb", type=int, default=DEFAULT_MAX_UPLOAD_MB)
    parser.add_argument("--allow-origin", action="append", default=[],
                        help="extra CORS origin besides localhost (repeatable)")
    args = parser.parse_args()

    out_root = args.out.resolve()
    out_root.mkdir(parents=True, exist_ok=True)
    demucs_ok = check_demucs(args.demucs_python)
    if not demucs_ok:
        print(f"WARNING: Demucs not importable with {args.demucs_python}; uploads will fail. "
              "See tools/stems/README.md.")

    settings = {"model": args.model, "device": args.device, "demucs_python": args.demucs_python,
                "fmt": args.format, "sample_rate": args.sample_rate}
    separator = Separator(out_root, settings)
    handler = make_handler(separator, out_root, args.max_upload_mb * 1_000_000, set(args.allow_origin), demucs_ok)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"BeatDrop stem separation on http://{args.host}:{args.port}  (stems in {out_root})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
