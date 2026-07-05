"""Direct ffmpeg pull: media URLs and HLS/DASH manifests, incl. bounded live capture."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from watch_skill.errors import AcquisitionError
from watch_skill.health.binaries import require_binary


def ffmpeg_pull(
    url: str,
    dest: Path,
    duration_seconds: float | None = None,
    timeout: float = 3600.0,
) -> Path:
    """Fetch a direct media URL or HLS/DASH manifest into a local mp4.

    ``duration_seconds`` bounds the capture — required for live streams,
    which would otherwise download forever. Stream-copies when possible and
    falls back to transcoding only if the container rejects the codecs.
    """
    ffmpeg = require_binary("ffmpeg")
    dest.parent.mkdir(parents=True, exist_ok=True)

    base: list[str] = [str(ffmpeg), "-hide_banner", "-loglevel", "error", "-y", "-i", url]
    if duration_seconds is not None:
        base += ["-t", f"{duration_seconds:.3f}"]

    copy_cmd = base + ["-c", "copy", "-movflags", "+faststart", str(dest)]
    result = subprocess.run(
        copy_cmd, capture_output=True, text=True, timeout=timeout,
        encoding="utf-8", errors="replace",
    )
    if result.returncode != 0 or not dest.is_file() or dest.stat().st_size == 0:
        print("[watch-skill] stream copy failed — transcoding…", file=sys.stderr)
        transcode_cmd = base + ["-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", str(dest)]
        result = subprocess.run(
            transcode_cmd, capture_output=True, text=True, timeout=timeout,
            encoding="utf-8", errors="replace",
        )
    if result.returncode != 0 or not dest.is_file() or dest.stat().st_size == 0:
        raise AcquisitionError(
            "ffmpeg could not fetch the media URL",
            code="acquire.ffmpeg_pull_failed",
            fix="check the URL is reachable and actually points at media/a manifest",
            details={"url": url, "stderr_tail": result.stderr[-2000:]},
        )
    return dest
