"""Transcription subprocess: mlx-whisper + missed-speech recovery. Prints JSON progress lines (SPEC §3.9).

Usage: python -m lazycut.transcribe_worker --audio a16k.wav --model turbo --lang ko --out whisper.json [--recover 1]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

REPOS = {"turbo": "mlx-community/whisper-large-v3-turbo", "large-v3": "mlx-community/whisper-large-v3-mlx"}
# Never use hallucination_silence_threshold: it silently dropped real phrases in tests.
# condition_on_previous_text=True keeps repeated takes as text (better NG detection on 22화).
WHISPER_KW = dict(word_timestamps=True, verbose=False, condition_on_previous_text=True)


def emit(stage: str, progress=None, message: str = "") -> None:
    d = {"stage": stage, "message": message}
    if progress is not None:
        d["progress"] = round(float(progress), 4)
    sys.stdout.write(json.dumps(d, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def model_cached(repo: str) -> bool:
    root = os.path.join(os.path.expanduser(os.environ.get("HF_HOME", "~/.cache/huggingface")), "hub",
                        "models--" + repo.replace("/", "--"), "snapshots")
    if not os.path.isdir(root):
        return False
    for snap in os.listdir(root):
        files = os.listdir(os.path.join(root, snap))
        if any(f.endswith((".safetensors", ".npz")) for f in files):
            return True
    return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--model", default="turbo")
    ap.add_argument("--lang", default="ko")
    ap.add_argument("--out", required=True)
    ap.add_argument("--recover", default="1")
    a = ap.parse_args()
    repo = REPOS.get(a.model, a.model)
    try:
        import numpy as np
        import tqdm

        from . import vad as vadmod
        from . import _vadcore as core
        from . import _recover

        span = [0.03, 0.85]

        class Progress(tqdm.tqdm):
            def __init__(self, *args, **kw):
                kw["disable"] = False
                kw["file"] = open(os.devnull, "w")
                super().__init__(*args, **kw)
                self._last = 0.0

            def update(self, n=1):
                r = super().update(n)
                if self.total:
                    f = self.n / self.total
                    if f - self._last >= 0.01 or f >= 1.0:
                        self._last = f
                        emit("transcribe", span[0] + (span[1] - span[0]) * f, "받아쓰는 중이에요")
                return r

        tqdm.tqdm = Progress
        import mlx_whisper

        if not model_cached(repo):
            emit("model", 0.0, "음성인식 모델을 내려받는 중이에요 (처음 한 번, 약 1.5GB)")
        else:
            emit("model", 0.01, "음성인식 모델을 불러오는 중이에요")
        audio = vadmod.load_wav16k(a.audio)
        t0 = time.time()
        r = mlx_whisper.transcribe(audio, path_or_hf_repo=repo, language=a.lang, **WHISPER_KW)
        segs, words = [], []
        for i, s in enumerate(r.get("segments") or []):
            segs.append({k: s.get(k) for k in ("start", "end", "text", "avg_logprob", "no_speech_prob",
                                               "compression_ratio")})
            for w in s.get("words") or []:
                words.append({"text": w["word"].strip(), "start": float(w["start"]), "end": float(w["end"]),
                              "p": float(w.get("probability", 0.0)), "seg": i, "recovered": False})
        recovered = 0
        if a.recover == "1" and words:
            emit("recover", 0.86, "빠진 말소리를 다시 듣는 중이에요")
            vt = core.analyze(audio)
            refined = core.refine(words, vt)
            kw = dict(path_or_hf_repo=repo, language=a.lang, word_timestamps=True, verbose=False,
                      condition_on_previous_text=False)
            span[0], span[1] = 0.86, 0.86  # silence the tqdm bar for snippet passes
            new, _report = _recover.recover(audio, refined, vt, kw, core.uncovered_regions)
            for w in new:
                if w.get("type") == "sound":
                    words.append({"text": "", "start": w["start"], "end": w["end"], "p": 0.0, "seg": -1,
                                  "recovered": True, "type": "sound"})
                else:
                    words.append(w)
                    recovered += 1
            words.sort(key=lambda w: w["start"])
        out = {"model": repo, "lang": a.lang, "elapsed": round(time.time() - t0, 2), "segments": segs,
               "words": words, "recovered": recovered}
        tmp = a.out + ".part"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False)
        os.replace(tmp, a.out)
        emit("done", 1.0, "받아쓰기를 마쳤어요")
        return 0
    except Exception as e:  # noqa: BLE001
        emit("error", None, "%s: %s" % (type(e).__name__, e))
        return 1


if __name__ == "__main__":
    sys.exit(main())
