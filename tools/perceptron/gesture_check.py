"""Perceptron AI (DubHacks Perception track) for BeatDrop's gesture calibration stage.

During calibration the spatial screen asks the user to demonstrate a gesture for a few
seconds. Prompt-timed labels can't tell whether the hand was actually doing it (still
closing, drifting open, out of frame), so the demonstration is sent to Perceptron's
Mk1.5 model as a short video (`video_frames`) and the model is asked to *find the events*:
the time intervals in which the requested gesture is performed
(`vision_config={"annotation_format": "clip"}`, parsed with the SDK's `extract_clips`).

BeatDrop then trains only on MediaPipe landmark data from inside those intervals.
Perceptron finds *when* the gesture happens; it never sets thresholds.

The API key is read from PERCEPTRON_API_KEY or `.env.local` at the repo root (git-ignored).
Frames are only held in memory for the request.
"""

from __future__ import annotations

import os
from pathlib import Path

MODEL = "perceptron-mk1.5"
REPO_ROOT = Path(__file__).resolve().parents[2]
MIN_FRAMES = 2
MAX_FRAMES = 64  # documented limit is 256 media units per request; a 4 s demo at 5 fps is 20
MAX_FRAME_BYTES = 400_000
#: Frames sent for the per-frame pose check (spread across the demo).
POSE_CHECK_FRAMES = 8

#: What each calibration demonstration should show, phrased for the video question.
GESTURES = {
    "open": "the person's hand is open or relaxed (fingers extended or loosely curled), not closed into a fist",
    "fist": "the person is holding a closed fist, with all fingers curled into the palm",
    # In Mk1.5's own words for the pose; describing it as "upside down ... like holding a string"
    # made the video model mark the wrong part of the demo.
    "lift": "the hand is clenched with the fingers pointing downward and the fingertips touching each other",
    # Checks for the live gestures (no thresholds): stem volume and crossfade.
    "pinch": "the person's thumb tip and index fingertip are touching or nearly touching (a pinch, like an OK sign or gripping something small), held",
    "point": "the person is pointing one or two fingers straight up (index, or index and middle) with the other fingers folded",
}


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


