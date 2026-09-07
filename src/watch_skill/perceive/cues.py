"""Interaction cues: the moments a recording was made in order to show.

A scripted capture knows something no frame sampler can work out afterwards.
When a script fills a quantity box and the page recomputes a total, the frames
either side of that edit are perceptually near-identical -- three numbers move
in a layout that is otherwise the same -- and near-duplicate selection drops
the one that carries the change. The capture layer knows exactly when it acted,
so it writes those moments down.

`watch-skill capture` and `watch-skill watch` are two invocations, and the
second is handed only a path. The moments travel between them in a sidecar
beside the recording: ``capture.webm`` -> ``capture.cues.json``.

Three things make a sidecar trustworthy enough to act on automatically, and
this module is where all three live so that every ingestion path gets them:

* **it is bound to the recording it describes.** A sidecar names the file's
  size and digest. A capture that overwrote the video and left the old sidecar
  behind is a mismatch, not a hint, and is refused.
* **its numbers are on the recording's own timeline.** The writer converts
  from its wall clock before storing them; see :func:`to_media_timeline`.
* **nothing in it is taken on trust.** Shape, types, finiteness, sign, bounds
  and size are all checked, because the file sits in a directory a user can
  write to.
"""
from __future__ import annotations

import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from watch_skill.errors import WatchSkillError
from watch_skill.identity import digest_file

#: The extension a recording's cues live under, beside the recording.
SIDECAR_SUFFIX = ".cues.json"

#: Bumped only for a change a previous reader could not understand.
SCHEMA_VERSION = 1

#: A sidecar is a short list of numbers. Anything larger is not one, and
#: reading it is a cost this pipeline should not pay to find that out.
MAX_SIDECAR_BYTES = 256 * 1024

#: Each cue is a pinned frame reserved against the frame budget. Past a few
#: hundred there is no budget left for anything the sampler would have chosen.
MAX_CUES = 512

#: A recording's duration is measured from its container and a cue is derived
#: from a clock; the last cue of a session lands within a frame or two of the
#: end. Inside this, a cue past the end is trimmed to the end rather than
#: refused; beyond it, the sidecar is describing a different recording.
BOUNDS_TOLERANCE_SECONDS = 0.5


class CueError(WatchSkillError):
    """A cue sidecar exists and cannot be believed."""

    default_code = "cues.invalid"


@dataclass(frozen=True)
class Cue:
    """One moment on a recording's own timeline, and what happened at it."""

    seconds: float
    label: str | None = None

    def to_json(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"seconds": round(self.seconds, 3)}
        if self.label:
            payload["label"] = self.label
        return payload


def sidecar_path_for(video_path: str | Path) -> Path:
    """Where the cues for ``video_path`` live."""
    return Path(video_path).with_suffix(SIDECAR_SUFFIX)


def clear_sidecar(video_path: str | Path) -> None:
    """Remove any cues left beside ``video_path`` by an earlier recording.

    Capture writes to a fixed name inside the output directory, so a second
    run overwrites the video. Without this, an unscripted re-record inherits
    the previous run's interaction moments: the file is bound by digest and
    would be refused, but a refusal a user has to read is a worse outcome than
    the stale file never existing.
    """
    sidecar_path_for(video_path).unlink(missing_ok=True)


