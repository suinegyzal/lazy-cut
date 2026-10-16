"""Background job manager.

Heavy jobs (transcribe / export / proxy) run one at a time, FIFO, on a single
worker thread (8 GB RAM budget). Light jobs (prep) each get their own thread.

A job function receives the Job and returns a JSON-able result. It reports
progress with ``job.update(...)`` and should poll ``job.cancel`` (a
threading.Event) or call ``job.check_cancel()``.

Exception → state mapping:
  any class named "Canceled"/"Cancelled" (ours or lazycut.ffmpeg.Canceled),
  or any exception after cancel was requested           → "canceled"
  JobError                                              → "error", message as-is (Korean)
  lazycut.ffmpeg.FFmpegError (matched by class name)    → "영상 처리 중 문제가 생겼어요: ..."
  other                                                 → friendly Korean message + traceback in the log
"""
from __future__ import annotations

import errno
import logging
import queue
import threading
import time
import uuid

log = logging.getLogger("lazycut.jobs")

QUEUED, RUNNING, DONE, ERROR, CANCELED = "queued", "running", "done", "error", "canceled"
FINAL_STATES = (DONE, ERROR, CANCELED)


class Canceled(Exception):
    """Raised inside a job function when the user canceled the job."""


class JobError(Exception):
    """An error whose message is already a user-facing (Korean) sentence."""


def is_canceled_exc(exc: BaseException) -> bool:
    return any(c.__name__ in ("Canceled", "Cancelled") for c in type(exc).__mro__)


def _short(text: str, limit: int = 300) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def user_message(exc: BaseException) -> str:
    """Korean, user-facing description of an exception raised by a job."""
    if isinstance(exc, JobError):
        return str(exc)
    names = {c.__name__ for c in type(exc).__mro__}
    if "FFmpegError" in names:
        detail = str(exc).strip()
        if not detail:
            tail = getattr(exc, "stderr_tail", "") or ""
            lines = [ln for ln in str(tail).splitlines() if ln.strip()]
            detail = lines[-1] if lines else ""
        return "영상 처리 중 문제가 생겼어요: " + _short(detail or "알 수 없는 오류")
    if isinstance(exc, MemoryError):
        return "메모리가 부족해요. 다른 앱을 닫고 다시 해 주세요."
    if isinstance(exc, FileExistsError):
        return "같은 이름의 파일이 이미 있어요."
    if isinstance(exc, FileNotFoundError):
        return "파일을 찾을 수 없어요: %s" % (exc.filename or _short(str(exc)))
    if isinstance(exc, PermissionError):
        return "파일에 접근할 권한이 없어요: %s" % (exc.filename or _short(str(exc)))
    if isinstance(exc, OSError) and exc.errno == errno.ENOSPC:
        return "저장 공간이 부족해요. 디스크 공간을 확보하고 다시 해 주세요."
    return "작업 중 문제가 생겼어요: " + _short(str(exc) or type(exc).__name__)


class Job:
    def __init__(self, kind: str, project_id: str | None = None):
        self.id = "j_" + uuid.uuid4().hex[:12]
        self.kind = kind
        self.project_id = project_id
        self.state = QUEUED
        self.progress = 0.0
        self.stage = ""
        self.message = ""
        self.result = None
        self.error = None  # type: str | None
        self.cancel = threading.Event()
        self.created = time.time()
        self.started = None  # type: float | None
        self.finished_at = None  # type: float | None
        self.heavy = False
        self._lock = threading.Lock()
        self._done = threading.Event()

    @property
    def finished(self) -> bool:
        return self.state in FINAL_STATES

    def update(self, progress=None, stage=None, message=None) -> None:
        with self._lock:
            if progress is not None:
                try:
                    p = float(progress)
                except (TypeError, ValueError):
                    p = None
                if p is not None and p == p:  # skip NaN
                    self.progress = min(1.0, max(0.0, p))
            if stage is not None:
                self.stage = str(stage)
            if message is not None:
                self.message = str(message)

    def check_cancel(self) -> None:
        if self.cancel.is_set():
            raise Canceled()

    def _finish(self, state: str, result=None, error: str | None = None) -> None:
        with self._lock:
            self._finish_locked(state, result, error)
        self._done.set()

    def _finish_locked(self, state: str, result=None, error: str | None = None) -> None:
        self.state = state
        self.finished_at = time.time()
        if state == DONE:
            self.result = result
            self.progress = 1.0
            self.stage = "done"
        elif state == CANCELED:
            self.stage = "canceled"
            self.message = "취소했어요."
        else:
            self.stage = "error"
            self.error = error

    def to_dict(self) -> dict:
        with self._lock:
            return {
                "id": self.id,
                "kind": self.kind,
                "projectId": self.project_id,
                "state": self.state,
                "progress": round(self.progress, 4),
                "stage": self.stage,
                "message": self.message,
                "result": self.result,
                "error": self.error,
                "created": self.created,
                "started": self.started,
                "finished": self.finished_at,
            }


