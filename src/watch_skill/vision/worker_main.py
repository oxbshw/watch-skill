"""The VLM worker: a separate interpreter that owns the model and nothing else.

Run as ``python -m watch_skill.vision.worker_main`` inside an environment that
has torch and transformers. That environment is deliberately **not** the one
Watch Skill runs in: torch is over half a gigabyte, needs a specific build per
platform, and would make every install pay for a feature most sessions never
use. Keeping it outside also means a model that wedges, leaks, or dies takes
nothing with it.

The protocol is newline-delimited JSON on stdin/stdout — one request, one
response, in order. No shared memory, no pickle, no import of Watch Skill.
This file must stay importable by an interpreter that has never heard of the
rest of the package, so it depends on nothing but the standard library until
a request actually asks it to load a model.
"""
from __future__ import annotations

import base64
import json
import sys
import time
from typing import Any

PROTOCOL_VERSION = 1

MAX_REQUEST_BYTES = 8 * 1024 * 1024
"""A request carries base64 frames. Eight megabytes is several large
screenshots and far below anything that would exhaust this process."""

MAX_RESPONSE_CHARS = 8000
"""Model output is untrusted text. A model that runs away producing tokens
must not be able to hand back something unbounded."""

DEFAULT_MAX_NEW_TOKENS = 40
DEFAULT_MAX_EDGE = 512


class _State:
    """Everything the worker holds between requests."""

    def __init__(self) -> None:
        self.model: Any = None
        self.processor: Any = None
        self.model_id: str = ""
        self.revision: str = ""
        self.dtype: str = ""
        self.loaded_at: float = 0.0
        self.load_seconds: float = 0.0


STATE = _State()


def _reply(payload: dict[str, Any]) -> None:
    payload["protocol_version"] = PROTOCOL_VERSION
    sys.stdout.write(json.dumps(payload, default=str) + "\n")
    sys.stdout.flush()


def _load(request: dict[str, Any]) -> dict[str, Any]:
    """Load the model. Single-flight by construction: one request at a time."""
    model_id = str(request["model"])
    revision = str(request.get("revision") or "")
    if STATE.model is not None and STATE.model_id == model_id \
            and STATE.revision == revision:
        return {"ok": True, "already_loaded": True,
                "load_seconds": STATE.load_seconds}

    import torch  # noqa: PLC0415
    from transformers import (  # noqa: PLC0415
        AutoModelForImageTextToText,
        AutoProcessor,
    )

    # Bounded threads. The default grabs every logical core, which on a
    # 4-thread laptop starves the capture pipeline this is supposed to be
    # observing — the model would be interpreting a session it had itself
    # made stutter.
    threads = max(1, int(request.get("threads", 2)))
    torch.set_num_threads(threads)

    # float32 only. bfloat16 on a CPU without AVX-512 falls back to a slow
    # emulated path or produces garbage depending on the build, and this
    # machine has no CUDA at all — so the safe dtype is the one that is
    # always correct rather than the one that is sometimes faster.
    dtype = torch.float32

    started = time.time()
    # local_files_only: a runtime that can reach the network is a runtime
    # that can download half a gigabyte during a live session. Bootstrap is
    # a separate, explicit step.
    processor = AutoProcessor.from_pretrained(
        model_id, revision=revision or None, local_files_only=True)
    model = AutoModelForImageTextToText.from_pretrained(
        model_id, revision=revision or None, dtype=dtype,
        low_cpu_mem_usage=True, local_files_only=True).eval()

    STATE.model, STATE.processor = model, processor
    STATE.model_id, STATE.revision = model_id, revision
    STATE.dtype = str(dtype).replace("torch.", "")
    STATE.load_seconds = time.time() - started
    STATE.loaded_at = time.time()
    return {"ok": True, "already_loaded": False,
            "load_seconds": round(STATE.load_seconds, 3),
            "dtype": STATE.dtype, "threads": threads,
            "torch": torch.__version__}


