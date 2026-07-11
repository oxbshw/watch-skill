"""Keep the local vision server alive — or fail loudly, never emptily.

The Ollama server on a tight-RAM Windows box has died mid-pipeline twice
in this project's history (log-rotation race, OOM pressure). The rules
learned from that, encoded here:

- health-check is a GET to /api/version with a short timeout, cached for
  a minute so batches don't pay it per frame;
- a dead server gets ONE detached restart attempt (`ollama serve`,
  no console window, survives our process) and a bounded wait;
- still dead → a structured ``vision.server_down`` error whose fix is a
  command, not a shrug. Nothing in this module ever returns an empty
  string as a failure signal.
- NEVER `ollama stop` — that is what killed it once.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import time
from pathlib import Path

import httpx

from watch_skill.errors import VisionError

_alive_until: dict[str, float] = {}
_ALIVE_TTL_SECONDS = 60.0
_RESTART_WAIT_SECONDS = 25.0


def ollama_alive(base_url: str, timeout: float = 3.0) -> bool:
    """One cheap liveness probe, positive results cached briefly."""
    now = time.monotonic()
    if _alive_until.get(base_url, 0.0) > now:
        return True
    try:
        response = httpx.get(f"{base_url.rstrip('/')}/api/version", timeout=timeout)
        response.raise_for_status()
    except httpx.HTTPError:
        return False
    _alive_until[base_url] = now + _ALIVE_TTL_SECONDS
    return True


def _ollama_binary() -> str | None:
    path = shutil.which("ollama")
    if path:
        return path
    for candidate in (
        Path.home() / "AppData/Local/Programs/Ollama/ollama.exe",
        Path("C:/Program Files/Ollama/ollama.exe"),
    ):
        if candidate.is_file():
            return str(candidate)
    return None


def restart_ollama_detached() -> bool:
    """Start `ollama serve` detached from this process. True = launched."""
    binary = _ollama_binary()
    if binary is None:
        return False
    kwargs: dict = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL,
                    "stdin": subprocess.DEVNULL}
    if sys.platform == "win32":
        kwargs["creationflags"] = (
            subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
        )
    else:
        kwargs["start_new_session"] = True
    try:
        subprocess.Popen([binary, "serve"], **kwargs)
        return True
    except OSError:
        return False


def ensure_ollama(base_url: str) -> None:
    """Alive, or restarted-and-alive, or a structured error. Never silent."""
    if ollama_alive(base_url):
        return
    print("[watch-skill] ollama is down — restarting it detached", file=sys.stderr)
    launched = restart_ollama_detached()
    if launched:
        deadline = time.monotonic() + _RESTART_WAIT_SECONDS
        while time.monotonic() < deadline:
            if ollama_alive(base_url):
                print("[watch-skill] ollama is back", file=sys.stderr)
                return
            time.sleep(1.0)
    raise VisionError(
        f"the local vision server at {base_url} is not responding"
        + ("" if launched else " and the ollama binary was not found"),
        code="vision.server_down",
        fix="start it yourself: `ollama serve` (or `ollama app.exe` on Windows); "
        "check RAM headroom with `watch-skill doctor` — a loaded machine can "
        "kill the model load. Never use `ollama stop`.",
        details={"base_url": base_url, "restart_attempted": launched},
    )


def forget_liveness(base_url: str | None = None) -> None:
    """Drop the cached liveness (tests, and after a known kill)."""
    if base_url is None:
        _alive_until.clear()
    else:
        _alive_until.pop(base_url, None)
