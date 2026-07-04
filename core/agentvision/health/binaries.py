"""Locate and bootstrap the external binaries AgentVision depends on.

Lookup order is managed-bin-dir first, then PATH: when the self-healing
updater refreshes a binary, the refreshed copy must win over a stale system
install. All paths are handled via :class:`pathlib.Path` and quoted-safe
(both this repo and its reference live in directories with spaces).
"""
from __future__ import annotations

import os
import shutil
import stat
import sys
import zipfile
from pathlib import Path

import httpx

from agentvision.config import get_settings
from agentvision.errors import DependencyError

YT_DLP_RELEASE_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/"
FFMPEG_PORTABLE_ZIP_URL = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"

_WINDOWS = sys.platform == "win32"


def managed_bin_dir(create: bool = False) -> Path:
    """The directory where AgentVision keeps self-downloaded binaries."""
    bin_dir = get_settings().resolved_bin_dir
    if create:
        bin_dir.mkdir(parents=True, exist_ok=True)
    return bin_dir


def _exe_name(name: str) -> str:
    if _WINDOWS and not name.lower().endswith(".exe"):
        return f"{name}.exe"
    return name


def find_binary(name: str) -> Path | None:
    """Resolve ``name`` to an executable path, or ``None`` if absent.

    Checks the managed bin dir first so self-healed copies shadow stale
    system installs, then falls back to PATH.
    """
    managed = managed_bin_dir() / _exe_name(name)
    if managed.is_file():
        return managed
    found = shutil.which(name)
    return Path(found) if found else None


def require_binary(name: str) -> Path:
    """Like :func:`find_binary` but raises a structured error when missing."""
    path = find_binary(name)
    if path is None:
        raise DependencyError(
            f"required binary '{name}' was not found",
            code="health.binary_missing",
            fix="run `agentvision doctor` to bootstrap missing dependencies",
            details={"binary": name},
        )
    return path


def _download_file(url: str, dest: Path, timeout: float = 600.0) -> Path:
    """Stream ``url`` to ``dest`` (atomic: temp file then rename)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    try:
        with httpx.stream("GET", url, follow_redirects=True, timeout=timeout) as resp:
            resp.raise_for_status()
            with tmp.open("wb") as fh:
                for chunk in resp.iter_bytes(1024 * 256):
                    fh.write(chunk)
        tmp.replace(dest)
    except httpx.HTTPError as exc:
        tmp.unlink(missing_ok=True)
        raise DependencyError(
            f"download failed for {url}: {exc}",
            code="health.download_failed",
            fix="check network connectivity and retry `agentvision doctor`",
            details={"url": url},
        ) from exc
    return dest


def _make_executable(path: Path) -> None:
    if not _WINDOWS:
        path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def bootstrap_yt_dlp() -> Path:
    """Download the standalone yt-dlp binary into the managed bin dir.

    The standalone binary supports ``yt-dlp -U`` self-update, which the
    self-healing acquisition path relies on.
    """
    asset = "yt-dlp.exe" if _WINDOWS else "yt-dlp"
    dest = managed_bin_dir(create=True) / asset
    _download_file(YT_DLP_RELEASE_URL + asset, dest)
    _make_executable(dest)
    return dest


def bootstrap_ffmpeg_portable() -> tuple[Path, Path]:
    """Windows-only last resort: extract portable ffmpeg + ffprobe from gyan.dev.

    Returns (ffmpeg_path, ffprobe_path) inside the managed bin dir.
    """
    if not _WINDOWS:
        raise DependencyError(
            "portable ffmpeg bootstrap is implemented for Windows only",
            code="health.unsupported_platform",
            fix="install ffmpeg via your system package manager",
        )
    bin_dir = managed_bin_dir(create=True)
    zip_path = bin_dir / "ffmpeg-release-essentials.zip"
    _download_file(FFMPEG_PORTABLE_ZIP_URL, zip_path)
    wanted = {"ffmpeg.exe": None, "ffprobe.exe": None}
    with zipfile.ZipFile(zip_path) as zf:
        for member in zf.namelist():
            leaf = member.rsplit("/", 1)[-1].lower()
            if leaf in wanted and wanted[leaf] is None:
                target = bin_dir / leaf
                with zf.open(member) as src, target.open("wb") as dst:
                    shutil.copyfileobj(src, dst)
                wanted[leaf] = target
    zip_path.unlink(missing_ok=True)
    missing = [name for name, path in wanted.items() if path is None]
    if missing:
        raise DependencyError(
            f"portable ffmpeg zip did not contain: {', '.join(missing)}",
            code="health.bootstrap_failed",
            fix="install ffmpeg manually: winget install Gyan.FFmpeg",
        )
    return wanted["ffmpeg.exe"], wanted["ffprobe.exe"]  # type: ignore[return-value]


def bootstrap_deno() -> Path:
    """Get a deno binary into the managed bin dir (copy or portable zip).

    yt-dlp needs a JavaScript runtime for YouTube n-sig decryption; without
    one YouTube throttles downloads to a crawl. Prefers copying an existing
    system deno (e.g. winget's, which lands off-PATH for running processes);
    falls back to the official release zip.
    """
    bin_dir = managed_bin_dir(create=True)
    dest = bin_dir / _exe_name("deno")
    existing = shutil.which("deno")
    if existing is None and _WINDOWS:
        winget_root = (
            Path.home() / "AppData" / "Local" / "Microsoft" / "WinGet" / "Packages"
        )
        for candidate in winget_root.glob("DenoLand.Deno*/deno.exe"):
            existing = str(candidate)
            break
    if existing:
        shutil.copy2(existing, dest)
        return dest
    platform_tag = "x86_64-pc-windows-msvc" if _WINDOWS else (
        "aarch64-apple-darwin" if sys.platform == "darwin" else "x86_64-unknown-linux-gnu"
    )
    url = f"https://github.com/denoland/deno/releases/latest/download/deno-{platform_tag}.zip"
    zip_path = bin_dir / "deno.zip"
    _download_file(url, zip_path)
    with zipfile.ZipFile(zip_path) as zf:
        for member in zf.namelist():
            if member.rsplit("/", 1)[-1].lower().startswith("deno"):
                with zf.open(member) as src, dest.open("wb") as dst:
                    shutil.copyfileobj(src, dst)
                break
    zip_path.unlink(missing_ok=True)
    if not dest.is_file():
        raise DependencyError(
            "deno bootstrap failed",
            code="health.bootstrap_failed",
            fix="install deno manually: winget install DenoLand.Deno",
        )
    _make_executable(dest)
    return dest


def prepend_bin_dir_to_path() -> None:
    """Make managed binaries visible to subprocesses spawned via bare names."""
    bin_dir = str(managed_bin_dir())
    parts = os.environ.get("PATH", "").split(os.pathsep)
    if bin_dir not in parts:
        os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
