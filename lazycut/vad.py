"""Energy VAD on 16 kHz mono audio (wraps the tuned band-energy VAD in _vadcore)."""
from __future__ import annotations

import wave
from dataclasses import dataclass

import numpy as np

from . import _vadcore as core

FPS = core.FPS  # 100 frames / s


@dataclass
class VadResult:
    db: np.ndarray        # float32 [n, 2] band energies (dB), smoothed
    threshold: np.ndarray  # float32 [n, 2] off-thresholds
    voiced: np.ndarray    # bool [n]
    duration: float

    def as_tuple(self):
        """Tuple form expected by _vadcore/_recover helpers."""
        return (self.db, self.threshold, self.voiced)


def load_wav16k(path: str) -> np.ndarray:
    """Read a 16 kHz mono s16 wav into float32 [-1, 1]."""
    with wave.open(path, "rb") as w:
        if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError("16kHz mono 16-bit wav만 읽을 수 있어요: %s" % path)
        n = w.getnframes()
        out = np.empty(n, dtype=np.float32)
        pos = 0
        while pos < n:
            buf = w.readframes(min(16000 * 60, n - pos))
            if not buf:
                break
            a = np.frombuffer(buf, dtype=np.int16)
            out[pos:pos + len(a)] = a.astype(np.float32) / 32768.0
            pos += len(a)
    return out[:pos]


def analyze(samples: np.ndarray, sr: int = 16000) -> VadResult:
    if sr != 16000:
        raise ValueError("VAD expects 16 kHz audio")
    db, thr, mask = core.analyze(samples)
    return VadResult(db=db, threshold=thr, voiced=mask.astype(bool), duration=len(samples) / 16000.0)


def voiced_regions(v: VadResult, min_dur: float = 0.15, merge_gap: float = 0.1) -> list:
    regs = core.voiced_regions(v.as_tuple(), 0.0)
    merged: list = []
    for a, b in regs:
        if merged and a - merged[-1][1] < merge_gap:
            merged[-1] = (merged[-1][0], b)
        else:
            merged.append((a, b))
    return [(float(a), float(b)) for a, b in merged if b - a >= min_dur]


def voiced_fraction(v: VadResult, s: float, e: float) -> float:
    a, b = int(max(0, s * FPS)), int(min(len(v.voiced), e * FPS))
    if b <= a:
        return 0.0
    return float(v.voiced[a:b].mean())
