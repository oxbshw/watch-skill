"""`watch-skill doctor` — preflight checks that fix what they can.

Design (inherited from the reference project's setup.py, then extended):
silent-on-success semantics for agents, structured results for machines,
and — unlike the reference, which only *prints* install commands on
Windows — an actual self-healing bootstrap: winget -> choco -> portable
binaries downloaded into a managed bin dir.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Literal

from watch_skill.config import get_settings
from watch_skill.errors import DependencyError
from watch_skill.health import binaries
from watch_skill.health.log import record_incident

Status = Literal["ok", "warn", "fail"]

YT_DLP_STALE_DAYS = 14
MIN_FREE_BYTES = 2 * 1024**3
_VERSION_DATE_RE = re.compile(r"(\d{4})\.(\d{2})\.(\d{2})")


@dataclass
class CheckResult:
    """Outcome of one doctor check."""

    name: str
    status: Status
    message: str
    fix_applied: str | None = None


@dataclass
class DoctorReport:
    """All check results plus an aggregate verdict."""

    checks: list[CheckResult] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return all(c.status != "fail" for c in self.checks)

    def to_dict(self) -> dict:
        return {
            "ok": self.ok,
            "checks": [
                {
                    "name": c.name,
                    "status": c.status,
                    "message": c.message,
                    "fix_applied": c.fix_applied,
                }
                for c in self.checks
            ],
        }


def _run(cmd: list[str], timeout: float = 120.0) -> subprocess.CompletedProcess[str]:
    """Run a command without a shell (space-safe paths), capturing text output."""
    return subprocess.run(
        cmd, capture_output=True, text=True, timeout=timeout, encoding="utf-8", errors="replace"
    )


def check_python() -> CheckResult:
    """Python 3.11+ is required."""
    version = sys.version_info
    label = f"{version.major}.{version.minor}.{version.micro}"
    if version >= (3, 11):
        return CheckResult("python", "ok", f"Python {label}")
    return CheckResult(
        "python", "fail", f"Python {label} < 3.11 — install a newer Python"
    )


def _try_winget_ffmpeg() -> bool:
    if shutil.which("winget") is None:
        return False
    result = _run(
        [
            "winget", "install", "--id", "Gyan.FFmpeg", "-e",
            "--accept-source-agreements", "--accept-package-agreements",
            "--disable-interactivity",
        ],
        timeout=600.0,
    )
    return result.returncode == 0 and shutil.which("ffmpeg") is not None


def _try_choco_ffmpeg() -> bool:
    if shutil.which("choco") is None:
        return False
    result = _run(["choco", "install", "ffmpeg", "-y"], timeout=600.0)
    return result.returncode == 0 and shutil.which("ffmpeg") is not None


def check_ffmpeg(fix: bool = True) -> CheckResult:
    """ffmpeg + ffprobe present; bootstrap via winget -> choco -> portable zip."""
    if binaries.find_binary("ffmpeg") and binaries.find_binary("ffprobe"):
        return CheckResult("ffmpeg", "ok", f"ffmpeg at {binaries.find_binary('ffmpeg')}")
    if not fix:
        return CheckResult(
            "ffmpeg", "fail", "ffmpeg/ffprobe not found (run doctor with fixes enabled)"
        )
    steps: list[tuple[str, Callable[[], bool]]] = [
        ("winget", _try_winget_ffmpeg),
        ("choco", _try_choco_ffmpeg),
    ]
    for label, attempt in steps:
        try:
            if attempt():
                record_incident("bootstrap", f"installed ffmpeg via {label}")
                return CheckResult("ffmpeg", "ok", f"installed via {label}", fix_applied=label)
        except (subprocess.TimeoutExpired, OSError):
            continue
    try:
        ffmpeg_path, _ = binaries.bootstrap_ffmpeg_portable()
        record_incident("bootstrap", "installed portable ffmpeg from gyan.dev")
        return CheckResult(
            "ffmpeg", "ok", f"portable ffmpeg at {ffmpeg_path}", fix_applied="portable-zip"
        )
    except DependencyError as exc:
        return CheckResult("ffmpeg", "fail", str(exc))


def _playwright_cache_root() -> Path:
    """Default/custom Playwright browser cache for the current platform."""
    configured = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    if configured and configured != "0":
        return Path(configured).expanduser()
    if configured == "0":
        import playwright

        return Path(playwright.__file__).parent / "driver" / "package" / ".local-browsers"
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local")) / "ms-playwright"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches" / "ms-playwright"
    return Path.home() / ".cache" / "ms-playwright"


def _playwright_ffmpeg_installed() -> bool:
    root = _playwright_cache_root()
    return any(
        path.is_file()
        for folder in root.glob("ffmpeg-*")
        for path in folder.rglob("ffmpeg*")
    )


def check_playwright_recording(fix: bool = True) -> CheckResult:
    """Playwright's own recording ffmpeg is required even with system ffmpeg."""
    try:
        import playwright  # noqa: F401, PLC0415
    except ImportError:
        return CheckResult(
            "playwright-recording", "ok", "Playwright not installed — browser capture is optional"
        )
    if _playwright_ffmpeg_installed():
        return CheckResult("playwright-recording", "ok", "Playwright recording ffmpeg installed")
    if not fix:
        return CheckResult(
            "playwright-recording",
            "warn",
            "Playwright recording ffmpeg missing — browser capture cannot record video",
        )
    try:
        result = _run([sys.executable, "-m", "playwright", "install", "ffmpeg"], timeout=600.0)
    except (subprocess.TimeoutExpired, OSError) as exc:
        return CheckResult("playwright-recording", "warn", f"install failed: {exc}")
    if result.returncode == 0 and _playwright_ffmpeg_installed():
        return CheckResult(
            "playwright-recording",
            "ok",
            "installed Playwright recording ffmpeg",
            fix_applied="playwright-install-ffmpeg",
        )
    detail = (result.stderr or result.stdout or "unknown error").strip()[-300:]
    return CheckResult(
        "playwright-recording",
        "warn",
        f"Playwright recording ffmpeg missing ({detail}); run `playwright install ffmpeg`",
    )