def _interpret(request: dict[str, Any]) -> dict[str, Any]:
    if STATE.model is None:
        return {"ok": False, "error": "not_loaded",
                "message": "load the model before interpreting"}

    import io  # noqa: PLC0415

    import torch  # noqa: PLC0415
    from PIL import Image  # noqa: PLC0415

    max_edge = int(request.get("max_edge", DEFAULT_MAX_EDGE))
    max_new = int(request.get("max_new_tokens", DEFAULT_MAX_NEW_TOKENS))
    frames_b64 = request.get("frames") or []
    if not frames_b64:
        return {"ok": False, "error": "no_frames"}

    images = []
    for encoded in frames_b64[:1]:  # one frame per call on this hardware
        raw = base64.b64decode(encoded)
        image = Image.open(io.BytesIO(raw)).convert("RGB")
        # Downscale before the model sees it. Full-resolution screenshots
        # multiply the vision tokens and the latency with them, for detail
        # a 256M model cannot use.
        image.thumbnail((max_edge, max_edge))
        images.append(image)

    question = str(request.get("question") or
                   "Describe what this screen shows in one short sentence.")
    messages = [{"role": "user", "content": [
        *[{"type": "image", "image": img} for img in images],
        {"type": "text", "text": question}]}]

    started = time.time()
    inputs = STATE.processor.apply_chat_template(
        messages, add_generation_prompt=True, tokenize=True,
        return_dict=True, return_tensors="pt")
    with torch.no_grad():
        output = STATE.model.generate(**inputs, max_new_tokens=max_new,
                                      do_sample=False)
    elapsed = time.time() - started

    decoded = STATE.processor.batch_decode(output, skip_special_tokens=True)[0]
    text = decoded.split("Assistant:")[-1].strip()[:MAX_RESPONSE_CHARS]
    return {
        "ok": True,
        "text": text,
        "inference_seconds": round(elapsed, 3),
        "model": STATE.model_id,
        "revision": STATE.revision,
        "dtype": STATE.dtype,
        "max_new_tokens": max_new,
        "max_edge": max_edge,
    }


def _env_audit() -> dict[str, Any]:
    """Report which credential-shaped variables this process can see.

    The parent strips provider keys before spawning. That claim is only worth
    something if it can be checked from *inside* the child, so this reports
    what actually arrived rather than what was intended.

    Names only, never values. A variable name is not a secret; its contents
    are, and this must never become a way to read one back out over the pipe.
    """
    import os  # noqa: PLC0415

    tokens = ("API_KEY", "APIKEY", "_TOKEN", "SECRET", "PASSWORD",
              "ANTHROPIC", "OPENAI", "GEMINI", "GROQ", "HF_TOKEN")
    seen = sorted(name for name in os.environ
                  if any(token in name.upper() for token in tokens))
    return {
        "ok": True,
        "credential_like_names": seen,
        "credential_like_count": len(seen),
        "hf_hub_offline": os.environ.get("HF_HUB_OFFLINE", ""),
        "transformers_offline": os.environ.get("TRANSFORMERS_OFFLINE", ""),
    }


def _release() -> dict[str, Any]:
    """Drop the model and give the memory back."""
    STATE.model = None
    STATE.processor = None
    STATE.model_id = STATE.revision = ""
    try:
        import gc  # noqa: PLC0415

        gc.collect()
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "released": True}


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        if len(line) > MAX_REQUEST_BYTES:
            _reply({"ok": False, "error": "request_too_large"})
            continue
        try:
            request = json.loads(line)
        except ValueError as exc:
            _reply({"ok": False, "error": "malformed_request",
                    "message": str(exc)[:200]})
            continue

        command = str(request.get("command", ""))
        try:
            if command == "ping":
                _reply({"ok": True, "protocol": PROTOCOL_VERSION,
                        "python": sys.version.split()[0],
                        "loaded": STATE.model is not None})
            elif command == "load":
                _reply(_load(request))
            elif command == "interpret":
                _reply(_interpret(request))
            elif command == "env_audit":
                _reply(_env_audit())
            elif command == "release":
                _reply(_release())
            elif command == "shutdown":
                _reply({"ok": True, "bye": True})
                return 0
            else:
                _reply({"ok": False, "error": "unknown_command",
                        "command": command})
        except Exception as exc:  # noqa: BLE001 - a failure is a reply, not a crash
            # The worker must survive a bad request. A crash here would take
            # the model with it and cost another 45 seconds to reload.
            _reply({"ok": False, "error": type(exc).__name__,
                    "message": str(exc)[:500]})
    return 0


if __name__ == "__main__":  # pragma: no cover - exercised as a subprocess
    raise SystemExit(main())
