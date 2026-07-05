"""Cloud STT (Groq whisper-large-v3, then OpenAI) — OPT-IN ONLY.

Hard privacy rule, enforced here and tested: this module refuses to send
anything unless ``cloud_stt_enabled`` is true, and the only thing it ever
sends is the extracted mono-16 kHz audio file — never the video.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import httpx

from watch_skill.config import get_settings
from watch_skill.errors import TranscriptionError
from watch_skill.transcribe import audio as audio_mod
from watch_skill.transcribe.types import Segment, Transcript

GROQ_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions"
GROQ_MODEL = "whisper-large-v3"
OPENAI_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions"
OPENAI_MODEL = "whisper-1"

MAX_ATTEMPTS = 4
RETRY_BASE_DELAY = 2.0


def _require_cloud_enabled() -> None:
    if not get_settings().cloud_stt_enabled:
        raise TranscriptionError(
            "cloud STT is disabled (privacy default)",
            code="transcribe.cloud_disabled",
            fix="set WATCHSKILL_CLOUD_STT_ENABLED=1 to opt in — only extracted "
            "audio is sent, never the video file",
        )


def pick_backend(preferred: str | None = None) -> tuple[str, str]:
    """Return (backend, api_key); Groq preferred (cheaper, faster)."""
    settings = get_settings()
    options = [
        ("groq", settings.groq_api_key),
        ("openai", settings.openai_api_key),
    ]
    if preferred:
        options = [opt for opt in options if opt[0] == preferred]
    for backend, key in options:
        if key is not None and key.get_secret_value().strip():
            return backend, key.get_secret_value().strip()
    raise TranscriptionError(
        "no cloud STT API key configured",
        code="transcribe.no_api_key",
        fix="set WATCHSKILL_GROQ_API_KEY (preferred) or WATCHSKILL_OPENAI_API_KEY",
    )


def _post_once(endpoint: str, api_key: str, model: str, audio_path: Path) -> dict:
    with audio_path.open("rb") as fh:
        response = httpx.post(
            endpoint,
            headers={
                "Authorization": f"Bearer {api_key}",
                # default python UAs trip Groq's Cloudflare WAF (reference-learned)
                "User-Agent": "watch-skill/0.6 (+https://github.com/oxbshw/watch-skill)",
            },
            data={"model": model, "response_format": "verbose_json", "temperature": "0"},
            files={"file": (audio_path.name, fh, "audio/mpeg")},
            timeout=300.0,
        )
    response.raise_for_status()
    return response.json()


def _post_with_retry(endpoint: str, api_key: str, model: str, audio_path: Path) -> dict:
    last_error: Exception | None = None
    for attempt in range(MAX_ATTEMPTS):
        try:
            return _post_once(endpoint, api_key, model, audio_path)
        except httpx.HTTPStatusError as exc:
            code = exc.response.status_code
            if 400 <= code < 500 and code != 429:
                raise TranscriptionError(
                    f"cloud STT rejected the request (HTTP {code})",
                    code="transcribe.cloud_rejected",
                    details={"status": code, "body": exc.response.text[:400]},
                ) from exc
            retry_after = exc.response.headers.get("Retry-After")
            delay = float(retry_after) if retry_after else RETRY_BASE_DELAY * 2**attempt
            last_error = exc
        except httpx.HTTPError as exc:
            delay = RETRY_BASE_DELAY * (attempt + 1)
            last_error = exc
        if attempt < MAX_ATTEMPTS - 1:
            print(f"[watch-skill] cloud STT retry in {delay:.1f}s…", file=sys.stderr)
            time.sleep(delay)
    raise TranscriptionError(
        f"cloud STT failed after {MAX_ATTEMPTS} attempts: {last_error}",
        code="transcribe.cloud_failed",
    )


def _segments_from_response(data: dict, offset: float = 0.0) -> list[Segment]:
    out: list[Segment] = []
    for seg in data.get("segments") or []:
        text = (seg.get("text") or "").strip()
        if text:
            out.append(
                Segment(
                    start=round(float(seg.get("start") or 0.0) + offset, 2),
                    end=round(float(seg.get("end") or 0.0) + offset, 2),
                    text=text,
                )
            )
    if not out and (data.get("text") or "").strip():
        out.append(Segment(start=offset, end=offset, text=data["text"].strip()))
    return out


def merge_overlapping(chunks: list[list[Segment]]) -> list[Segment]:
    """Concatenate chunk transcripts, dropping duplicated overlap segments.

    Chunks overlap by ~2 s; a segment from chunk n+1 that starts before the
    previous chunk's last kept segment ends AND repeats its text is the
    overlap echo — skip it.
    """
    merged: list[Segment] = []
    for segments in chunks:
        for seg in segments:
            if merged and seg.start < merged[-1].end - 0.2:
                if seg.text == merged[-1].text or merged[-1].text.endswith(seg.text):
                    continue
            merged.append(seg)
    return merged


def transcribe_cloud(
    video_path: Path,
    work_dir: Path,
    preferred_backend: str | None = None,
) -> Transcript:
    """Extract audio, upload (chunked with overlap if large), merge segments."""
    _require_cloud_enabled()
    backend, api_key = pick_backend(preferred_backend)
    endpoint, model = (
        (GROQ_ENDPOINT, GROQ_MODEL) if backend == "groq" else (OPENAI_ENDPOINT, OPENAI_MODEL)
    )

    audio_path = audio_mod.extract_audio(video_path, work_dir / "audio.mp3")
    size = audio_path.stat().st_size
    if size <= audio_mod.MAX_UPLOAD_BYTES:
        data = _post_with_retry(endpoint, api_key, model, audio_path)
        segments = _segments_from_response(data)
    else:
        duration = audio_mod.audio_duration(audio_path)
        plan = audio_mod.plan_chunks(duration, size)
        print(
            f"[watch-skill] audio {size / 1024**2:.0f} MB — {len(plan)} overlapping chunks…",
            file=sys.stderr,
        )
        pieces: list[list[Segment]] = []
        failures = 0
        for i, (chunk_path, offset) in enumerate(
            audio_mod.split_audio(audio_path, work_dir / "chunks", plan)
        ):
            try:
                data = _post_with_retry(endpoint, api_key, model, chunk_path)
                pieces.append(_segments_from_response(data, offset=offset))
            except TranscriptionError as exc:
                failures += 1
                print(f"[watch-skill] chunk {i + 1}/{len(plan)} failed: {exc.code}", file=sys.stderr)
        if failures == len(plan):
            raise TranscriptionError(
                "cloud STT failed on every chunk", code="transcribe.cloud_failed"
            )
        segments = merge_overlapping(pieces)

    if not segments:
        raise TranscriptionError("cloud STT returned no segments", code="transcribe.empty")
    return Transcript(segments=segments, source=f"whisper-{backend}")
