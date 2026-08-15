"""Generate a rights-cleared speech fixture with a known transcript.

An explicit setup step, never run automatically. Real-ASR accuracy cannot be
measured against audio nobody has a reference transcript for, and it cannot be
measured in a suite that must stay network-free — so the fixture is
*synthesized locally* from a script this repository owns.

Synthesized speech is not human speech, and the report says so: a word error
rate measured here describes how the model handles a clean synthetic voice,
which is an easier problem than a real recording. It is still a real
recognition measurement, and it is reproducible on any machine with a system
TTS voice.

    python scripts/make_speech_fixture.py --out tests/fixtures/speech

Produces `<name>.wav` (mono 16 kHz PCM) and `<name>.json` (the reference
transcript, verbatim).
"""
from __future__ import annotations

import argparse
import json
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# Short, unambiguous, and full of the vocabulary Watch Skill actually cares
# about: totals, error codes, UI words. Deliberately no proper nouns — a
# recogniser mangling a surname would say nothing about its usefulness here.
UTTERANCES: list[dict[str, object]] = [
    {"start": 0.0, "text": "the checkout total is not a number"},
    {"start": 4.0, "text": "the server returned error five zero two"},
    {"start": 8.0, "text": "the page is loading again now"},
]


def _synthesize_windows(text: str, out: Path) -> bool:
    script = (
        "Add-Type -AssemblyName System.Speech; "
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
        f"$s.SetOutputToWaveFile('{out}'); "
        f"$s.Speak('{text}'); $s.Dispose()"
    )
    result = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True, text=True, timeout=120,
    )
    return result.returncode == 0 and out.is_file() and out.stat().st_size > 1000


def _synthesize_macos(text: str, out: Path) -> bool:
    aiff = out.with_suffix(".aiff")
    result = subprocess.run(["say", "-o", str(aiff), text],
                            capture_output=True, timeout=120)
    if result.returncode != 0 or not aiff.is_file():
        return False
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        return False
    subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-i", str(aiff), str(out)],
                   check=True, timeout=120)
    aiff.unlink(missing_ok=True)
    return out.is_file()


def _synthesize_linux(text: str, out: Path) -> bool:
    espeak = shutil.which("espeak-ng") or shutil.which("espeak")
    if espeak is None:
        return False
    result = subprocess.run([espeak, "-w", str(out), text],
                            capture_output=True, timeout=120)
    return result.returncode == 0 and out.is_file()


def synthesize(text: str, out: Path) -> bool:
    """Speak `text` into `out` using whatever the platform provides."""
    system = platform.system()
    if system == "Windows":
        return _synthesize_windows(text, out)
    if system == "Darwin":
        return _synthesize_macos(text, out)
    return _synthesize_linux(text, out)


def build(out_dir: Path, name: str = "speech") -> dict[str, object]:
    """Produce the fixture; returns its manifest."""
    from watch_skill.health.binaries import require_binary

    ffmpeg = str(require_binary("ffmpeg"))
    out_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="ws-tts-") as tmp:
        tmp_dir = Path(tmp)
        parts: list[Path] = []
        for index, utterance in enumerate(UTTERANCES):
            raw = tmp_dir / f"part_{index}.wav"
            if not synthesize(str(utterance["text"]), raw):
                raise SystemExit(
                    "no system text-to-speech voice available; this fixture "
                    "needs SAPI (Windows), `say` (macOS), or espeak-ng (Linux)"
                )
            parts.append(raw)

        # Concatenated back to back. The manifest's `start` values are the
        # intended slots; the tests assert ordering and in-bounds timestamps
        # rather than exact offsets, because a TTS voice's pace is not ours to
        # control and asserting on it would measure the voice, not the
        # recogniser.
        listing = tmp_dir / "concat.txt"
        listing.write_text(
            "\n".join(f"file '{part.as_posix()}'" for part in parts) + "\n",
            encoding="utf-8",
        )

        wav = out_dir / f"{name}.wav"
        subprocess.run(
            [ffmpeg, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
             "-i", str(listing), "-ac", "1", "-ar", "16000",
             "-acodec", "pcm_s16le", str(wav)],
            check=True, timeout=300,
        )

    manifest = {
        "name": name,
        "audio": wav.name,
        "sample_rate": 16000,
        "channels": 1,
        "language": "en",
        "voice": f"system TTS ({platform.system()})",
        "note": "Synthesized locally. Rights-clear, but a clean synthetic "
                "voice is an easier recognition problem than real speech; "
                "any WER measured here must be reported as such.",
        "utterances": UTTERANCES,
        "reference_text": " ".join(str(u["text"]) for u in UTTERANCES),
    }
    (out_dir / f"{name}.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="make_speech_fixture")
    parser.add_argument("--out", default="tests/fixtures/speech",
                        help="Directory to write the fixture into.")
    parser.add_argument("--name", default="speech")
    args = parser.parse_args(argv)

    manifest = build(Path(args.out), args.name)
    print(json.dumps(manifest, indent=2))
    print(f"\nwrote {args.out}/{args.name}.wav and .json", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