def check_yt_dlp(fix: bool = True) -> CheckResult:
    """yt-dlp present; bootstrap the standalone binary when missing."""
    found = binaries.find_binary("yt-dlp")
    if found:
        return CheckResult("yt-dlp", "ok", f"yt-dlp at {found}")
    if not fix:
        return CheckResult(
            "yt-dlp", "fail", "yt-dlp not found (run doctor with fixes enabled)"
        )
    try:
        dest = binaries.bootstrap_yt_dlp()
        record_incident("bootstrap", f"downloaded yt-dlp to {dest}")
        return CheckResult("yt-dlp", "ok", f"downloaded to {dest}", fix_applied="download")
    except DependencyError as exc:
        return CheckResult("yt-dlp", "fail", str(exc))


def yt_dlp_version_date(version_text: str) -> date | None:
    """Parse a yt-dlp version string (YYYY.MM.DD...) into its release date."""
    match = _VERSION_DATE_RE.search(version_text)
    if match is None:
        return None
    try:
        return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return None


def update_yt_dlp(yt_dlp: Path) -> bool:
    """Self-update yt-dlp: `-U` for standalone binaries, pip for pip installs."""
    if yt_dlp.suffix.lower() in (".exe", "") and "site-packages" not in str(yt_dlp).lower():
        result = _run([str(yt_dlp), "-U"], timeout=300.0)
        ok = result.returncode == 0
    else:
        result = _run(
            [sys.executable, "-m", "pip", "install", "--upgrade", "yt-dlp"], timeout=300.0
        )
        ok = result.returncode == 0
    record_incident(
        "yt_dlp_update", "self-update attempted", success=ok, binary=str(yt_dlp)
    )
    return ok


def check_yt_dlp_freshness(fix: bool = True) -> CheckResult:
    """Warn when yt-dlp is older than 14 days (extractor breakage risk)."""
    yt_dlp = binaries.find_binary("yt-dlp")
    if yt_dlp is None:
        return CheckResult("yt-dlp-freshness", "warn", "skipped: yt-dlp not installed")
    try:
        result = _run([str(yt_dlp), "--version"], timeout=60.0)
    except (subprocess.TimeoutExpired, OSError) as exc:
        return CheckResult("yt-dlp-freshness", "warn", f"version probe failed: {exc}")
    released = yt_dlp_version_date(result.stdout.strip())
    if released is None:
        return CheckResult(
            "yt-dlp-freshness", "warn", f"unparseable version: {result.stdout.strip()!r}"
        )
    age_days = (datetime.now().date() - released).days
    if age_days <= YT_DLP_STALE_DAYS:
        return CheckResult(
            "yt-dlp-freshness", "ok", f"version {result.stdout.strip()} ({age_days}d old)"
        )
    if fix and update_yt_dlp(yt_dlp):
        return CheckResult(
            "yt-dlp-freshness", "ok",
            f"was {age_days}d old — self-updated", fix_applied="self-update",
        )
    return CheckResult(
        "yt-dlp-freshness", "warn",
        f"version {result.stdout.strip()} is {age_days}d old — extractors may be broken; "
        "update with `yt-dlp -U`",
    )


