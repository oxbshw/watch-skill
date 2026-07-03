"""cobalt.tools fallback acquirer.

Used only after yt-dlp (and its self-update retry) failed. Best-effort: the
public cobalt API has changed before, so failures here are structured and the
chain simply moves on. The instance is configurable via
``AGENTVISION_COBALT_API_URL`` for self-hosted deployments.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import httpx

from agentvision.errors import AcquisitionError

DEFAULT_COBALT_API = "https://api.cobalt.tools/"


def _api_url() -> str:
    return os.environ.get("AGENTVISION_COBALT_API_URL", DEFAULT_COBALT_API)


def _request_media_url(url: str, timeout: float = 60.0) -> str:
    """Ask the cobalt instance to resolve ``url`` to a downloadable media URL."""
    try:
        response = httpx.post(
            _api_url(),
            json={"url": url, "videoQuality": "720", "filenameStyle": "basic"},
            headers={"Accept": "application/json", "Content-Type": "application/json"},
            timeout=timeout,
            follow_redirects=True,
        )
        payload: dict[str, Any] = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise AcquisitionError(
            f"cobalt API unreachable or returned non-JSON: {exc}",
            code="acquire.cobalt_unreachable",
            fix="set AGENTVISION_COBALT_API_URL to a working cobalt instance, or skip",
            details={"url": url, "api": _api_url()},
        ) from exc

    status = payload.get("status")
    if status in ("tunnel", "redirect", "stream") and payload.get("url"):
        return str(payload["url"])
    raise AcquisitionError(
        f"cobalt could not resolve this URL (status={status!r})",
        code="acquire.cobalt_failed",
        fix="the resolver will continue down the fallback chain",
        details={"url": url, "response": {k: payload.get(k) for k in ("status", "error")}},
    )


def download(url: str, dest: Path, timeout: float = 1800.0) -> Path:
    """Resolve via cobalt and stream the media to ``dest``."""
    media_url = _request_media_url(url)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    try:
        with httpx.stream("GET", media_url, follow_redirects=True, timeout=timeout) as resp:
            resp.raise_for_status()
            with tmp.open("wb") as fh:
                for chunk in resp.iter_bytes(1024 * 256):
                    fh.write(chunk)
        tmp.replace(dest)
    except httpx.HTTPError as exc:
        tmp.unlink(missing_ok=True)
        raise AcquisitionError(
            f"cobalt media download failed: {exc}",
            code="acquire.cobalt_download_failed",
            fix="the resolver will continue down the fallback chain",
            details={"url": url},
        ) from exc
    if not dest.is_file() or dest.stat().st_size == 0:
        raise AcquisitionError(
            "cobalt returned an empty file",
            code="acquire.cobalt_empty",
            details={"url": url},
        )
    return dest