class JobManager:
    def __init__(self, keep_finished: int = 100):
        self._jobs = {}  # type: dict[str, Job]
        self._lock = threading.Lock()
        self._heavy_q = queue.Queue()  # type: queue.Queue
        self._heavy_thread = None  # type: threading.Thread | None
        self._keep = keep_finished
        self._closed = False

    # -- public API ----------------------------------------------------------------
    def submit(self, kind: str, fn, *, heavy: bool, project_id: str | None = None) -> Job:
        job = Job(kind, project_id)
        job.heavy = bool(heavy)
        with self._lock:
            if self._closed:
                raise JobError("앱을 종료하는 중이에요.")
            self._jobs[job.id] = job
            self._prune_locked()
            if heavy:
                if self._heavy_thread is None or not self._heavy_thread.is_alive():
                    self._heavy_thread = threading.Thread(
                        target=self._heavy_loop, name="lazycut-heavy", daemon=True)
                    self._heavy_thread.start()
                self._heavy_q.put((job, fn))
                if self._heavy_q.qsize() > 1 or self._busy_heavy():
                    job.update(message="앞의 작업이 끝나길 기다리고 있어요.")
        if not heavy:
            threading.Thread(target=self._run, args=(job, fn),
                             name="lazycut-job-" + kind, daemon=True).start()
        log.info("job %s submitted (%s, heavy=%s, project=%s)", job.id, kind, heavy, project_id)
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def cancel(self, job_id: str) -> bool:
        """Request cancellation. Queued jobs are canceled immediately."""
        job = self.get(job_id)
        if job is None or job.finished:
            return False
        job.cancel.set()
        with job._lock:  # atomic vs. _run() picking the job up
            if job.state == QUEUED:
                job._finish_locked(CANCELED)
        if job.finished:
            job._done.set()
        log.info("job %s cancel requested", job_id)
        return True

    def active(self) -> list:
        with self._lock:
            jobs = list(self._jobs.values())
        return [j for j in jobs if not j.finished]

    def find(self, kind: str | None = None, project_id: str | None = None,
             active_only: bool = True) -> list:
        with self._lock:
            jobs = list(self._jobs.values())
        out = []
        for j in jobs:
            if kind is not None and j.kind != kind:
                continue
            if project_id is not None and j.project_id != project_id:
                continue
            if active_only and j.finished:
                continue
            out.append(j)
        return out

    def wait(self, job_id: str, timeout: float | None = None) -> Job | None:
        """Block until the job finishes (or timeout). Returns the job (check .finished)."""
        job = self.get(job_id)
        if job is not None:
            job._done.wait(timeout)
        return job

    def shutdown(self, timeout: float = 5.0) -> None:
        """Cancel everything and wait briefly for running jobs to stop."""
        with self._lock:
            self._closed = True
            jobs = list(self._jobs.values())
        for j in jobs:
            if not j.finished:
                self.cancel(j.id)
        deadline = time.time() + timeout
        for j in jobs:
            left = deadline - time.time()
            if left <= 0:
                break
            j._done.wait(left)
        self._heavy_q.put(None)

    # -- internals -----------------------------------------------------------------
    def _busy_heavy(self) -> bool:
        return any(j.heavy and j.state == RUNNING for j in self._jobs.values())

    def _prune_locked(self) -> None:
        done = [j for j in self._jobs.values() if j.finished]
        if len(done) <= self._keep:
            return
        done.sort(key=lambda j: j.finished_at or j.created)
        for j in done[: len(done) - self._keep]:
            self._jobs.pop(j.id, None)

    def _heavy_loop(self) -> None:
        while True:
            item = self._heavy_q.get()
            if item is None:
                return
            job, fn = item
            if job.finished:  # canceled while queued
                continue
            self._run(job, fn)

    def _run(self, job: Job, fn) -> None:
        with job._lock:
            if job.state != QUEUED:
                return
            job.state = RUNNING
            job.started = time.time()
            if job.message == "앞의 작업이 끝나길 기다리고 있어요.":
                job.message = ""
        try:
            if job.cancel.is_set():
                raise Canceled()
            result = fn(job)
        except BaseException as exc:  # noqa: BLE001 — a job must never kill its thread silently
            if is_canceled_exc(exc) or job.cancel.is_set():
                log.info("job %s (%s) canceled", job.id, job.kind)
                job._finish(CANCELED)
            else:
                if isinstance(exc, JobError):  # expected, already explained to the user
                    log.warning("job %s (%s) failed: %s", job.id, job.kind, exc)
                else:
                    log.exception("job %s (%s) failed", job.id, job.kind)
                job._finish(ERROR, error=user_message(exc))
            if isinstance(exc, (KeyboardInterrupt, SystemExit)):
                raise
            return
        job._finish(DONE, result=result)
        log.info("job %s (%s) done in %.1fs", job.id, job.kind, time.time() - (job.started or job.created))