def to_media_timeline(
    wall_seconds: list[float], *, wall_span: float, media_duration: float
) -> list[float]:
    """Move wall-clock moments onto the recording's own timeline.

    The two clocks share an origin -- the recording starts with the page that
    is being recorded -- but not a length. A screencast is a stream of frames
    the browser emits once it is ready to emit them, so the file that lands on
    disk is normally a little shorter than the session that produced it, and
    the missing part is at the front.

    So the correction is an offset and not a rate: everything is early by the
    same amount, the amount being whatever the recording turned out to be
    missing. A moment that lands before the start of the recording is clamped
    to it rather than dropped, because the alternative is losing the cue for
    the first interaction on a session that started slowly.

    The residual error is why the writer pins the middle of a state's visible
    window rather than the instant it appeared; see
    :func:`watch_skill.loop.capture.capture_url`.
    """
    # Length-preserving: the caller pairs the result with the labels it
    # collected, so a value that maps to nothing has to map to *something*.
    # A moment that is not a number is not one, and the start of the recording
    # is the least wrong place for a frame nobody can locate.
    if media_duration <= 0 or not math.isfinite(media_duration):
        return [
            round(max(0.0, value), 3) if math.isfinite(value) else 0.0
            for value in wall_seconds
        ]
    drift = max(0.0, wall_span - media_duration)
    return [
        round(min(max(value - drift, 0.0), media_duration), 3)
        if math.isfinite(value) else 0.0
        for value in wall_seconds
    ]


def write_sidecar(
    video_path: str | Path,
    cues: list[Cue],
    *,
    timeline: dict[str, float] | None = None,
) -> Path:
    """Write ``cues`` beside ``video_path``, bound to the recording's bytes."""
    video = Path(video_path)
    destination = sidecar_path_for(video)
    payload: dict[str, Any] = {
        "version": SCHEMA_VERSION,
        "recording": {
            "name": video.name,
            "bytes": video.stat().st_size,
            "sha256": digest_file(video),
        },
        "cues": [cue.to_json() for cue in cues],
    }
    if timeline is not None:
        payload["timeline"] = {k: round(v, 3) for k, v in timeline.items()}
    destination.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return destination


def _fail(message: str, *, code: str, fix: str, path: Path) -> CueError:
    return CueError(message, code=code, fix=fix, details={"sidecar": str(path)})


def _seconds_from(entry: Any, index: int, path: Path) -> float:
    """One cue's timestamp, or a refusal naming which cue was wrong."""
    value = entry.get("seconds") if isinstance(entry, dict) else entry
    # `bool` is an `int`, and `True` would otherwise pin a frame at one second.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _fail(
            f"cue {index} is not a number: {value!r}",
            code="cues.bad_timestamp",
            fix="each cue is a number of seconds, or an object with a numeric "
            '"seconds" field',
            path=path,
        )
    seconds = float(value)
    if not math.isfinite(seconds):
        raise _fail(
            f"cue {index} is {seconds}, which is not a moment in a recording",
            code="cues.bad_timestamp",
            fix="remove the cue, or re-record; NaN and Infinity are not times",
            path=path,
        )
    if seconds < 0:
        raise _fail(
            f"cue {index} is {seconds:g}s, before the recording starts",
            code="cues.bad_timestamp",
            fix="cue times are measured forward from the start of the recording",
            path=path,
        )
    return seconds


def _check_binding(payload: dict[str, Any], video: Path, path: Path) -> None:
    """Refuse a sidecar that describes some other recording.

    Capture writes to a fixed file name, so the second recording into an
    output directory replaces the first. A sidecar that survived that would
    pin frames from one session onto another and nothing downstream could
    tell -- the timestamps are in range and the frames come out fine, they
    are simply of the wrong moments.
    """
    recording = payload.get("recording")
    if recording is None:
        if "version" in payload:
            raise _fail(
                "the sidecar declares a version and names no recording",
                code="cues.unbound",
                fix="re-record with `watch-skill capture`, which writes the "
                "recording's size and digest, or delete the sidecar",
                path=path,
            )
        # A hand-written override. Nothing claims it came from a capture, so
        # there is no stale-file scenario to protect against.
        return
    if not isinstance(recording, dict):
        raise _fail(
            f'"recording" is {type(recording).__name__}, not an object',
            code="cues.bad_schema",
            fix="delete the sidecar and re-record with `watch-skill capture`",
            path=path,
        )
    size = video.stat().st_size
    if recording.get("bytes") != size:
        raise _fail(
            f"the sidecar describes a {recording.get('bytes')}-byte recording "
            f"and {video.name} is {size} bytes",
            code="cues.stale",
            fix=f"delete {path.name} — it belongs to an earlier recording that "
            "was overwritten; re-run the capture to regenerate it",
            path=path,
        )
    if recording.get("sha256") != digest_file(video):
        raise _fail(
            f"{video.name} is not the recording this sidecar was written for",
            code="cues.stale",
            fix=f"delete {path.name} — it belongs to a different recording; "
            "re-run the capture to regenerate it",
            path=path,
        )