#: Pose labels for the per-frame check, and which ones count for each demonstration.
POSES = ["fist", "open_hand", "pinch", "pointing", "two_fingers", "partly_closed", "lift", "no_hand", "other"]
ACCEPTED = {
    "fist": {"fist"},
    "open": {"open_hand", "pinch", "pointing", "partly_closed", "other"},  # anything that is not a grab
    # "Lift" is BeatDrop's own name; Mk1.5 describes it as "a fist with the fingers pointing
    # downward and the fingertips touching" and labels its frames "fist". So Perceptron confirms
    # a closed/bunched hand is held; MediaPipe checks the fingers point down (only those frames
    # count for the lift threshold). Asking Mk1.5 for the finger direction as JSON was unreliable.
    # BeatDrop's lift also counts with the fingers hanging straight down together (thumb anywhere);
    # MediaPipe checks they point down, so a hand Mk1.5 calls open is fine here too.
    "lift": {"lift", "fist", "pinch", "partly_closed", "open_hand"},
    # A pinch with the other fingers out reads to Mk1.5 like an OK sign (often "open_hand"), and
    # with them curled like a half-closed hand. This step only reports how BeatDrop's own pinch
    # detector did (nothing is tuned from it), so accept those and let the video clip decide when.
    "pinch": {"pinch", "partly_closed", "open_hand", "other", "pointing"},
    "point": {"pointing", "two_fingers"},
}
POSE_SCHEMA = {
    "type": "object",
    "properties": {
        "frames": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"index": {"type": "integer"}, "pose": {"type": "string", "enum": POSES}},
                "required": ["index", "pose"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["frames"],
    "additionalProperties": False,
}
POSE_PROMPT = (
    "Each numbered frame is a webcam image of a person's hand. For every frame, classify the most prominent "
    "hand: fist (all fingers curled into the palm), open_hand (fingers extended or relaxed), pinch (thumb and "
    "index fingertips touching), pointing (index extended, others curled), two_fingers (index and middle "
    "extended in a V, others curled), partly_closed (fingers half curled, "
    "not a fist), lift (hand upside down with the thumb, index and middle fingertips bunched together pointing "
    "down), no_hand (no hand clearly visible), or other. Answer for every frame index."
)


def find_segments(gesture: str, frames: list[tuple[bytes, int]], *, timeout: float = 40.0) -> dict:
    """When does the demonstration show `gesture`?

    Two Perceptron capabilities, cross-checked (each was unreliable alone in testing):
      1. video understanding, "find events in a video": the frames go in as one video
         (`video_frames`) and Mk1.5 marks the intervals with clip annotations. It times
         real events precisely, but also returned an interval for a video with no hand in it.
      2. image understanding with structured output: each frame's pose, as JSON. Reliable
         about what is in a frame, but has no notion of the event.
    A moment counts only where both agree: inside a clip AND on a frame showing the pose.

    `frames` are (JPEG bytes, timestamp ms from the start of the clip), all the same size.
    Returns {"segments": [[start_s, end_s], ...], "clips", "poses", "summary"}.
    """
    if gesture not in GESTURES:
        raise ValueError(f"unknown gesture {gesture!r}")
    if not MIN_FRAMES <= len(frames) <= MAX_FRAMES:
        raise ValueError(f"send {MIN_FRAMES} to {MAX_FRAMES} frames")
    times = [t for _, t in frames]
    if any(not isinstance(t, int) or t < 0 for t in times) or times != sorted(times):
        raise ValueError("frame timestamps must be non-negative integers in order")
    if any(len(f) > MAX_FRAME_BYTES for f, _ in frames):
        raise ValueError("a frame is too large; send small JPEG snapshots")
    key = api_key()
    if not key:
        raise GestureCheckUnavailable("no Perceptron API key (set PERCEPTRON_API_KEY or .env.local)")
    try:
        from perceptron import Client, extract_clips, image, strip_tags, video_frames
    except ImportError as exc:
        raise GestureCheckUnavailable("Perceptron SDK not installed: pip install 'perceptron>=0.4.0'") from exc
    client = Client(api_key=key, provider="perceptron")

    def ask(**kwargs):
        try:
            response = client.chat.completions.create(model=MODEL, temperature=0, timeout=timeout, **kwargs)
        except Exception as exc:  # network, auth, rate limit, bad request
            raise GestureCheckUnavailable(f"Perceptron request failed: {exc}") from exc
        choice = response.choices[0]
        if choice.finish_reason != "stop":
            raise GestureCheckUnavailable(f"Perceptron answer incomplete ({choice.finish_reason})")
        return choice.message.content or ""

    # 1. Video event finding.
    clip_text = ask(
        messages=[{"role": "user", "content": [
            video_frames(frames),
            "This video shows a person demonstrating a hand gesture to a webcam to calibrate a gesture "
            f"controller. Find every time interval in which {GESTURES[gesture]}. Mark each interval with a clip.",
        ]}],
        vision_config={"annotation_format": "clip"},
        max_completion_tokens=512,
    )
    clips = validate(extract_clips(clip_text), times[-1] / 1000)

    # 2. Pose check on up to POSE_CHECK_FRAMES evenly spaced frames (structured output). With
    #    20 frames the model labeled only some of them; each checked frame vouches for its
    #    neighbours instead.
    picks = sorted({round(i * (len(frames) - 1) / (POSE_CHECK_FRAMES - 1)) for i in range(POSE_CHECK_FRAMES)})
    content: list = []
    for k, i in enumerate(picks):
        content += [f"Frame {k}:", image(frames[i][0])]
    content.append(f"There are {len(picks)} frames, numbered 0 to {len(picks) - 1}. " + POSE_PROMPT)
    checked = parse_poses(ask(
        messages=[{"role": "user", "content": content}],
        max_completion_tokens=40 * len(picks) + 100,
        response_format={"type": "json_schema", "json_schema": {"name": "hand_poses", "strict": True, "schema": POSE_SCHEMA}},
    ), len(picks))
    # Every frame takes the pose of the nearest checked frame (None = not labeled: unverified).
    poses = [checked[min(range(len(picks)), key=lambda k: abs(picks[k] - i))] for i in range(len(frames))]

    # 3. Keep only frames that are inside a clip and show the pose; turn runs of them into segments.
    step = (times[-1] - times[0]) / max(1, len(times) - 1) / 1000  # seconds between frames
    ok = [pose in ACCEPTED[gesture] and any(a - step / 2 <= t / 1000 <= b + step / 2 for a, b in clips)
          for (_, t), pose in zip(frames, poses)]
    segments: list[list[float]] = []
    for (_, t), good in zip(frames, ok):
        if not good:
            continue
        sec = t / 1000
        if segments and sec - segments[-1][1] <= step * 1.5:
            segments[-1][1] = round(sec + step, 3)
        else:
            segments.append([round(sec, 3), round(sec + step, 3)])
    return {"segments": segments, "clips": clips, "poses": poses, "summary": " ".join(strip_tags(clip_text).split())[:160]}


def parse_poses(text: str, count: int) -> list[str | None]:
    """Validate the per-frame JSON answer; never trust it blindly. Frames the model didn't
    label (or labeled with something off-schema) come back as None, i.e. unverified."""
    import json

    try:
        found: dict[int, str] = {}
        for item in json.loads(text)["frames"]:
            index, pose = item["index"], item["pose"]
            if isinstance(index, int) and 0 <= index < count and pose in POSES:
                found.setdefault(index, pose)
    except (ValueError, KeyError, TypeError) as exc:
        raise GestureCheckUnavailable(f"Perceptron pose answer was not valid JSON for the schema: {exc}") from exc
    if not found:
        raise GestureCheckUnavailable("Perceptron labeled none of the frames")
    return [found.get(i) for i in range(count)]


def validate(clips: list, duration: float) -> list[list[float]]:
    """Keep only well-formed intervals on this video's timeline, clamped and merged."""
    spans: list[list[float]] = []
    slack = 0.5  # the model may round the end of the last interval up a little
    for clip in clips:
        ts = clip.timestamp
        if clip.asset_idx not in (None, 0) or ts.until is None:
            continue  # another asset, or a single moment rather than a held interval
        start, end = float(ts.at), float(ts.until)
        if not (0 <= start < end <= duration + slack):
            continue
        spans.append([round(start, 3), round(min(end, duration), 3)])
    spans.sort()
    merged: list[list[float]] = []
    for span in spans:
        if merged and span[0] <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], span[1])
        else:
            merged.append(span)
    return merged
