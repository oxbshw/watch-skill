"""Local transcription via faster-whisper (CTranslate2) — the default fallback.

Fully offline: keyless users still get transcripts (the reference's biggest
functional gap). Model size auto-selects from available RAM/VRAM.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

from watch_skill.errors import TranscriptionError
from watch_skill.transcribe.types import Segment, Transcript

# (min free RAM GiB, model). Whisper CT2 int8 sizes are roughly: tiny 0.1 GB,
# base 0.15 GB, small 0.5 GB, medium 1.5 GB, large-v3 3 GB — headroom included.
_RAM_LADDER = [(24.0, "medium"), (12.0, "small"), (6.0, "base"), (0.0, "tiny")]
_GPU_MODEL = "large-v3"


def _available_ram_gib() -> float:
    """Best-effort free-RAM probe without extra dependencies."""
    try:
        import psutil  # noqa: PLC0415

        return psutil.virtual_memory().available / 1024**3
    except ImportError:
        pass
    if sys.platform == "win32":
        import ctypes

        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        stat = MEMORYSTATUSEX()
        stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
            return stat.ullAvailPhys / 1024**3
    return 8.0  # conservative default


def has_cuda_gpu() -> bool:
    """True when an NVIDIA GPU with ≥6 GiB VRAM is visible."""
    if shutil.which("nvidia-smi") is None:
        return False
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=15.0,
        )
        if result.returncode != 0:
            return False
        return any(int(line.strip()) >= 6144 for line in result.stdout.splitlines() if line.strip())
    except (subprocess.TimeoutExpired, OSError, ValueError):
        return False


def pick_model_size() -> str:
    """Auto-select a faster-whisper model for this machine."""
    if has_cuda_gpu():
        return _GPU_MODEL
    ram = _available_ram_gib()
    for threshold, model in _RAM_LADDER:
        if ram >= threshold:
            return model
    return "tiny"


def transcribe_local(
    audio_path: Path, model_size: str = "auto", language: str | None = None
) -> Transcript:
    """Transcribe an audio file fully offline with faster-whisper."""
    try:
        from faster_whisper import WhisperModel  # noqa: PLC0415
    except ImportError as exc:
        raise TranscriptionError(
            "faster-whisper is not installed",
            code="transcribe.missing_dependency",
            fix='install the whisper extra: `uv sync --extra whisper` or `pip install "watch-skill[whisper]"`',
        ) from exc

    size = pick_model_size() if model_size == "auto" else model_size
    device = "cuda" if has_cuda_gpu() else "cpu"
    compute = "float16" if device == "cuda" else "int8"
    print(
        f"[watch-skill] local whisper: model={size} device={device} ({compute})…",
        file=sys.stderr,
    )
    try:
        model = WhisperModel(size, device=device, compute_type=compute)
        raw_segments, _info = model.transcribe(
            str(audio_path), language=language, vad_filter=True
        )
        segments = [
            Segment(start=round(s.start, 2), end=round(s.end, 2), text=s.text.strip())
            for s in raw_segments
            if s.text.strip()
        ]
    except Exception as exc:
        raise TranscriptionError(
            f"local whisper failed: {exc}",
            code="transcribe.local_failed",
            fix="try a smaller model (WATCHSKILL_WHISPER_MODEL=tiny) or enable cloud STT",
            details={"model": size, "device": device},
        ) from exc
    return Transcript(segments=segments, source=f"whisper-local ({size})")