def read_sidecar(
    video_path: str | Path, *, duration_seconds: float | None = None
) -> list[float] | None:
    """The cues recorded beside ``video_path``, or ``None`` if there are none.

    Raises :class:`CueError` when a sidecar is there and cannot be believed,
    so a caller can report it rather than silently watching the video as if
    the interactions had never been recorded.
    """
    video = Path(video_path)
    path = sidecar_path_for(video)
    if not path.is_file() or not video.is_file():
        return None

    size = path.stat().st_size
    if size > MAX_SIDECAR_BYTES:
        raise _fail(
            f"{path.name} is {size} bytes; a cue sidecar is a short list of numbers",
            code="cues.too_large",
            fix=f"delete {path.name}, or pass the moments you want with "
            "--timestamps",
            path=path,
        )
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError) as exc:
        raise _fail(
            f"{path.name} is not readable JSON: {exc}",
            code="cues.unreadable",
            fix=f"delete {path.name} and re-run the capture that wrote it",
            path=path,
        ) from exc

    # `[]` and `null` are the shapes a half-written file takes, and calling
    # `.get` on either raises an AttributeError nobody upstream expects.
    if not isinstance(payload, dict):
        raise _fail(
            f"{path.name} holds {type(payload).__name__}, not an object",
            code="cues.bad_schema",
            fix='a cue sidecar is `{"cues": [...]}`; delete this one and '
            "re-run the capture",
            path=path,
        )
    raw = payload.get("cues")
    if raw is None:
        return None
    if not isinstance(raw, list):
        raise _fail(
            f'"cues" is {type(raw).__name__}, not a list',
            code="cues.bad_schema",
            fix='"cues" is a list of seconds; delete the sidecar and re-run '
            "the capture",
            path=path,
        )
    if not raw:
        return None
    if len(raw) > MAX_CUES:
        raise _fail(
            f"{len(raw)} cues; every one is a frame reserved against the budget",
            code="cues.too_many",
            fix=f"keep at most {MAX_CUES}, or select the moments you want with "
            "--timestamps",
            path=path,
        )

    _check_binding(payload, video, path)

    seconds = [_seconds_from(entry, i, path) for i, entry in enumerate(raw)]
    if duration_seconds is not None and duration_seconds > 0:
        limit = duration_seconds + BOUNDS_TOLERANCE_SECONDS
        beyond = [value for value in seconds if value > limit]
        if beyond:
            raise _fail(
                f"cue at {beyond[0]:.3f}s is past the end of a "
                f"{duration_seconds:.3f}s recording",
                code="cues.out_of_bounds",
                fix=f"delete {path.name} — it does not describe this "
                "recording; re-run the capture to regenerate it",
                path=path,
            )
        seconds = [min(value, duration_seconds) for value in seconds]
    return seconds


def discover_cues(
    video_path: str | Path, duration_seconds: float | None = None
) -> list[float] | None:
    """Cues for ``video_path``, degrading loudly rather than raising.

    Discovery is something the pipeline does on the caller's behalf, so a
    broken sidecar must not fail a watch the caller did ask for. It does not
    pass silently either: the reason is printed with its code and its fix, the
    same way an unavailable OCR engine is.
    """
    try:
        return read_sidecar(video_path, duration_seconds=duration_seconds)
    except CueError as exc:
        print(f"[watch-skill] ignoring interaction cues — {exc}", file=sys.stderr)
        return None
