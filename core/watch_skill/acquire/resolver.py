"""Resolve ANY input to a local video file, with cache and fallback chain.

Chain for network sources (each hop logs why the previous one failed):
yt-dlp -> (auto-update + retry, inside ytdlp.download) -> self-hosted cobalt
(only when WATCHSKILL_COBALT_API_URL is set — the public instance requires
auth) -> direct ffmpeg pull. Direct/manifest URLs try yt-dlp first too (it handles
both), with ffmpeg as the reliable second step. Screen/window capture is
provided by ``watch_skill.loop.capture`` (Milestone 3) — the resolver returns
a structured error pointing there until then.
"""
from __future__ import annotations

import sys
from pathlib import Path

from watch_skill.acquire import cache, cobalt, direct, ytdlp
from watch_skill.acquire.sources import SourceKind, classify_source, is_url_kind
from watch_skill.acquire.types import AcquireResult
from watch_skill.errors import AcquisitionError
from watch_skill.health.log import record_incident

VIDEO_EXTS = ytdlp.VIDEO_EXTS


def _resolve_local(source: str) -> AcquireResult:
    path = Path(source).expanduser().resolve()
    if not path.is_file():
        raise AcquisitionError(
            f"file not found: {path}",
            code="acquire.file_not_found",
            fix="check the path; remember to quote paths containing spaces",
            details={"source": source},
        )
    if path.suffix.lower() not in VIDEO_EXTS:
        print(
            f"[watch-skill] warning: {path.suffix} is not a known video extension — proceeding",
            file=sys.stderr,
        )
    return AcquireResult(
        source=source,
        kind=SourceKind.LOCAL_FILE,
        video_path=path,
        info={"title": path.name, "url": str(path)},
        acquirer="local",
    )


def _from_cache(source: str, kind: SourceKind) -> AcquireResult | None:
    entry = cache.lookup(source)
    if entry is None or entry.video_path is None:
        return None
    print(f"[watch-skill] cache hit: {entry.dir}", file=sys.stderr)
    return AcquireResult(
        source=source,
        kind=kind,
        video_path=entry.video_path,
        subtitle_path=entry.subtitle_path,
        info=entry.info,
        from_cache=True,
        acquirer="cache",
    )


def _try_chain(
    source: str, kind: SourceKind, out_dir: Path,
    audio_only: bool, duration_cap: float | None,
) -> AcquireResult:
    """Walk the fallback chain, recording each hop's failure."""
    failures: list[str] = []

    try:
        dl = ytdlp.download(source, out_dir, audio_only=audio_only)
        return AcquireResult(
            source=source, kind=kind, video_path=Path(dl["video_path"]),
            subtitle_path=dl["subtitle_path"], info=dl["info"], acquirer="yt-dlp",
        )
    except AcquisitionError as exc:
        failures.append(f"yt-dlp: {exc.message}")
        record_incident("acquire_fallback", "yt-dlp failed, trying fallbacks", url=source)
        print(f"[watch-skill] yt-dlp failed ({exc.code}) — trying fallbacks…", file=sys.stderr)

    if kind == SourceKind.PAGE_URL and cobalt.is_configured():
        try:
            video = cobalt.download(source, out_dir / "media.mp4")
            return AcquireResult(
                source=source, kind=kind, video_path=video, acquirer="cobalt",
                info={"url": source},
            )
        except AcquisitionError as exc:
            failures.append(f"cobalt: {exc.message}")
            record_incident("acquire_fallback", "cobalt failed, trying ffmpeg", url=source)
            print(f"[watch-skill] cobalt failed ({exc.code}) — trying direct ffmpeg…", file=sys.stderr)

    try:
        video = direct.ffmpeg_pull(source, out_dir / "media.mp4", duration_seconds=duration_cap)
        return AcquireResult(
            source=source, kind=kind, video_path=video, acquirer="ffmpeg",
            info={"url": source},
        )
    except AcquisitionError as exc:
        failures.append(f"ffmpeg: {exc.message}")

    raise AcquisitionError(
        "every acquirer in the fallback chain failed",
        code="acquire.chain_exhausted",
        fix="check the URL; if it needs login or is region-locked, Watch Skill "
        "will not bypass that (privacy invariant: no cookies, no logins)",
        details={"source": source, "failures": failures},
    )


def acquire(
    source: str,
    audio_only: bool = False,
    duration_cap: float | None = None,
    use_cache: bool = True,
) -> AcquireResult:
    """Resolve ``source`` (URL / manifest / local path / capture spec) to local files.

    Network downloads land in the content-addressed cache and are reused on
    the next call. ``duration_cap`` bounds live-stream capture.
    """
    kind = classify_source(source)

    if kind in (SourceKind.SCREEN, SourceKind.WINDOW):
        raise AcquisitionError(
            "screen/window capture is provided by the loop module",
            code="acquire.capture_required",
            fix="use `watch-skill capture` / the capture() API (Milestone 3)",
            details={"source": source, "kind": kind.value},
        )

    if kind == SourceKind.LOCAL_FILE:
        return _resolve_local(source)

    assert is_url_kind(kind)
    if use_cache:
        cached = _from_cache(source, kind)
        if cached is not None:
            return cached

    out_dir = cache.entry_dir(source, create=True)
    result = _try_chain(source, kind, out_dir, audio_only, duration_cap)
    # Audio-only fetches are not committed: a later full fetch must not be
    # shadowed by a cache entry that has no video frames in it.
    if use_cache and not audio_only:
        cache.commit(source, result.video_path, result.subtitle_path, result.info)
    return result


def fetch_captions_only(source: str) -> AcquireResult:
    """Probe captions + metadata for a URL without downloading media."""
    kind = classify_source(source)
    if not is_url_kind(kind):
        raise AcquisitionError(
            "captions probe only applies to URLs",
            code="acquire.not_a_url",
            details={"source": source},
        )
    out_dir = cache.entry_dir(source, create=True)
    probe = ytdlp.fetch_captions(source, out_dir)
    return AcquireResult(
        source=source, kind=kind, video_path=None,
        subtitle_path=probe["subtitle_path"], info=probe["info"], acquirer="yt-dlp",
    )
