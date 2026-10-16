"""Korean subtitle line splitting (meaning-unit aware). See research/subtitle_split_22.md."""
from __future__ import annotations

from . import _splitrules as rules


def split_lines(words: list, max_chars: int = 22, **opts) -> list:
    """words: word tokens {"text","start","end"} in order. Returns sorted line-start indices (starts with 0).

    Pauses come from the gaps between (VAD-refined) word times, so pause_mode="gap" is used by default.
    """
    if not words:
        return []
    opts.setdefault("pause_mode", "gap")
    opts.setdefault("min_chars", 8)   # avoid 2-4 char lines that flip mid-speech
    return rules.split_lines(words, max_chars=max_chars, **opts)


def caption_text(texts: list) -> str:
    """Caption text for a line: the user's SRT convention keeps , ? ! but drops sentence-final periods."""
    ws = [{"text": t} for t in texts]
    return rules.caption_text(ws)
