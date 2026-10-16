# Lazy - Cut

**Edit your talking-head video like a document — see every word, silence and retake at a glance, and cut with one key.**

[한국어 가이드 → README.ko.md](README.ko.md)

![Lazy - Cut demo](assets/demo.gif)

Lazy - Cut transcribes your video, lays it out as subtitle lines made of word chips, and lets you cut by deleting words.
It finds silences, filler sounds and retakes (NG) for you, then exports a **frame-accurate cut mp4 + SRT subtitles**.
Everything runs **locally on your Mac** — your video never leaves the machine.

## Features

- **Text-based cutting** — delete a word chip and that part of the video is gone (press again to restore)
- **One-glance timeline** — clip cards with thumbnails, a waveform timeline, kept/cut parts in color
- **Silence trimming** — shorten every silence longer than X seconds in one go
- **Retake (NG) & stutter hints** — repeated takes and stutters are flagged; the last take is kept
- **Subtitles that read well** — lines are split by meaning (no "verb / noun" breaks), fully editable
- **Keyboard-only editing** — cut at the playhead, trim clip heads/tails, mark in/out, nudge boundaries
- **Export** — cut mp4 (original quality, hardware encoding) + SRT, ready for CapCut / Premiere / Final Cut

## Requirements

- Apple Silicon Mac (M1 or later) — Intel Macs are not supported
- macOS 13.5 or later
- About 4 GB of free space (app ~1 GB + speech model ~1.5 GB)
- Google Chrome recommended (falls back to your default browser)

## Install

1. Download `Lazy-Cut-<version>.zip` from **Releases** and unzip it.
2. **Right-click `install.command` → Open** (a plain double-click is blocked by Gatekeeper the first time).
3. Wait until the Terminal window says **"설치 완료!"** (Done). It takes a few minutes the first time.
   - If an Xcode Command Line Tools dialog appears, install it and run `install.command` again.
4. Open **Lazy - Cut** from Spotlight (⌘ + Space) or Launchpad.

The speech-recognition model (~1.5 GB) is downloaded once, the first time you transcribe.

## How to use

1. **Open a video** (영상 불러오기) and start transcription. *Fast* (turbo) is recommended — about 4–5 min for a 17-min video.
2. **Cut**: click a word and press **Delete**. Deleted parts turn red and are skipped in the preview.
3. **Trim silences** (무음 구간 줄이기): e.g. "silences ≥ 0.15 s → 0 s" for tight jump cuts.
4. **Review hints**: 군말 (fillers) and NG·반복 (retakes / stutters) panels list suggestions you can delete in bulk.
5. **Fix subtitles**: double-click a word to correct it, or edit the subtitle line under each clip.
6. **Export** (내보내기): saves `<name> 컷편집.mp4` and `.srt` next to the original video.

Your edits are saved automatically to a `.lazycut` file next to the video.

## Keyboard shortcuts

| Key | Action |
|---|---|
| Space | Play / pause |
| ← → / ↑ ↓ | Previous / next word / clip (⇧ extends the selection) |
| Delete | Cut / restore the selection |
| Enter | Split the clip (inside a subtitle: split at the caret) |
| ⇧ Enter / ⇧ ⌫ | Send the rest to the next clip / join to the previous clip |
| ⌘ E / ⌘ ⇧ E | Merge with next / previous clip |
| C · double-click the timeline | Cut at the playhead (even inside a word) |
| Q / W | Cut from clip start to playhead / from playhead to clip end |
| I → O → X | Mark in, mark out, cut the marked range |
| T | Add a subtitle on a silence |
| J / L (⇧ ×4) · , / . | Seek 0.5 s (2 s) · step one frame |
| ⌥ A S D F (⇧ for 0.25 s) | Nudge the start / end of the selected word by 0.05 s |
| F2 · double-click | Edit a word |
| ⌘ Z / ⌘ ⇧ Z | Undo / redo |
| ⌘ F | Find & replace |
| ? | Show all shortcuts |

## Troubleshooting

- **No window appears** — open the app again, or refresh the Chrome window (⌘R).
- **Preview stutters over cuts** — a light preview copy is built in the background after opening; it switches automatically when ready.
- **Transcription is slow** — use *Fast* (turbo). *Accurate* (large-v3) takes about as long as the video.
- **Logs** — `~/Library/Logs/LazyCut/`

## Update / uninstall

- **Update**: unzip the new version and run its `install.command` again (your projects are kept).
- **Uninstall**: right-click `uninstall.command` → Open. It moves the app and its caches to the Trash; your videos and `.lazycut` projects are never touched.

## For developers

```bash
/usr/bin/python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt
./run_dev.command                      # run from source
.venv/bin/python -m unittest tests.test_server
```

Python 3.9 + a vanilla-JS front end (no build step). Speech recognition: [mlx-whisper](https://github.com/ml-explore/mlx-examples); media: ffmpeg via imageio-ffmpeg.