def check_disk_space() -> CheckResult:
    """At least 2 GiB free where downloads and the index live."""
    data_dir = get_settings().data_dir
    probe = data_dir if data_dir.exists() else data_dir.parent
    try:
        usage = shutil.disk_usage(probe)
    except OSError as exc:
        return CheckResult("disk-space", "warn", f"could not probe {probe}: {exc}")
    free_gib = usage.free / 1024**3
    if usage.free >= MIN_FREE_BYTES:
        return CheckResult("disk-space", "ok", f"{free_gib:.1f} GiB free at {probe}")
    return CheckResult(
        "disk-space", "warn", f"only {free_gib:.1f} GiB free at {probe} — downloads may fail"
    )


def check_js_runtime(fix: bool = True) -> CheckResult:
    """A JS runtime (deno) for yt-dlp's YouTube n-sig decryption.

    Without one, YouTube throttles downloads to a crawl (observed live:
    a 100 MB video taking 30+ minutes). Warn-level, not fail — every other
    source works fine without it.
    """
    if binaries.find_binary("deno"):
        return CheckResult("js-runtime", "ok", f"deno at {binaries.find_binary('deno')}")
    if not fix:
        return CheckResult(
            "js-runtime", "warn",
            "no deno found — YouTube downloads will be heavily throttled "
            "(fix: winget install DenoLand.Deno)",
        )
    try:
        path = binaries.bootstrap_deno()
        record_incident("bootstrap", "installed deno for yt-dlp YouTube extraction")
        return CheckResult("js-runtime", "ok", f"deno at {path}", fix_applied="bootstrap")
    except DependencyError:
        return CheckResult(
            "js-runtime", "warn",
            "could not bootstrap deno — YouTube downloads will be throttled "
            "(fix: winget install DenoLand.Deno, or place deno in the managed bin dir)",
        )


def check_gpu() -> CheckResult:
    """Detect an NVIDIA GPU (informational; whisper picks CPU/GPU automatically)."""
    if shutil.which("nvidia-smi") is None:
        return CheckResult("gpu", "ok", "no NVIDIA GPU detected — whisper will use CPU")
    try:
        result = _run(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
            timeout=30.0,
        )
        if result.returncode == 0 and result.stdout.strip():
            return CheckResult("gpu", "ok", f"GPU: {result.stdout.strip().splitlines()[0]}")
    except (subprocess.TimeoutExpired, OSError):
        pass
    return CheckResult("gpu", "ok", "nvidia-smi present but unresponsive — assuming CPU")


def check_ocr_models() -> CheckResult:
    """Report which per-script OCR models are cached (informational).

    Script models (Arabic, Cyrillic, Devanagari, Korean, …) auto-download on
    first use into ``<data_dir>/models/ocr/``; this check tells the user what
    is already local — useful before going offline.
    """
    models_dir = get_settings().data_dir / "models" / "ocr"
    if not models_dir.is_dir():
        return CheckResult(
            "ocr-models", "ok",
            "no script models cached yet — they auto-download on first use "
            "(default Latin/Chinese/Japanese model ships with the OCR extra)",
        )
    scripts = sorted(
        {
            match.group(1)
            for p in models_dir.rglob("*_rec_*.onnx")
            if (match := re.match(r"([a-z_]+?)_PP-OCR", p.name)) is not None
        }
    )
    if not scripts:
        return CheckResult(
            "ocr-models", "ok",
            "no script models cached yet — they auto-download on first use",
        )
    return CheckResult("ocr-models", "ok", f"cached script models: {', '.join(scripts)}")


