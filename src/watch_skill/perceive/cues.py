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
import tempfile
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


#: How finely the recording is sampled when looking for its first change.
ALIGN_STEP_SECONDS = 0.08

#: How far into a recording that search goes before giving up.
ALIGN_SEARCH_SECONDS = 6.0

#: Past this, an "alignment" is a coincidence rather than a measurement.
ALIGN_LIMIT_SECONDS = 3.0

#: How much a pixel has to move to count as having changed, out of 255, and
#: what share of the frame has to move before the frame has.
#:
#: Pixels rather than a perceptual hash, and the reason is the same one cues
#: exist for: a phash is built to ignore what matters here. Three numbers
#: changing on a checkout page hash four apart against a near-duplicate
#: threshold of six -- and a black frame and a white frame hash *one* apart,
#: because a DCT hash normalises brightness away entirely.
ALIGN_PIXEL_DELTA = 24
ALIGN_CHANGED_SHARE = 0.0004


def to_media_timeline(
    wall_seconds: list[float], *, offset: float, media_duration: float
) -> list[float]:
    """Move wall-clock moments onto the recording's own timeline.

    The two clocks run at the same rate and start at different moments, and
    the difference cannot be worked out from their lengths -- which is the
    trap, because it looks as though it can. Measured on a local page: a
    1.609 s session produced a 2.600 s recording, which reads like a file with
    a second to spare at the end and no gap at the front. It had both. The
    trailing second is a flush of held frames; the front was missing 0.28 s,
    and every moment in that recording sat 0.28 s later in content than the
    clock said.

    So the offset is measured against the recording rather than inferred from
    it -- see :func:`measure_offset` -- and applied here. A moment that lands
    outside the recording is clamped rather than dropped, because the caller
    pairs this list with the labels it collected and the two have to stay the
    same length.
    """
    if media_duration <= 0 or not math.isfinite(media_duration):
        return [
            round(max(0.0, value), 3) if math.isfinite(value) else 0.0
            for value in wall_seconds
        ]
    shift = offset if math.isfinite(offset) else 0.0
    return [
        round(min(max(value + shift, 0.0), media_duration), 3)
        if math.isfinite(value) else 0.0
        for value in wall_seconds
    ]


def measure_offset(
    video_path: Path,
    *,
    changed_at: float,
    media_duration: float,
    search_seconds: float = ALIGN_SEARCH_SECONDS,
) -> float | None:
    """Where the capture's clock sits relative to the recording's own.

    Both clocks saw one event: the first time the page changed. The capture
    noticed it by polling and wrote down when; the recording contains it, and
    this finds where. The difference is the offset, and it is a measurement
    rather than an assumption about how a browser starts a screencast.

    ``changed_at`` is when the capture *observed* the change, so it is late by
    up to one poll interval; the search below is late by up to one sample. Both
    are corrected to the middle of their own interval, which leaves a residual
    of about a twentieth of a second in each direction -- comfortably inside
    the window a cue is pinned in.

    Returns ``None`` when there is nothing to align to: a recording that never
    changes, a search that runs out, or a result too large to be a measurement
    of anything.
    """
    from watch_skill.perceive import media  # noqa: PLC0415 — heavy

    if media_duration <= 0 or not math.isfinite(changed_at):
        return None
    # Only the neighbourhood the answer can be in. A recording also changes
    # when it starts -- the first paint moves most of the frame -- and that
    # transition is not the one both clocks saw.
    low = max(0.0, changed_at - ALIGN_LIMIT_SECONDS)
    high = min(media_duration, changed_at + ALIGN_LIMIT_SECONDS,
               low + search_seconds)
    if high <= low:
        return None

    nearest: float | None = None
    with tempfile.TemporaryDirectory(prefix="watch-skill-align-") as room:
        out = Path(room)
        previous: bytes | None = None
        at = low
        index = 0
        while at <= high:
            index += 1
            # PNG, not JPEG: two identical frames re-encoded lossily differ by
            # more than a page's worth of digits do, which puts the noise floor
            # above the signal. Decoded losslessly, two identical frames are
            # identical and the floor is zero.
            frame = media.extract_frame_at(
                video_path, at, out / f"s{index:04d}.png", width=320)
            if frame is None:
                break
            sample = _pixels(frame)
            if sample is None:
                return None
            if previous is not None and _differ(previous, sample):
                # Both clocks are late by half of their own interval.
                seen_at = at - ALIGN_STEP_SECONDS / 2
                if nearest is None or abs(seen_at - changed_at) < abs(
                    nearest - changed_at
                ):
                    nearest = seen_at
            previous = sample
            at += ALIGN_STEP_SECONDS

    if nearest is None:
        return None
    offset = nearest - changed_at
    return offset if abs(offset) <= ALIGN_LIMIT_SECONDS else None


def _pixels(image_path: Path) -> bytes | None:
    """One frame as greyscale levels, or None if Pillow is not installed."""
    try:
        from PIL import Image  # noqa: PLC0415
    except ImportError:
        return None
    with Image.open(image_path) as img:
        return img.convert("L").tobytes()


def _differ(previous: bytes, sample: bytes) -> bool:
    """Whether enough of the frame moved to be a change rather than nothing.

    Measured on a checkout recording: identical frames move 0.000 of the
    pixels, the quantity edit that rewrites three amounts moves 0.002, and the
    page's first paint moves 0.016. The floor is genuinely zero, so the
    threshold sits an order of magnitude below the smallest real signal rather
    than being tuned against noise.
    """
    if len(previous) != len(sample):
        return True
    moved = sum(
        1 for a, b in zip(previous, sample, strict=True)
        if abs(a - b) > ALIGN_PIXEL_DELTA
    )
    return moved / len(previous) > ALIGN_CHANGED_SHARE


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
