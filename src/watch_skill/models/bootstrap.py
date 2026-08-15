"""Explicit, opt-in download of one local vision model.

Nothing here runs during installation, import, an ordinary watch, or the test
suite. It is a command an operator types on purpose, because it fetches
several hundred megabytes and the alternative — a library that quietly
downloads a model the first time you look at a frame — is not something anyone
can run offline with confidence.

The preflight refuses rather than fills the disk. A half-downloaded model on a
machine with no space left is worse than no model: the download fails
somewhere in the middle, the cache is left inconsistent, and the operator now
has two problems.
"""
from __future__ import annotations

import ctypes
import json
import platform
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from watch_skill.errors import WatchSkillError

MODEL_ID = "HuggingFaceTB/SmolVLM2-500M-Video-Instruct"
MODEL_REVISION = "main"
"""Pinned at bootstrap time and recorded in the receipt: `main` is what we
ask for, and the resolved commit sha is what we write down. A model result
that cannot name the exact weights it came from is not reproducible."""

MODEL_LICENSE = "Apache-2.0"
MODEL_SOURCE = f"https://huggingface.co/{MODEL_ID}"

# Only what inference needs. Mirroring the whole repository would pull
# duplicate weight formats, ONNX exports and demo assets nobody loads.
REQUIRED_PATTERNS = [
    "*.json", "*.txt", "*.model",
    "model.safetensors", "*.safetensors.index.json",
]

MIN_FREE_DISK_BYTES = 8 * 1024**3
MAX_DOWNLOAD_BYTES = 4 * 1024**3
MIN_AVAILABLE_RAM_BYTES = 3 * 1024**3
"""A 500M model in float32 is ~2 GiB resident before the runtime's own
overhead. Below this the process gets killed by the allocator partway through
loading, which reads as a mysterious crash rather than a resource problem."""


class BootstrapRefused(WatchSkillError):
    """The preflight said no. Not an error in the model — a fact about here."""

    default_code = "models.bootstrap_refused"


def available_ram_bytes() -> int:
    """Available (not total) memory. Total is irrelevant to whether a load
    will survive the next five minutes on this machine."""
    if platform.system() == "Windows":
        class _Status(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        status = _Status()
        status.dwLength = ctypes.sizeof(_Status)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status))
        return int(status.ullAvailPhys)
    try:
        import psutil  # noqa: PLC0415

        return int(psutil.virtual_memory().available)
    except ImportError:
        pass
    try:  # Linux
        for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) * 1024
    except OSError:
        pass
    return -1  # unknown; the preflight reports that rather than guessing


def model_cache_dir() -> Path:
    """The project's own cache, not the user's global Hugging Face one.

    Keeping it here means `watch-skill clean` can reclaim the space and an
    operator can see exactly what we put on their disk.
    """
    from watch_skill.config import get_settings  # noqa: PLC0415

    return get_settings().data_dir / "models" / "vlm"


@dataclass
class Preflight:
    """What this machine can and cannot do, before anything is downloaded."""

    free_disk_bytes: int
    available_ram_bytes: int
    transformers_installed: bool
    torch_installed: bool
    already_present: bool
    blockers: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.blockers

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "blockers": self.blockers,
            "free_disk_gib": round(self.free_disk_bytes / 1024**3, 2),
            "available_ram_gib": (
                round(self.available_ram_bytes / 1024**3, 2)
                if self.available_ram_bytes >= 0 else None
            ),
            "transformers_installed": self.transformers_installed,
            "torch_installed": self.torch_installed,
            "already_present": self.already_present,
            "model": MODEL_ID,
            "revision": MODEL_REVISION,
            "license": MODEL_LICENSE,
            "source": MODEL_SOURCE,
            "cache_dir": str(model_cache_dir()),
            "requirements": {
                "min_free_disk_gib": MIN_FREE_DISK_BYTES / 1024**3,
                "max_download_gib": MAX_DOWNLOAD_BYTES / 1024**3,
                "min_available_ram_gib": MIN_AVAILABLE_RAM_BYTES / 1024**3,
            },
        }


def _installed(module: str) -> bool:
    import importlib.util  # noqa: PLC0415

    return importlib.util.find_spec(module) is not None


