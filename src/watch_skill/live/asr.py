"""Streaming speech recognition over bounded utterances.

Two backends ship, and the difference between them is stated rather than
blurred:

``LocalWhisperASR``
    faster-whisper over short overlapping spans. This is real recognition and
    the only backend that produces real transcripts. It needs the optional
    model, so it cannot be a CI requirement.
``DeterministicASR``
    Returns text from a fixture manifest keyed by time. It exists to test the
    *transport* — chunking, ordering, timestamps, provisional-to-final
    promotion, cancellation — on machines without the model. It recognises
    nothing, and a test using it proves nothing about recognition quality.

The wrapping around whisper is a streaming adapter over bounded chunks, not a
claim that whisper is a streaming model. Whole-file transcription relabelled
as real-time would be the same dishonesty as batch processing called live.
"""
from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from watch_skill.errors import WatchSkillError
from watch_skill.live.audio import Utterance


@dataclass
class TranscriptPiece:
    """Recognised speech for one span, and whether it may still change."""

    text: str
    media_ts: float
    end_media_ts: float
    confidence: float = 0.0
    final: bool = True
    language: str | None = None
    backend: str = ""

    def to_public(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "media_ts": round(self.media_ts, 3),
            "end_media_ts": round(self.end_media_ts, 3),
            "confidence": round(self.confidence, 3),
            "final": self.final,
            "language": self.language,
            "backend": self.backend,
        }


class ASRBackend(Protocol):
    """Anything that can turn an utterance into text."""

    name: str

    def transcribe(self, utterance: Utterance) -> TranscriptPiece | None:
        ...

    def close(self) -> None:
        ...


class LocalWhisperASR:
    """faster-whisper, driven over short spans so it can be cancelled.

    The model is loaded through the lifecycle registry, so the first
    utterance waits rather than every thread loading its own copy, and a
    missing model degrades the session to visual-only instead of raising.
    """

    name = "faster-whisper"

    def __init__(self, model_size: str | None = None) -> None:
        self.model_size = model_size
        self._lock = threading.Lock()

    def _model(self) -> Any:
        from watch_skill.models import get_registry  # noqa: PLC0415

        registry = get_registry()
        if "asr" not in registry.registered():
            registry.register("asr", self._load, estimated_mb=500)
        return registry.load("asr")

    def _load(self) -> Any:
        from watch_skill.config import get_settings  # noqa: PLC0415

        settings = get_settings()
        if not settings.local_whisper_enabled:
            raise WatchSkillError(
                "local whisper is disabled",
                code="models.disabled",
                fix="set WATCHSKILL_LOCAL_WHISPER_ENABLED=1 to transcribe "
                "live audio locally",
            )
        try:
            from faster_whisper import WhisperModel  # noqa: PLC0415
        except ImportError as exc:
            raise WatchSkillError(
                "faster-whisper is not installed",
                code="models.missing_dependency",
                fix='install the transcribe extra: `uv sync --extra transcribe`',
            ) from exc

        size = self.model_size or self._auto_size()
        # Cache only. A live session must never be the thing that starts a
        # download — the same rule the vision worker follows, and for the same
        # reason: capture is already running, the network may be off by
        # policy, and a surprise fetch mid-session is both a stall and an
        # egress nobody consented to.
        #
        # This is not theoretical. Without `local_files_only` the loader
        # reached out to resolve the repo revision *even with the model
        # already cached*, and the offline test caught it connecting to
        # 443 on the way to transcribing a local wav.
        # Belt as well as braces. `local_files_only=True` is the loader's own
        # promise; `HF_HUB_OFFLINE` is the hub library's, and the offline test
        # caught a connection through `snapshot_download` that the first flag
        # alone did not stop. Restored afterwards so this stays a property of
        # the load rather than of the process.
        import os  # noqa: PLC0415

        previous = os.environ.get("HF_HUB_OFFLINE")
        os.environ["HF_HUB_OFFLINE"] = "1"
        try:
            return WhisperModel(size, device="auto", compute_type="int8",
                                local_files_only=True)
        except Exception as exc:  # noqa: BLE001 - reported, never a download
            raise WatchSkillError(
                f"the local speech model {size!r} is not in the cache",
                code="models.not_cached",
                fix="fetch it once, deliberately, before watching: "
                    f'`python -c "from faster_whisper import WhisperModel; '
                    f"WhisperModel('{size}')\"`. A live session will not "
                    "download it for you.",
                details={"model": size, "error": str(exc)[:200]},
            ) from exc
        finally:
            if previous is None:
                os.environ.pop("HF_HUB_OFFLINE", None)
            else:
                os.environ["HF_HUB_OFFLINE"] = previous

    @staticmethod
    def _auto_size() -> str:
        """Pick a model the machine can actually hold.

        Live transcription competes with OCR and embeddings for memory, so
        this is deliberately more conservative than the batch path: being a
        little less accurate beats being killed by the allocator mid-session.
        """
        from watch_skill.config import get_settings  # noqa: PLC0415

        configured = get_settings().whisper_model
        if configured and configured != "auto":
            return configured
        try:
            import psutil  # noqa: PLC0415

            available_gb = psutil.virtual_memory().available / 1024**3
        except Exception:  # noqa: BLE001
            return "tiny"
        if available_gb >= 8:
            return "small"
        return "base" if available_gb >= 4 else "tiny"

    def transcribe(self, utterance: Utterance) -> TranscriptPiece | None:
        import tempfile

        model = self._model()
        with tempfile.TemporaryDirectory(prefix="ws-asr-") as tmp:
            wav = utterance.write_wav(Path(tmp) / f"u{utterance.index}.wav")
            with self._lock:  # the model is not documented as thread-safe
                segments, info = model.transcribe(
                    str(wav), beam_size=1, vad_filter=True,
                    condition_on_previous_text=False,
                )
                pieces = list(segments)
        text = " ".join(segment.text.strip() for segment in pieces).strip()
        if not text:
            return None
        confidence = 0.0
        if pieces:
            average = sum(getattr(s, "avg_logprob", -1.0) for s in pieces) / len(pieces)
            confidence = max(0.0, min(1.0, 1.0 + average))
        return TranscriptPiece(
            text=text,
            media_ts=utterance.media_ts,
            end_media_ts=utterance.end_media_ts,
            confidence=confidence,
            language=getattr(info, "language", None),
            backend=self.name,
        )

    def close(self) -> None:
        from watch_skill.models import get_registry  # noqa: PLC0415

        registry = get_registry()
        if "asr" in registry.registered():
            registry.release("asr")


