"""Perceptron check for gesture calibration (spatial screen, press C).

Calibration labels hand samples by the prompt on screen ("OPEN", then "FIST"), so a
frame where the hand was still closing, half-open or out of view gets the wrong label
and the grab model learns from it. This asks Perceptron (perceptron-mk1.5, via the
official `perceptron` SDK) what pose each calibration snapshot actually shows, so those
samples can be dropped before training.

Perceptron only names the pose. Which poses count is decided here (`accepted`), and the
numeric model is still trained from MediaPipe landmarks in the browser.

The API key is read from PERCEPTRON_API_KEY, or from a `.env.local` file at the repo root
(git-ignored). Snapshots are only held in memory for the request.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

MODEL = "perceptron-mk1.5"
REPO_ROOT = Path(__file__).resolve().parents[2]
MAX_FRAMES = 24
MAX_FRAME_BYTES = 400_000

#: What Perceptron may answer for each snapshot.
POSES = ["fist", "open_hand", "pinch", "pointing", "partly_closed", "no_hand", "other"]

#: Requested calibration step -> poses that are valid examples of it. The OPEN step
#: collects "anything that is NOT a grab", so it only rejects fists and missing hands.
ACCEPTED = {
    "fist": {"fist"},
    "open": {"open_hand", "pinch", "pointing", "partly_closed", "other"},
}

SCHEMA = {
    "type": "object",
    "properties": {
        "frames": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "index": {"type": "integer"},
                    "pose": {"type": "string", "enum": POSES},
                },
                "required": ["index", "pose"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["frames"],
    "additionalProperties": False,
}

PROMPT = (
    "Each numbered frame is a webcam snapshot of a person's hand(s). For every frame, classify the "
    "pose of the most prominent hand: fist (all fingers curled into the palm), open_hand (fingers "
    "extended or relaxed), pinch (thumb and index fingertips touching, other fingers open), pointing "
    "(index extended, others curled), partly_closed (fingers half curled, not a fist), no_hand (no hand "
    "clearly visible), or other. Answer for every frame index."
)


class GestureCheckUnavailable(Exception):
    """Perceptron can't be used right now (no key, SDK missing, API error). Calibrate locally."""


def api_key() -> str | None:
    key = os.environ.get("PERCEPTRON_API_KEY")
    if key:
        return key.strip()
    env_file = REPO_ROOT / ".env.local"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            name, _, value = line.partition("=")
            if name.strip() == "PERCEPTRON_API_KEY" and value.strip():
                return value.strip().strip('"').strip("'")
    return None


def available() -> bool:
    try:
        import perceptron  # noqa: F401
    except ImportError:
        return False
    return api_key() is not None


def classify(frames: list[bytes], *, timeout: float = 30.0) -> list[str]:
    """Pose name for each JPEG snapshot, in order. Raises GestureCheckUnavailable."""
    if not frames or len(frames) > MAX_FRAMES:
        raise ValueError(f"send 1 to {MAX_FRAMES} frames")
    if any(len(f) > MAX_FRAME_BYTES for f in frames):
        raise ValueError("a frame is too large; send small JPEG snapshots")
    key = api_key()
    if not key:
        raise GestureCheckUnavailable("no Perceptron API key (set PERCEPTRON_API_KEY or .env.local)")
    try:
        from perceptron import Client, image
    except ImportError as exc:
        raise GestureCheckUnavailable("Perceptron SDK not installed: pip install 'perceptron>=0.4.0'") from exc

    content: list = []
    for i, frame in enumerate(frames):
        content += [f"Frame {i}:", image(frame)]
    content.append(PROMPT)
    try:
        response = Client(api_key=key, provider="perceptron").chat.completions.create(
            model=MODEL,
            messages=[{"role": "user", "content": content}],
            max_completion_tokens=40 * len(frames) + 100,
            temperature=0,
            response_format={
                "type": "json_schema",
                "json_schema": {"name": "hand_poses", "strict": True, "schema": SCHEMA},
            },
            timeout=timeout,
        )
    except Exception as exc:  # network, auth, rate limit, bad request
        raise GestureCheckUnavailable(f"Perceptron request failed: {exc}") from exc

    choice = response.choices[0]
    if choice.finish_reason != "stop":
        raise GestureCheckUnavailable(f"Perceptron answer incomplete ({choice.finish_reason})")
    return parse(choice.message.content or "", len(frames))


def parse(text: str, count: int) -> list[str]:
    """Validate the structured answer; never trust it blindly."""
    try:
        data = json.loads(text)
        items = data["frames"]
        poses: dict[int, str] = {}
        for item in items:
            index, pose = item["index"], item["pose"]
            if isinstance(index, int) and 0 <= index < count and pose in POSES:
                poses.setdefault(index, pose)
    except (ValueError, KeyError, TypeError) as exc:
        raise GestureCheckUnavailable(f"Perceptron answer was not valid JSON for the schema: {exc}") from exc
    if len(poses) != count:
        raise GestureCheckUnavailable(f"Perceptron answered for {len(poses)} of {count} frames")
    return [poses[i] for i in range(count)]


def assess(step: str, frames: list[bytes]) -> list[dict]:
    """Per-frame verdict for one calibration step ("open" or "fist")."""
    if step not in ACCEPTED:
        raise ValueError(f"unknown calibration step {step!r}")
    return [{"pose": pose, "keep": pose in ACCEPTED[step]} for pose in classify(frames)]