def preflight() -> Preflight:
    """Check the machine. Never downloads, never imports the heavy packages."""
    cache = model_cache_dir()
    free = shutil.disk_usage(cache.parent if cache.parent.exists() else Path.cwd()).free
    ram = available_ram_bytes()
    report = Preflight(
        free_disk_bytes=free,
        available_ram_bytes=ram,
        transformers_installed=_installed("transformers"),
        torch_installed=_installed("torch"),
        already_present=(cache / "config.json").is_file(),
    )
    if free < MIN_FREE_DISK_BYTES:
        report.blockers.append(
            f"free disk {free / 1024**3:.1f} GiB is below the required "
            f"{MIN_FREE_DISK_BYTES / 1024**3:.0f} GiB"
        )
    if 0 <= ram < MIN_AVAILABLE_RAM_BYTES:
        report.blockers.append(
            f"available RAM {ram / 1024**3:.1f} GiB is below the required "
            f"{MIN_AVAILABLE_RAM_BYTES / 1024**3:.0f} GiB; the load would be "
            "killed partway through"
        )
    if not report.torch_installed:
        report.blockers.append(
            "torch is not installed (`uv sync --extra vlm`); it is ~2.5 GiB "
            "and deliberately not a base dependency"
        )
    if not report.transformers_installed:
        report.blockers.append(
            "transformers is not installed (`uv sync --extra vlm`)"
        )
    return report


def estimate_download_bytes() -> int | None:
    """Ask the hub how large the required files are, without fetching them."""
    try:
        from huggingface_hub import HfApi  # noqa: PLC0415
    except ImportError:
        return None
    try:
        info = HfApi().model_info(MODEL_ID, revision=MODEL_REVISION, files_metadata=True)
    except Exception:  # noqa: BLE001 - offline or rate-limited is not a crash
        return None
    total = 0
    for sibling in info.siblings or []:
        name = sibling.rfilename
        if name.endswith((".safetensors", ".json", ".txt", ".model")):
            total += int(getattr(sibling, "size", 0) or 0)
    return total or None


def bootstrap(force: bool = False, dry_run: bool = False) -> dict[str, Any]:
    """Download the model, or explain precisely why not.

    Returns a receipt: what was fetched, from which revision, under which
    licence, and how long it took. A model result that cannot name the exact
    weights behind it is not reproducible.
    """
    report = preflight()
    if report.already_present and not force:
        return {"status": "already_present", **report.to_dict()}
    if not report.ok:
        raise BootstrapRefused(
            "cannot download the local vision model on this machine: "
            + "; ".join(report.blockers),
            code="models.bootstrap_refused",
            fix="free disk space, close memory-hungry processes, or install "
            "the vlm extra — nothing is downloaded until every check passes",
            details=report.to_dict(),
        )

    size = estimate_download_bytes()
    if size is not None and size > MAX_DOWNLOAD_BYTES:
        raise BootstrapRefused(
            f"the download would be {size / 1024**3:.1f} GiB, above the "
            f"{MAX_DOWNLOAD_BYTES / 1024**3:.0f} GiB ceiling",
            code="models.bootstrap_too_large",
            fix="this ceiling is deliberate; choose a smaller model",
            details={"estimated_bytes": size, **report.to_dict()},
        )
    if dry_run:
        return {"status": "dry_run", "estimated_bytes": size, **report.to_dict()}

    from huggingface_hub import snapshot_download  # noqa: PLC0415

    cache = model_cache_dir()
    cache.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    path = snapshot_download(
        MODEL_ID, revision=MODEL_REVISION, local_dir=str(cache),
        allow_patterns=REQUIRED_PATTERNS,
    )
    elapsed = time.monotonic() - started

    resolved = MODEL_REVISION
    try:
        from huggingface_hub import HfApi  # noqa: PLC0415

        resolved = HfApi().model_info(MODEL_ID, revision=MODEL_REVISION).sha or resolved
    except Exception:  # noqa: BLE001
        pass

    on_disk = sum(f.stat().st_size for f in Path(path).rglob("*") if f.is_file())
    receipt = {
        "status": "downloaded",
        "model": MODEL_ID,
        "revision_requested": MODEL_REVISION,
        "revision_resolved": resolved,
        "license": MODEL_LICENSE,
        "source": MODEL_SOURCE,
        "path": str(path),
        "bytes_on_disk": on_disk,
        "seconds": round(elapsed, 1),
        "fetched_at": time.time(),
        "patterns": REQUIRED_PATTERNS,
    }
    (cache / "watch-skill-receipt.json").write_text(
        json.dumps(receipt, indent=2), encoding="utf-8"
    )
    return receipt


def receipt() -> dict[str, Any] | None:
    """What was downloaded, if anything. Read by the report, not by runtime."""
    path = model_cache_dir() / "watch-skill-receipt.json"
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def is_available() -> bool:
    """Whether the local VLM can actually be used right now."""
    return (
        (model_cache_dir() / "config.json").is_file()
        and _installed("transformers")
        and _installed("torch")
    )
