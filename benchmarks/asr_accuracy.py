"""Word error rate for the local ASR path, with its normalization stated.

WER is only meaningful alongside the normalization used to compute it. A
recogniser that writes "502" where the reference says "five zero two" is
correct, and scoring it wrong would make the number describe our formatting
conventions rather than the model. So the rules are written down here, applied
to both sides equally, and reported with the result.

Run directly for a one-off measurement:

    python benchmarks/asr_accuracy.py --audio fixture.wav --reference fixture.json
"""
from __future__ import annotations

import argparse
import json
import platform
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

_DIGIT_WORDS = {
    "0": "zero", "1": "one", "2": "two", "3": "three", "4": "four",
    "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine",
}
_PUNCT = re.compile(r"[^\w\s]", re.UNICODE)
_SPACES = re.compile(r"\s+")


def normalize(text: str) -> list[str]:
    """Lowercase, drop punctuation, and spell digits out digit by digit.

    Digits become words rather than the reverse because the mapping is
    unambiguous in that direction: "502" is unarguably "five zero two", while
    turning "five zero two" back into a number requires guessing whether it
    meant 502 or 5 0 2.
    """
    text = _PUNCT.sub(" ", text.lower())
    out: list[str] = []
    for token in _SPACES.split(text.strip()):
        if not token:
            continue
        # `str.isdigit()` accepts more than 0-9 — "①", "٣" and "²" all pass it
        # — while the table above only holds ASCII. Without the ascii guard a
        # transcript containing any of them raises KeyError mid-scoring, which
        # is how it was found: on OCR text lifted off a real slide.
        if token.isascii() and token.isdigit():
            out.extend(_DIGIT_WORDS[d] for d in token)
        else:
            out.append(token)
    return out


def edit_distance(reference: list[str], hypothesis: list[str]) -> dict[str, int]:
    """Levenshtein over words, with the operation counts kept apart.

    Substitutions, insertions and deletions are reported separately because
    they mean different things: a model that drops words is failing in a very
    different way from one that invents them.
    """
    rows, cols = len(reference) + 1, len(hypothesis) + 1
    dist = [[0] * cols for _ in range(rows)]
    back = [[""] * cols for _ in range(rows)]
    for i in range(rows):
        dist[i][0] = i
        back[i][0] = "D"
    for j in range(cols):
        dist[0][j] = j
        back[0][j] = "I"
    back[0][0] = ""

    for i in range(1, rows):
        for j in range(1, cols):
            if reference[i - 1] == hypothesis[j - 1]:
                dist[i][j], back[i][j] = dist[i - 1][j - 1], "="
                continue
            options = (
                (dist[i - 1][j - 1] + 1, "S"),
                (dist[i][j - 1] + 1, "I"),
                (dist[i - 1][j] + 1, "D"),
            )
            dist[i][j], back[i][j] = min(options)

    counts = {"substitutions": 0, "insertions": 0, "deletions": 0, "hits": 0}
    i, j = len(reference), len(hypothesis)
    while i > 0 or j > 0:
        op = back[i][j]
        if op == "=":
            counts["hits"] += 1
            i, j = i - 1, j - 1
        elif op == "S":
            counts["substitutions"] += 1
            i, j = i - 1, j - 1
        elif op == "I":
            counts["insertions"] += 1
            j -= 1
        else:
            counts["deletions"] += 1
            i -= 1
    return counts


@dataclass
class AccuracyResult:
    """One measured recognition run, with everything needed to reproduce it."""

    wer: float
    counts: dict[str, int]
    reference_words: int
    hypothesis: str
    reference: str
    model: str = ""
    language: str = ""
    load_seconds: float = 0.0
    transcribe_seconds: float = 0.0
    audio_seconds: float = 0.0
    hardware: dict[str, Any] = field(default_factory=dict)

    @property
    def realtime_factor(self) -> float:
        """Seconds of compute per second of audio. Below 1.0 keeps up live."""
        if not self.audio_seconds:
            return 0.0
        return round(self.transcribe_seconds / self.audio_seconds, 3)

    def to_dict(self) -> dict[str, Any]:
        return {
            "wer": round(self.wer, 4),
            "counts": self.counts,
            "reference_words": self.reference_words,
            "model": self.model,
            "language": self.language,
            "load_seconds": round(self.load_seconds, 2),
            "transcribe_seconds": round(self.transcribe_seconds, 2),
            "audio_seconds": round(self.audio_seconds, 2),
            "realtime_factor": self.realtime_factor,
            "hardware": self.hardware,
            "normalization": "lowercase; punctuation stripped; digits spelled "
                             "out digit-by-digit; applied to both sides",
            "reference": self.reference,
            "hypothesis": self.hypothesis,
        }


def hardware_snapshot() -> dict[str, Any]:
    """What the numbers were measured on. A benchmark without it is a rumour."""
    info: dict[str, Any] = {
        "system": platform.system(),
        "release": platform.release(),
        "machine": platform.machine(),
        "processor": platform.processor() or "unknown",
        "python": platform.python_version(),
    }
    try:
        import psutil  # noqa: PLC0415

        info["cpu_count"] = psutil.cpu_count(logical=True)
        info["ram_gb"] = round(psutil.virtual_memory().total / 1024**3, 1)
    except Exception:  # noqa: BLE001
        pass
    return info


def score(reference: str, hypothesis: str) -> tuple[float, dict[str, int], int]:
    ref_words = normalize(reference)
    hyp_words = normalize(hypothesis)
    counts = edit_distance(ref_words, hyp_words)
    errors = counts["substitutions"] + counts["insertions"] + counts["deletions"]
    wer = errors / len(ref_words) if ref_words else 0.0
    return wer, counts, len(ref_words)


def measure(
    audio: Path, reference_text: str, model_size: str = "tiny"
) -> AccuracyResult:
    """Transcribe with the real local model and score it."""
    import wave

    from faster_whisper import WhisperModel  # noqa: PLC0415

    with wave.open(str(audio)) as handle:
        audio_seconds = handle.getnframes() / float(handle.getframerate())

    started = time.monotonic()
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    load_seconds = time.monotonic() - started

    started = time.monotonic()
    segments, info = model.transcribe(str(audio), beam_size=1, vad_filter=False,
                                      word_timestamps=True)
    segments = list(segments)
    transcribe_seconds = time.monotonic() - started

    hypothesis = " ".join(segment.text.strip() for segment in segments).strip()
    wer, counts, ref_words = score(reference_text, hypothesis)
    return AccuracyResult(
        wer=wer, counts=counts, reference_words=ref_words,
        hypothesis=hypothesis, reference=reference_text,
        model=f"faster-whisper {model_size} (int8, cpu)",
        language=getattr(info, "language", "") or "",
        load_seconds=load_seconds, transcribe_seconds=transcribe_seconds,
        audio_seconds=audio_seconds, hardware=hardware_snapshot(),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="asr_accuracy")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--reference", required=True,
                        help="Fixture manifest JSON with `reference_text`.")
    parser.add_argument("--model", default="tiny")
    args = parser.parse_args(argv)

    manifest = json.loads(Path(args.reference).read_text(encoding="utf-8"))
    result = measure(Path(args.audio), manifest["reference_text"], args.model)
    print(json.dumps(result.to_dict(), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