def check_memory_headroom() -> CheckResult:
    """RAM + commit headroom, with a local-vision model recommendation.

    Local vision dies in exactly one way on small machines: the model (or
    its num_ctx-sized compute buffer) does not fit the commit limit at
    load time. Saying so BEFORE a pipeline fails beats an empty response
    mid-run. Thresholds come from measurements on the 8 GB reference
    machine: moondream needs ~2.5 GB of commit headroom at num_ctx 768;
    qwen2.5vl:3b needs ~5 GB resident."""
    total_gb, avail_gb, commit_free_gb = _memory_status()
    if total_gb <= 0:
        return CheckResult("memory", "warn", "could not probe system memory")
    recommended = "moondream (num_ctx 768)" if total_gb < 12 else "qwen2.5vl:3b"
    message = (
        f"{avail_gb:.1f} GiB RAM free of {total_gb:.0f}, "
        f"~{commit_free_gb:.1f} GiB commit headroom — recommended local vision: {recommended}"
    )
    if commit_free_gb < 1.0:
        return CheckResult(
            "memory", "warn",
            message + " — headroom is too tight to LOAD a local vision model "
            "right now; close something or let keep_alive reuse a resident one",
        )
    return CheckResult("memory", "ok", message)


def _memory_status() -> tuple[float, float, float]:
    """(total_ram_gb, available_ram_gb, commit_headroom_gb) — 0s on failure."""
    if sys.platform == "win32":
        import ctypes

        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_uint32), ("dwMemoryLoad", ctypes.c_uint32),
                ("ullTotalPhys", ctypes.c_uint64), ("ullAvailPhys", ctypes.c_uint64),
                ("ullTotalPageFile", ctypes.c_uint64), ("ullAvailPageFile", ctypes.c_uint64),
                ("ullTotalVirtual", ctypes.c_uint64), ("ullAvailVirtual", ctypes.c_uint64),
                ("ullAvailExtendedVirtual", ctypes.c_uint64),
            ]

        status = MEMORYSTATUSEX()
        status.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return (0.0, 0.0, 0.0)
        gib = 1024 ** 3
        return (
            status.ullTotalPhys / gib,
            status.ullAvailPhys / gib,
            status.ullAvailPageFile / gib,  # commit limit minus current commit
        )
    try:
        page = os.sysconf("SC_PAGE_SIZE")
        total = os.sysconf("SC_PHYS_PAGES") * page
        avail = os.sysconf("SC_AV_PHYS_PAGES") * page
        gib = 1024 ** 3
        return (total / gib, avail / gib, avail / gib)
    except (ValueError, OSError, AttributeError):
        return (0.0, 0.0, 0.0)


def check_local_vision(fix: bool = True) -> CheckResult:
    """Local vision server liveness; with ``fix``, a dead server gets ONE
    detached restart (never `ollama stop` — that killed it once)."""
    from watch_skill.vision.local_health import (
        _ollama_binary,
        forget_liveness,
        ollama_alive,
        restart_ollama_detached,
    )

    base = get_settings().ollama_base_url
    if _ollama_binary() is None:
        return CheckResult(
            "local-vision", "ok",
            "ollama not installed — local vision is optional (cloud providers "
            "or `watch-skill setup-vision --provider ollama` to add it)",
        )
    forget_liveness(base)
    if ollama_alive(base):
        return CheckResult("local-vision", "ok", f"ollama answering at {base}")
    if not fix:
        return CheckResult(
            "local-vision", "warn",
            f"ollama installed but not answering at {base} — start it: `ollama serve`",
        )
    if restart_ollama_detached():
        import time as _time

        deadline = _time.monotonic() + 20.0
        while _time.monotonic() < deadline:
            forget_liveness(base)
            if ollama_alive(base):
                return CheckResult(
                    "local-vision", "ok", f"ollama was down — restarted, answering at {base}",
                    fix_applied="restart-detached",
                )
            _time.sleep(1.0)
    return CheckResult(
        "local-vision", "warn",
        f"ollama would not come up at {base} — check RAM headroom (see the "
        "memory check) and start it yourself: `ollama serve`",
    )


