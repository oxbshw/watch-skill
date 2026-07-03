"""`agentvision doctor` — preflight checks that fix what they can.

Design (inherited from the reference project's setup.py, then extended):
silent-on-success semantics for agents, structured results for machines,
and — unlike the reference, which only *prints* install commands on
Windows — an actual self-healing bootstrap: winget -> choco -> portable
binaries downloaded into a managed bin dir.
"""
from __future__ import annotations

import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Callable, Literal

from agentvision.config import get_settings
from agentvision.errors import DependencyError
from agentvision.health import binaries
from agentvision.health.log import record_incident

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
    report.checks.append(check_yt_dlp(fix=fix))
    report.checks.append(check_yt_dlp_freshness(fix=fix))
    report.checks.append(check_disk_space())
    report.checks.append(check_gpu())
    report.checks.append(check_api_keys())
    return report