class DeterministicASR:
    """A fixture-driven backend for testing transport, not recognition.

    Reads a manifest of ``{"start": float, "end": float, "text": str}`` and
    returns whatever overlaps the utterance. Named so nobody mistakes its
    output for recognition: every piece it emits is labelled with this
    backend's name, and the docs say what that means.
    """

    name = "deterministic-fixture"

    def __init__(self, manifest: Path | list[dict[str, Any]]) -> None:
        if isinstance(manifest, Path):
            self.cues = json.loads(manifest.read_text(encoding="utf-8"))
        else:
            self.cues = list(manifest)

    def transcribe(self, utterance: Utterance) -> TranscriptPiece | None:
        start, end = utterance.media_ts, utterance.end_media_ts
        hits = [
            cue for cue in self.cues
            if float(cue["start"]) < end and float(cue["end"]) > start
        ]
        if not hits:
            return None
        return TranscriptPiece(
            text=" ".join(str(cue["text"]) for cue in hits),
            media_ts=start,
            end_media_ts=end,
            confidence=1.0,
            language="en",
            backend=self.name,
        )

    def close(self) -> None:
        return


def build_asr_backend(prefer: str | None = None) -> ASRBackend | None:
    """Choose an ASR backend, or None when live audio cannot be transcribed.

    Returning None is a supported outcome: audio still gets captured and its
    gaps still get reported, and the session degrades to visual-only with a
    reason rather than pretending nothing was said.
    """
    from watch_skill.config import get_settings  # noqa: PLC0415
    from watch_skill.policy import Channel, get_policy  # noqa: PLC0415

    if prefer == "deterministic":
        return None  # only ever constructed explicitly, never chosen by default

    if not get_settings().local_whisper_enabled:
        return None

    # Live ASR is local-only in this build, so the question is whether local
    # models are permitted — not whether audio may leave, because it never
    # does. Asking the policy anyway keeps the decision at the boundary: if a
    # cloud backend is added later, this is already the thing that decides,
    # rather than a comment claiming the path is local.
    if not get_policy().check(Channel.LOCAL_MODEL).allowed:
        return None
    return LocalWhisperASR()
