"""Lazy - Cut (레이지 컷) — text-based cut editing + subtitles at a glance, running locally.

Keep this module tiny: it is imported by every entry point (launcher, server,
transcription worker subprocess), so it must not pull in heavy dependencies.
"""
from __future__ import annotations

__version__ = "1.0.0"
APP_NAME = "Lazy - Cut"
