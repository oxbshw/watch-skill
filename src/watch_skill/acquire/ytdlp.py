"""yt-dlp wrapper with self-healing extractor-breakage recovery.

Privacy invariants (tested): no cookies, no logins — yt-dlp only ever
requests public data. Every invocation passes ``--`` before the URL so a
malicious "URL" can never smuggle extra flags.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

from watch_skill.config import get_settings
from watch_skill.errors import AcquisitionError
from watch_skill.health.binaries import require_binary
from watch_skill.health.doctor import update_yt_dlp
from watch_skill.health.log import record_incident

VIDEO_EXTS = {".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi", ".flv", ".wmv"}

# Known extractor-breakage fingerprints. When yt-dlp fails with one of these,
# the extractor (not the network or the video) is the likely culprit, and a
# self-update usually fixes it — sites break yt-dlp constantly.
BREAKAGE_PATTERNS = [
    r"unable to extract",
    r"signature extraction failed",
    r"nsig extraction failed",
    r"failed to decrypt",
    r"player .* not found",
    r"unsupported url",
    r"this extractor is broken",
    r"confirm you.?re not a bot",
]
_BREAKAGE_RE = re.compile("|".join(BREAKAGE_PATTERNS), re.IGNORECASE)


def is_breakage(stderr: str) -> bool:
    """True when yt-dlp stderr matches a known extractor-breakage pattern."""
    return bool(_BREAKAGE_RE.search(stderr))


def _run_yt_dlp(args: list[str], url: str, timeout: float = 3600.0) -> subprocess.CompletedProcess[str]:
    """Run yt-dlp with progress echoed to our stderr and stderr captured."""
    from watch_skill.health.binaries import prepend_bin_dir_to_path

    prepend_bin_dir_to_path()  # yt-dlp must find the managed deno for YouTube n-sig
    yt_dlp = require_binary("yt-dlp")
    cmd = [str(yt_dlp), *args, "--", url]
    result = subprocess.run(
        cmd, capture_output=True, text=True, timeout=timeout,
        encoding="utf-8", errors="replace",
    )
    if result.stderr:
        print(result.stderr, file=sys.stderr, end="")
    return result


def _common_subtitle_args() -> list[str]:
    langs = get_settings().subtitle_langs
    return [
        "--write-info-json",
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs", langs,
        "--sub-format", "vtt",
        "--convert-subs", "vtt",
        "--no-playlist",
        "--ignore-errors",
    ]


def _pick_subtitle(out_dir: Path, original_lang: str | None = None) -> Path | None:
    """Best VTT, in order: the video's ORIGINAL language, then plain variants,
    then anything. An original-language track always beats an auto-translation
    ('en' subs on an Arabic video are machine-translated, not spoken)."""
    candidates = sorted(out_dir.glob("media*.vtt"))
    if not candidates:
        return None
    if original_lang:
        prefix = original_lang.split("-")[0].lower()
        originals = [c for c in candidates if c.name.lower().split(".")[-2].startswith(prefix)]
        if originals:
            plain = [c for c in originals if "-orig" not in c.name]
            return (plain or originals)[0]
    preferred = [c for c in candidates if "-orig" not in c.name]
    return (preferred or candidates)[0]


def _ensure_original_subs(out_dir: Path, url: str, info: dict[str, Any]) -> None:
    """Fetch the original-language track when the first pass missed it.

    The first pass uses the configured ``subtitle_langs`` (default en.*); for
    a video spoken in another language that yields an auto-TRANSLATION. One
    targeted follow-up call fetches the real thing.
    """
    lang = (info.get("language") or "").split("-")[0].lower()
    if not lang:
        return
    if any(c.name.lower().split(".")[-2].startswith(lang) for c in out_dir.glob("media*.vtt")):
        return
    args = [
        "--skip-download",
        "--write-subs", "--write-auto-subs",
        "--sub-langs", f"{lang}.*",
        "--sub-format", "vtt", "--convert-subs", "vtt",
        "--no-playlist", "--ignore-errors",
        "-o", str(out_dir / "media.%(ext)s"),
    ]
    _run_yt_dlp(args, url, timeout=300.0)


def _pick_video(out_dir: Path) -> Path | None:
    for ext in (".mp4", ".mkv", ".webm", ".mov", ".m4a", ".mp3", ".opus"):
        for candidate in sorted(out_dir.glob(f"media*{ext}")):
            return candidate
    return None


def _read_info(out_dir: Path, url: str) -> dict[str, Any]:
    info_path = out_dir / "media.info.json"
    if not info_path.exists():
        return {"url": url}
    try:
        raw = json.loads(info_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"url": url}
    return {
        "title": raw.get("title"),
        "uploader": raw.get("uploader") or raw.get("channel"),
        "duration": raw.get("duration"),
        "language": raw.get("language"),
        "url": raw.get("webpage_url") or url,
    }


def fetch_captions(url: str, out_dir: Path) -> dict[str, Any]:
    """Fetch metadata + best VTT captions without downloading any media."""
    out_dir.mkdir(parents=True, exist_ok=True)
    args = [
        "--skip-download",
        *_common_subtitle_args(),
        "-o", str(out_dir / "media.%(ext)s"),
    ]
    _run_yt_dlp(args, url, timeout=300.0)
    info = _read_info(out_dir, url)
    _ensure_original_subs(out_dir, url, info)
    return {
        "video_path": None,
        "subtitle_path": _pick_subtitle(out_dir, original_lang=info.get("language")),
        "info": info,
    }


MAX_VIDEO_HEIGHT = 1080
"""The hard ceiling. Nothing above this is downloaded whatever the setting
says: 4K costs minutes of transfer and gigabytes of disk to answer a question
that 720p answers just as well."""


def _capped_height() -> int:
    from watch_skill.config import get_settings  # noqa: PLC0415

    requested = getattr(get_settings(), "max_video_height", 720) or 720
    return max(144, min(int(requested), MAX_VIDEO_HEIGHT))


def _video_format(allow_video_only: bool = False) -> str:
    """The yt-dlp format selector for a video download.

    Three properties, and the third is why this takes an argument:

    **Every rung carries audio — unless we know there is none.** The old tail
    was ``/bv+ba/b`` and, in the proposed patch, ``/bv*[height<=N]`` — a
    video-only stream. A site that does not offer the preferred combined
    format would silently yield a file with no audio track, and the failure
    surfaces much later as a transcript that is mysteriously empty.

    But a silent video is a real thing: a screen recording made without audio
    is not broken, and refusing to download it would be its own bug. So
    ``allow_video_only`` exists, and the *only* caller that sets it is the one
    that has already asked the source and been told there is no audio stream.
    "The source has no audio" and "our selector dropped the audio" are
    different facts, and only the first one earns a video-only download.

    **The height cap is never dropped.** The old tail had no ``height``
    predicate at all, so the fallback rung could select 4K precisely when the
    preferred rung had failed.
    """
    height = _capped_height()
    rungs = [
        f"bv*[height<={height}]+ba",   # best video under the cap, plus audio
        f"b[height<={height}]",        # a combined stream under the cap
        "b",                           # last resort that still carries audio
    ]
    if allow_video_only:
        # Appended last, so it is reached only after every audio-bearing rung
        # has failed on a source we already know is silent.
        rungs.append(f"bv*[height<={height}]")
    return "/".join(rungs)


def probe_has_audio(url: str) -> bool | None:
    """Does the remote source carry an audio stream?

    Returns None when yt-dlp cannot tell us — unknown is not the same as no,
    and treating it as no would quietly authorise a video-only download for a
    source that had audio all along.
    """
    try:
        result = _run_yt_dlp(["-J", "--no-warnings", "--skip-download"], url)
    except Exception:  # noqa: BLE001 - an unanswerable probe is not a failure
        return None
    try:
        info = json.loads(result.stdout or "{}")
    except json.JSONDecodeError:
        return None
    formats = info.get("formats")
    if not isinstance(formats, list) or not formats:
        return None
    for fmt in formats:
        if not isinstance(fmt, dict):
            continue
        acodec = fmt.get("acodec")
        if acodec and acodec != "none":
            return True
        if fmt.get("abr") or fmt.get("asr"):
            return True
    return False


def _download_once(url: str, out_dir: Path, audio_only: bool) -> dict[str, Any]:
    """One yt-dlp download attempt. Raises AcquisitionError with captured stderr."""
    out_dir.mkdir(parents=True, exist_ok=True)

    def attempt(selector: str):
        return _run_yt_dlp(
            ["-N", "8", "-f", selector, "--merge-output-format", "mp4",
             *_common_subtitle_args(), "-o", str(out_dir / "media.%(ext)s")],
            url,
        )

    audio_status = "audio_expected"
    if audio_only:
        result = attempt("ba/bestaudio")
    else:
        result = attempt(_video_format())
        if _pick_video(out_dir) is None:
            # Every rung wanted audio and none matched. Before giving up, ask
            # whether this source has audio at all — a screen recording made
            # without sound is not a broken download, and refusing it would be
            # its own bug. Only a definite "no" authorises a video-only retry.
            has_audio = probe_has_audio(url)
            if has_audio is False:
                result = attempt(_video_format(allow_video_only=True))
                audio_status = "audio_unavailable"
            elif has_audio is None:
                audio_status = "audio_unknown"

    video = _pick_video(out_dir)
    # yt-dlp may exit non-zero on a subtitle 429 even when the media landed;
    # "media file present" is the success test (reference-proven behavior).
    if video is None:
        raise AcquisitionError(
            f"yt-dlp produced no media file (exit {result.returncode})",
            code="acquire.ytdlp_failed",
            fix="the resolver will try auto-update and fallback acquirers",
            details={"url": url, "stderr_tail": result.stderr[-2000:],
                     "audio_status": audio_status},
        )
    info = _read_info(out_dir, url)
    _ensure_original_subs(out_dir, url, info)
    return {
        "video_path": video,
        "subtitle_path": _pick_subtitle(out_dir, original_lang=info.get("language")),
        "info": info,
        # Carried forward so downstream can tell "nobody spoke" from "we lost
        # the audio track" — an empty transcript means something different in
        # each case.
        "audio_status": audio_status,
    }


def download(url: str, out_dir: Path, audio_only: bool = False) -> dict[str, Any]:
    """Download with self-healing: on extractor breakage, update yt-dlp and retry once."""
    try:
        return _download_once(url, out_dir, audio_only)
    except AcquisitionError as exc:
        stderr_tail = str(exc.details.get("stderr_tail", ""))
        if not is_breakage(stderr_tail):
            raise
        record_incident(
            "ytdlp_breakage", "extractor breakage detected — self-updating", url=url
        )
        print("[watch-skill] yt-dlp extractor breakage — updating and retrying…", file=sys.stderr)
        yt_dlp = require_binary("yt-dlp")
        if not update_yt_dlp(yt_dlp):
            raise AcquisitionError(
                "yt-dlp broke and self-update failed",
                code="acquire.ytdlp_update_failed",
                fix="update yt-dlp manually (`yt-dlp -U`) or retry later",
                details=exc.details,
            ) from exc
        return _download_once(url, out_dir, audio_only)