def check_index_integrity(fix: bool = True) -> CheckResult:
    """Index self-repair for the failure classes this project has hit:
    stale WAL sidecar files, corrupted cached-answer rows (quarantined),
    and indexed videos whose frames directory vanished (reindex hint)."""
    import json as _json
    import sqlite3

    from watch_skill.index.db import connect

    settings = get_settings()
    if not settings.index_path.is_file():
        return CheckResult("index", "ok", "no index yet — nothing to repair")
    repairs: list[str] = []
    problems: list[str] = []
    try:
        conn = connect()
    except sqlite3.OperationalError as exc:
        return CheckResult(
            "index", "fail",
            f"index locked or unreadable ({exc}) — another watch-skill process "
            "(often a running MCP server) may hold it; close it and re-run",
        )
    try:
        # corrupted answer-cache rows: quarantine (delete — they are pure cache)
        bad_rows = [
            row["id"]
            for row in conn.execute("SELECT id, answer_json FROM answers").fetchall()
            if not _is_valid_json(row["answer_json"], _json)
        ]
        if bad_rows:
            if fix:
                with conn:
                    conn.executemany(
                        "DELETE FROM answers WHERE id = ?", [(i,) for i in bad_rows]
                    )
                repairs.append(f"quarantined {len(bad_rows)} corrupt cached answer(s)")
            else:
                problems.append(f"{len(bad_rows)} corrupt cached answer row(s)")
        # vanished frames dirs: the answer path degrades, but say so + the fix
        missing = [
            row["id"]
            for row in conn.execute("SELECT id, frames_dir FROM videos").fetchall()
            if row["frames_dir"] and not Path(row["frames_dir"]).is_dir()
        ]
        if missing:
            problems.append(
                f"{len(missing)} video(s) lost their frames dir — re-run "
                f"watch_video on them to restore frames (text answers still work)"
            )
        if fix:
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")  # shrink stale WAL
    finally:
        conn.close()
    if problems:
        return CheckResult("index", "warn", "; ".join(problems + repairs))
    message = "; ".join(repairs) if repairs else "index healthy"
    return CheckResult("index", "ok", message, fix_applied="repairs" if repairs else None)


def _is_valid_json(blob: str, json_mod) -> bool:
    try:
        json_mod.loads(blob)
        return True
    except (ValueError, TypeError):
        return False


def check_model_files(fix: bool = True) -> CheckResult:
    """Zero-byte / truncated ONNX model files (a killed download leaves
    them behind) — deleting them is the repair; they re-download on use."""
    models_dir = get_settings().data_dir / "models"
    if not models_dir.is_dir():
        return CheckResult("model-files", "ok", "no local model cache yet")
    corrupt = [p for p in models_dir.rglob("*.onnx") if p.stat().st_size < 1024]
    if not corrupt:
        return CheckResult("model-files", "ok", "cached model files look intact")
    if fix:
        for path in corrupt:
            path.unlink(missing_ok=True)
        return CheckResult(
            "model-files", "ok",
            f"deleted {len(corrupt)} truncated model file(s) — they re-download on next use",
            fix_applied="delete-truncated",
        )
    return CheckResult(
        "model-files", "warn",
        f"{len(corrupt)} truncated model file(s): delete them and they re-download",
    )


def check_api_keys() -> CheckResult:
    """Report which provider keys are configured (informational, never values)."""
    settings = get_settings()
    present = [
        name
        for name, key in (
            ("anthropic", settings.anthropic_api_key),
            ("openai", settings.openai_api_key),
            ("gemini", settings.gemini_api_key),
            ("groq", settings.groq_api_key),
            ("openrouter", settings.openrouter_api_key),
        )
        if key is not None and key.get_secret_value().strip()
    ]
    if present:
        return CheckResult("api-keys", "ok", f"configured: {', '.join(present)}")
    return CheckResult(
        "api-keys", "ok",
        "no cloud API keys configured — local-only mode (captions + local whisper)",
    )


def run_doctor(fix: bool = True) -> DoctorReport:
    """Run every check; when ``fix`` is set, remediate what we can en route."""
    report = DoctorReport()
    report.checks.append(check_python())
    report.checks.append(check_ffmpeg(fix=fix))
    report.checks.append(check_playwright_recording(fix=fix))
    report.checks.append(check_yt_dlp(fix=fix))
    report.checks.append(check_yt_dlp_freshness(fix=fix))
    report.checks.append(check_js_runtime(fix=fix))
    report.checks.append(check_disk_space())
    report.checks.append(check_memory_headroom())
    report.checks.append(check_gpu())
    report.checks.append(check_ocr_models())
    report.checks.append(check_model_files(fix=fix))
    report.checks.append(check_index_integrity(fix=fix))
    report.checks.append(check_local_vision(fix=fix))
    report.checks.append(check_api_keys())
    return report
