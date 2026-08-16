"""Driving a real vision model that lives in someone else's interpreter.

Torch is over half a gigabyte and platform-specific. Making it a dependency of
Watch Skill would tax every install for a feature most sessions never use, and
would put a library famous for its memory appetite inside the process that is
supposed to be watching something in real time. So the model runs in an
interpreter the operator nominates through ``WATCHSKILL_VLM_PYTHON``, and this
module talks to it over a bounded line protocol.

What that buys, beyond disk: a model that wedges, leaks, or segfaults takes
down a subprocess rather than the session recording the evidence.

Everything here is defensive about the far side. It is a separate program the
operator configured, its output is model-generated text, and neither is
trusted: the path is validated before use, the protocol is version-checked,
every message is size-bounded, every call has a deadline, and the process tree
is killed rather than asked politely when a deadline passes.
"""
from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

from watch_skill.errors import WatchSkillError

PROTOCOL_VERSION = 1

LOAD_TIMEOUT_S = 300.0
"""Loading is slow on a CPU — a minute is normal on older hardware — but not
unbounded. A load that has not finished in five minutes is wedged."""

INFERENCE_TIMEOUT_S = 180.0
PING_TIMEOUT_S = 60.0
FAILURE_COOLDOWN_S = 120.0
"""After a failure, stop trying for a while. A model that failed once on this
machine will usually fail again immediately, and retrying at the frame rate
turns one problem into a stall."""

IDLE_RELEASE_S = 600.0
MAX_RESPONSE_BYTES = 4 * 1024 * 1024


class VlmWorkerError(WatchSkillError):
    """The external vision worker could not be started or driven."""

    default_code = "vision.worker_failed"


def validate_interpreter(raw: str | None) -> Path:
    """Resolve and check the configured interpreter before executing it.

    This is a path Watch Skill is about to run as a subprocess, so it is
    checked rather than trusted: it must be set, exist, be a file, and look
    like a Python interpreter. A helpful error here is worth a great deal —
    the alternative is a WinError deep inside a capture thread.
    """
    if not raw or not str(raw).strip():
        raise VlmWorkerError(
            "no external VLM interpreter is configured",
            code="vision.worker_not_configured",
            fix="set WATCHSKILL_VLM_PYTHON to the python.exe of an "
                "environment that has torch and transformers installed",
        )
    path = Path(str(raw).strip()).expanduser()
    try:
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise VlmWorkerError(
            f"the configured VLM interpreter does not exist: {path.name}",
            code="vision.worker_interpreter_missing",
            fix="check WATCHSKILL_VLM_PYTHON points at an existing python "
                "executable",
            details={"error": str(exc)[:200]},
        ) from exc
    if not resolved.is_file():
        raise VlmWorkerError(
            f"the configured VLM interpreter is not a file: {resolved.name}",
            code="vision.worker_interpreter_invalid",
            fix="point WATCHSKILL_VLM_PYTHON at python.exe itself, not a "
                "directory",
        )
    if "python" not in resolved.name.lower():
        raise VlmWorkerError(
            f"{resolved.name} does not look like a python interpreter",
            code="vision.worker_interpreter_invalid",
            fix="WATCHSKILL_VLM_PYTHON must name a python executable",
        )
    return resolved


