"""Copyright-free synthetic stems for development and tests.

Each track is a 4-chord loop with kick/snare/hat drums, an eighth-note bass line, a
chord pad (the "instrumental" stem) and a sung-style lead that enters and leaves every
4 bars, so vocal volume changes are easy to hear. Stems are built on one timeline,
so they are aligned by construction and the first kick lands exactly at `lead_in`.
"""

from __future__ import annotations

import numpy as np
from scipy import signal

MAJOR_PROGRESSION = [(0, (0, 4, 7)), (7, (0, 4, 7)), (9, (0, 3, 7)), (5, (0, 4, 7))]  # I V vi IV
MINOR_PROGRESSION = [(0, (0, 3, 7)), (8, (0, 4, 7)), (3, (0, 4, 7)), (10, (0, 4, 7))]  # i VI III VII


def midi_hz(note: float) -> float:
    return 440.0 * 2 ** ((note - 69) / 12)


def add(buf: np.ndarray, start: int, sig: np.ndarray, pan: float = 0.0) -> None:
    """Mix a mono signal into a stereo buffer at frame `start` with constant-power pan (-1..1)."""
    end = min(len(buf), start + len(sig))
    if end <= start:
        return
    angle = (pan + 1) * np.pi / 4
    buf[start:end, 0] += sig[: end - start] * np.cos(angle)
    buf[start:end, 1] += sig[: end - start] * np.sin(angle)


def envelope(n: int, sr: int, attack: float, release: float) -> np.ndarray:
    env = np.ones(n)
    a, r = min(n, int(attack * sr)), min(n, int(release * sr))
    if a:
        env[:a] = np.linspace(0, 1, a)
    if r:
        env[n - r:] *= np.linspace(1, 0, r)
    return env


def drum_samples(sr: int, rng: np.random.Generator) -> dict[str, np.ndarray]:
    t = np.arange(int(0.35 * sr)) / sr
    kick = np.sin(2 * np.pi * np.cumsum(45 + 110 * np.exp(-t * 30)) / sr) * np.exp(-t * 9)

    t = np.arange(int(0.2 * sr)) / sr
    band = signal.butter(2, [1000, 6000], btype="bandpass", fs=sr, output="sos")
    snare = (signal.sosfilt(band, rng.standard_normal(len(t))) * np.exp(-t * 20) * 0.8
             + np.sin(2 * np.pi * 180 * t) * np.exp(-t * 25) * 0.5)

    t = np.arange(int(0.05 * sr)) / sr
    high = signal.butter(2, 7000, btype="highpass", fs=sr, output="sos")
    hat = signal.sosfilt(high, rng.standard_normal(len(t))) * np.exp(-t * 60) * 0.5
    return {"kick": kick, "snare": snare, "hat": hat}


def synth_track(*, sample_rate: int, bars: int, bpm: float, root: int, minor: bool,
                lead_in: float, seed: int) -> dict[str, np.ndarray]:
    sr = sample_rate
    rng = np.random.default_rng(seed)
    beat = 60.0 / bpm
    n = int((lead_in + bars * 4 * beat + 1.0) * sr)
    stems = {name: np.zeros((n, 2)) for name in ("vocals", "drums", "bass", "instrumental")}
    progression = MINOR_PROGRESSION if minor else MAJOR_PROGRESSION
    at = lambda seconds: int(round(seconds * sr))  # noqa: E731

    # Drums: kick on every beat, snare on 2 and 4, hats on eighths.
    kit = drum_samples(sr, rng)
    for b in range(bars * 4):
        t0 = lead_in + b * beat
        add(stems["drums"], at(t0), kit["kick"])
        if b % 4 in (1, 3):
            add(stems["drums"], at(t0), kit["snare"])
        add(stems["drums"], at(t0), kit["hat"] * 0.6, pan=0.3)
        add(stems["drums"], at(t0 + beat / 2), kit["hat"], pan=0.3)

    lowpass = signal.butter(2, 600, btype="lowpass", fs=sr, output="sos")
    for bar in range(bars):
        chord_root, triad = progression[bar % len(progression)]
        bar_start = lead_in + bar * 4 * beat

        # Bass: filtered saw on eighth notes, octave jump on the off-beats.
        for step in range(8):
            note = root - 12 + chord_root + (12 if step % 2 else 0)
            length = int(beat / 2 * sr * 0.9)
            t = np.arange(length) / sr
            saw = 2 * ((t * midi_hz(note)) % 1.0) - 1
            add(stems["bass"], at(bar_start + step * beat / 2),
                signal.sosfilt(lowpass, saw) * envelope(length, sr, 0.005, 0.03) * 0.5)

        # Instrumental: detuned chord pad, slightly wide.
        length = int(4 * beat * sr)
        t = np.arange(length) / sr
        env = envelope(length, sr, 0.25, 0.4)
        for i, interval in enumerate(triad):
            f = midi_hz(root + 12 + chord_root + interval)
            for detune, pan in ((0.998, -0.6), (1.002, 0.6)):
                add(stems["instrumental"], at(bar_start), np.sin(2 * np.pi * f * detune * t) * env * 0.08,
                    pan=pan * (1 if i % 2 else -1))

        # Vocals: sung on alternating 4-bar phrases (silent otherwise).
        if (bar // 4) % 2:
            continue
        melody = [triad[0], triad[1], triad[2], triad[1] if bar % 2 else 12]
        for step, interval in enumerate(melody):
            length = int(beat * sr * 0.95)
            t = np.arange(length) / sr
            vibrato = 0.35 * np.sin(2 * np.pi * 5.5 * t) * np.clip((t - 0.12) / 0.1, 0, 1)
            freq = midi_hz(root + 24 + chord_root + interval + vibrato)
            phase = 2 * np.pi * np.cumsum(freq) / sr
            voice = np.sin(phase) + 0.5 * np.sin(2 * phase) + 0.25 * np.sin(3 * phase)
            add(stems["vocals"], at(bar_start + step * beat), voice * envelope(length, sr, 0.04, 0.08) * 0.2)

    return {name: buf.astype(np.float32) for name, buf in stems.items()}
