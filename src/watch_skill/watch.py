"""The core watch pipeline: acquire -> perceive -> transcribe.

This is the engine's front door for one-shot analysis. Indexing (Milestone 2)
builds on the same WatchResult.
"""
from __future__ import annotations

import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from watch_skill.acquire import AcquireResult, acquire, fetch_captions_only
from watch_skill.acquire.sources import classify_source, is_url_kind
from watch_skill.errors import PerceptionError
from watch_skill.perceive import PerceptionResult, perceive, probe
from watch_skill.perceive.types import VideoMetadata
from watch_skill.transcribe import Transcript, get_transcript


@dataclass
class WatchResult:
    """Everything one watch pass produced."""

    acquisition: AcquireResult
    metadata: VideoMetadata
    perception: PerceptionResult | None
    transcript: Transcript
    work_dir: Path
    start_seconds: float | None = None
    end_seconds: float | None = None

    @property
    def focused(self) -> bool:
        return self.start_seconds is not None or self.end_seconds is not None


def _validate_window(
    start: float | None, end: float | None, duration: float
) -> None:
    if start is not None and start < 0:
        raise PerceptionError(
            "start must be non-negative", code="perceive.bad_window",
            fix="pass start as SS, MM:SS, or HH:MM:SS from the video's own timeline",
        )
    if start is not None and end is not None and end <= start:
        raise PerceptionError(
            "end must be greater than start", code="perceive.bad_window",
            fix="swap the values or drop end to sample from start to the video's end",
        )
    if duration > 0 and start is not None and start >= duration:
        raise PerceptionError(
            f"start {start:.1f}s is past the end of the video ({duration:.1f}s)",
            code="perceive.bad_window",
            fix=f"use a start below {duration:.0f}s, or drop the window to watch the whole video",
        )


def watch(
    source: str,
    start_seconds: float | None = None,
    end_seconds: float | None = None,
    max_frames: int | None = None,
    frame_width: int | None = None,
    cue_timestamps: list[float] | None = None,
    transcript_only: bool = False,
    run_ocr: bool | None = None,
    allow_local_whisper: bool | None = None,
    allow_cloud_stt: bool | None = None,
    whisper_model: str | None = None,
    diarize: bool | None = None,
    duration_cap: float | None = None,
    out_dir: Path | None = None,
    use_cache: bool = True,
    on_progress: Callable[[str, float], None] | None = None,
) -> WatchResult:
    """Analyze any video source; returns frames + transcript + metadata.

    ``transcript_only`` skips media download entirely when captions exist
    (reference-proven fast path). ``cue_timestamps`` pins frames at given
    absolute times. ``duration_cap`` bounds live-stream capture.
    """
    work_dir = Path(out_dir).resolve() if out_dir else Path(tempfile.mkdtemp(prefix="watch-skill-"))
    work_dir.mkdir(parents=True, exist_ok=True)

    def progress(phase: str, fraction: float) -> None:
        if on_progress is not None:
            on_progress(phase, fraction)

    progress("acquiring source", 0.05)
    kind = classify_source(source)
    acq: AcquireResult
    if transcript_only and not cue_timestamps and is_url_kind(kind):
        acq = fetch_captions_only(source)
        if acq.subtitle_path is None:
            # no captions -> whisper needs audio after all
            acq = acquire(source, audio_only=True, duration_cap=duration_cap, use_cache=use_cache)
    else:
        acq = acquire(source, duration_cap=duration_cap, use_cache=use_cache)

    if acq.video_path is not None:
        metadata = probe(acq.video_path)
    else:
        metadata = VideoMetadata(
            duration_seconds=float(acq.info.get("duration") or 0),
            width=None, height=None, fps=None, codec=None, has_audio=False,
        )
    _validate_window(start_seconds, end_seconds, metadata.duration_seconds)

    progress("extracting frames (scenes, dedup, OCR)", 0.35)
    perception: PerceptionResult | None = None
    if not transcript_only and acq.video_path is not None:
        perception = perceive(
            acq.video_path,
            work_dir / "frames",
            source_label=source,
            start_seconds=start_seconds,
            end_seconds=end_seconds,
            max_frames=max_frames,
            frame_width=frame_width,
            cue_timestamps=cue_timestamps,
            run_ocr=run_ocr,
            ocr_lang=acq.info.get("language"),  # auto: Arabic video -> Arabic OCR
            metadata=metadata,
        )

    progress("transcribing (captions -> local whisper)", 0.7)
    transcript = get_transcript(
        acq.video_path,
        work_dir,
        subtitle_path=acq.subtitle_path,
        has_audio=metadata.has_audio,
        allow_local=allow_local_whisper,
        allow_cloud=allow_cloud_stt,
        whisper_model=whisper_model,
        start_seconds=start_seconds,
        end_seconds=end_seconds,
    )
    if start_seconds is not None or end_seconds is not None:
        transcript = transcript.filter_range(start_seconds, end_seconds)

    from watch_skill.config import get_settings

    do_diarize = get_settings().diarization_enabled if diarize is None else diarize
    if do_diarize and transcript and acq.video_path is not None:
        from watch_skill.transcribe.diarize import diarize_transcript

        transcript = diarize_transcript(transcript, acq.video_path, work_dir)

    return WatchResult(
        acquisition=acq,
        metadata=metadata,
        perception=perception,
        transcript=transcript,
        work_dir=work_dir,
        start_seconds=start_seconds,
        end_seconds=end_seconds,
    )