class VlmWorker:
    """One external model process, and the rules for talking to it."""

    def __init__(self, interpreter: str | None = None, *,
                 model: str = "", revision: str = "",
                 max_edge: int = 512, max_new_tokens: int = 40,
                 threads: int = 2) -> None:
        self.interpreter = validate_interpreter(
            interpreter or os.environ.get("WATCHSKILL_VLM_PYTHON"))
        self.model = model or os.environ.get(
            "WATCHSKILL_VLM_MODEL", "HuggingFaceTB/SmolVLM2-256M-Video-Instruct")
        self.revision = revision or os.environ.get("WATCHSKILL_VLM_REVISION", "")
        self.max_edge = max_edge
        self.max_new_tokens = max_new_tokens
        self.threads = threads

        self._process: subprocess.Popen | None = None
        self._lock = threading.Lock()   # single-flight: one call at a time
        self._loaded = False
        self._failed_until = 0.0
        self._last_used = 0.0
        self.stats: dict[str, Any] = {
            "loads": 0, "calls": 0, "failures": 0,
            "load_seconds": 0.0, "last_inference_seconds": 0.0,
        }

    # --- process lifetime --------------------------------------------------

    def _spawn(self) -> subprocess.Popen:
        env = {k: v for k, v in os.environ.items()
               if not _is_provider_key(k)}
        # Offline by construction. A live session must never be the thing
        # that starts a half-gigabyte download.
        env["HF_HUB_OFFLINE"] = "1"
        env["TRANSFORMERS_OFFLINE"] = "1"
        env["PYTHONUNBUFFERED"] = "1"
        # Run the worker as a *file*, not as `-m watch_skill.vision.…`.
        # A module launch imports the parent package first, and
        # `watch_skill.vision.__init__` pulls in httpx — which the model
        # environment has no reason to carry. The worker's whole premise is
        # that it imports nothing from Watch Skill, and `-m` quietly broke
        # that by importing the package around it.
        worker = Path(__file__).resolve().parents[1] / "vision" / "worker_main.py"
        return subprocess.Popen(
            [str(self.interpreter), str(worker)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding="utf-8",
            errors="replace", env=env,
            cwd=str(worker.parent),
        )

    def _ensure_process(self) -> subprocess.Popen:
        if self._process is not None and self._process.poll() is None:
            return self._process
        self._process = self._spawn()
        self._loaded = False
        reply = self._call({"command": "ping"}, PING_TIMEOUT_S)
        if reply.get("protocol") != PROTOCOL_VERSION:
            self.stop()
            raise VlmWorkerError(
                f"the worker speaks protocol {reply.get('protocol')}, this "
                f"build speaks {PROTOCOL_VERSION}",
                code="vision.worker_protocol_mismatch",
                fix="the external environment has a different Watch Skill "
                    "version on its PYTHONPATH; align them",
            )
        return self._process

    def _call(self, request: dict[str, Any], timeout: float) -> dict[str, Any]:
        """One request, one response, with a deadline enforced by killing.

        A deadline that is only advisory is not a deadline. If the worker has
        not answered in time the process tree goes, because the alternative is
        a capture pipeline blocked forever on a model that is not coming back.
        """
        process = self._process
        if process is None or process.stdin is None or process.stdout is None:
            raise VlmWorkerError("the VLM worker is not running",
                                 code="vision.worker_not_running")

        payload = json.dumps(request) + "\n"
        result: dict[str, Any] = {}
        error: list[BaseException] = []

        def pump() -> None:
            try:
                process.stdin.write(payload)   # type: ignore[union-attr]
                process.stdin.flush()          # type: ignore[union-attr]
                line = process.stdout.readline()  # type: ignore[union-attr]
                if not line:
                    raise VlmWorkerError(
                        "the VLM worker closed its output",
                        code="vision.worker_died")
                if len(line) > MAX_RESPONSE_BYTES:
                    raise VlmWorkerError(
                        "the VLM worker sent an oversized response",
                        code="vision.worker_response_too_large")
                result.update(json.loads(line))
            except BaseException as exc:  # noqa: BLE001 - re-raised on the caller
                error.append(exc)

        thread = threading.Thread(target=pump, name="ws-vlm-call", daemon=True)
        thread.start()
        thread.join(timeout=timeout)
        if thread.is_alive():
            self._kill_tree()
            raise VlmWorkerError(
                f"the VLM worker exceeded its {timeout:.0f}s deadline",
                code="vision.worker_timeout",
                fix="lower max_new_tokens or max_edge, or use a smaller model",
            )
        if error:
            raise error[0] if isinstance(error[0], WatchSkillError) else \
                VlmWorkerError(f"VLM worker call failed: {error[0]}",
                               code="vision.worker_call_failed")
        return result

    def _kill_tree(self) -> None:
        """Kill the worker and anything it spawned. Never a polite request."""
        process = self._process
        self._process = None
        self._loaded = False
        if process is None or process.poll() is not None:
            return
        if sys.platform == "win32":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(process.pid)],
                           capture_output=True, timeout=30, check=False)
        else:  # pragma: no cover - POSIX path
            process.kill()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:  # pragma: no cover
            pass

    def stop(self) -> None:
        """Release the model and end the process. Safe to call twice."""
        with self._lock:
            process = self._process
            if process is not None and process.poll() is None:
                try:
                    self._call({"command": "shutdown"}, 15.0)
                    process.wait(timeout=15)
                except Exception:  # noqa: BLE001 - a stubborn worker is killed
                    pass
            self._kill_tree()

    def release_if_idle(self, now: float | None = None) -> bool:
        """Give the memory back when nobody has needed the model for a while."""
        now = now if now is not None else time.time()
        with self._lock:
            if not self._loaded or now - self._last_used < IDLE_RELEASE_S:
                return False
            try:
                self._call({"command": "release"}, 30.0)
                self._loaded = False
                return True
            except WatchSkillError:
                self._kill_tree()
                return True

    # --- the model ---------------------------------------------------------

    def ensure_loaded(self) -> dict[str, Any]:
        with self._lock:
            return self._ensure_loaded_locked()

    def _ensure_loaded_locked(self) -> dict[str, Any]:
        if time.time() < self._failed_until:
            raise VlmWorkerError(
                "the VLM worker is in a failure cooldown",
                code="vision.worker_cooldown",
                fix="the previous attempt failed; it will be retried after "
                    "the cooldown rather than at the frame rate",
                details={"retry_in_seconds": round(self._failed_until - time.time(), 1)},
            )
        self._ensure_process()
        if self._loaded:
            return {"already_loaded": True}
        try:
            reply = self._call({
                "command": "load", "model": self.model,
                "revision": self.revision, "threads": self.threads,
            }, LOAD_TIMEOUT_S)
        except WatchSkillError:
            self._failed_until = time.time() + FAILURE_COOLDOWN_S
            self.stats["failures"] += 1
            raise
        if not reply.get("ok"):
            self._failed_until = time.time() + FAILURE_COOLDOWN_S
            self.stats["failures"] += 1
            raise VlmWorkerError(
                f"the VLM worker could not load the model: {reply.get('message')}",
                code="vision.worker_load_failed",
                fix="check the model is present in the worker's cache; "
                    "runtime download is disabled on purpose",
                details={"model": self.model, "revision": self.revision},
            )
        self._loaded = True
        self.stats["loads"] += 1
        self.stats["load_seconds"] = reply.get("load_seconds", 0.0)
        self.stats["dtype"] = reply.get("dtype", "")
        self.stats["torch"] = reply.get("torch", "")
        return reply

    def interpret(self, frame: Path, question: str = "") -> dict[str, Any]:
        """Interpret one frame. Serialized — one inference at a time.

        The lock is the backpressure. On a CPU this takes tens of seconds, and
        letting two calls overlap would double the memory for a result that
        describes a screen which has already moved on.
        """
        with self._lock:
            self._ensure_loaded_locked()
            data = base64.b64encode(Path(frame).read_bytes()).decode("ascii")
            try:
                reply = self._call({
                    "command": "interpret", "frames": [data],
                    "question": question, "max_edge": self.max_edge,
                    "max_new_tokens": self.max_new_tokens,
                }, INFERENCE_TIMEOUT_S)
            except WatchSkillError:
                self.stats["failures"] += 1
                self._failed_until = time.time() + FAILURE_COOLDOWN_S
                raise
            self._last_used = time.time()
            self.stats["calls"] += 1
            self.stats["last_inference_seconds"] = reply.get(
                "inference_seconds", 0.0)
            return reply

    def diagnostics(self) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "configured": True,
            "model": self.model,
            "revision": self.revision,
            "loaded": self._loaded,
            "running": self._process is not None and self._process.poll() is None,
            "cooldown_until": self._failed_until or None,
            "stats": dict(self.stats),
            "limits": {
                "max_edge": self.max_edge,
                "max_new_tokens": self.max_new_tokens,
                "threads": self.threads,
                "load_timeout_s": LOAD_TIMEOUT_S,
                "inference_timeout_s": INFERENCE_TIMEOUT_S,
            },
        }


def _is_provider_key(name: str) -> bool:
    """Whether an environment variable looks like a provider credential.

    The worker needs no API key — it runs a local model — so it is given none.
    A subprocess that cannot see a key cannot leak one, whatever it loads.
    """
    upper = name.upper()
    return any(token in upper for token in
               ("API_KEY", "APIKEY", "_TOKEN", "SECRET", "PASSWORD",
                "ANTHROPIC", "OPENAI", "GEMINI", "GROQ", "HF_TOKEN"))


__all__ = [
    "FAILURE_COOLDOWN_S",
    "IDLE_RELEASE_S",
    "INFERENCE_TIMEOUT_S",
    "LOAD_TIMEOUT_S",
    "PROTOCOL_VERSION",
    "VlmWorker",
    "VlmWorkerError",
    "validate_interpreter",
]
