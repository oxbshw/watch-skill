"""Scoring a backend against real footage, where no ground truth was authored.

The generated fixtures work because we drew them: every frame's identity was
decided before it was encoded. A real video offers nothing of the sort — no
event ids, no flat colour bands, no cut times we chose. Measuring against one
therefore needs a different instrument, and the temptation is to fall back on
"the timestamp looks about right", which measures nothing.

So ground truth is derived from the media instead of asserted about it. For
each probe the window of frames around it is decoded **by presentation time**,
straight from the file, and the frame the provider returned is located inside
that window. What comes out is not "is this the right picture" — nobody knows
what the right picture is — but the far more useful:

    which frame of this file did the provider actually hand back,
    and how far is that frame from the time we asked for?

Two properties make the answer trustworthy.

**Exact localization when it is available.** The reference frames are decoded
with the same JPEG settings the provider's extractor uses, so the right frame
usually comes back byte-identical and the match is certain rather than
inferred.

**Declared ambiguity when it is not.** A static shot has many frames that are
indistinguishable, and no comparison can separate them. Those probes report an
interval and an explicit ``ambiguous`` flag; they are never resolved by
picking the nearest and hoping.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

# The window decoded around each probe. Wide enough to contain the frame a
# reasonable extractor could return (a few frames either side, plus room for a
# seek that lands on a keyframe), narrow enough that decoding it is cheap.
WINDOW_SECONDS = 0.15

# Comparison happens on a 480 px-wide greyscale reduction. Full resolution
# would be slower for no gain: two genuinely different frames of real footage
# differ enormously at that scale, and two frames that do not differ at that
# scale are a static shot, which is ambiguous at any resolution.
COMPARE_WIDTH = 480

# Mean absolute difference, 0-255. Below this two frames are called
# indistinguishable rather than ranked — encoder noise between adjacent frames
# of a still shot lands around 1.
INDISTINGUISHABLE_MAE = 1.5


def _binary(name: str) -> str:
    found = shutil.which(name)
    if found is None:
        raise RuntimeError(f"{name} is not on PATH")
    return found


def _run(command: list[str], timeout: int = 600) -> subprocess.CompletedProcess:
    return subprocess.run(
        command, capture_output=True, timeout=timeout, check=True,
        stdin=subprocess.DEVNULL,
    )


def digest_file(path: Path, algorithm: str = "sha256") -> str:
    digest = hashlib.new(algorithm)
    with path.open("rb") as handle:
        while chunk := handle.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def describe_media(path: Path) -> dict[str, Any]:
    """What the file is, read from the file rather than from the source page."""
    result = _run([
        _binary("ffprobe"), "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", str(path),
    ])
    data = json.loads(result.stdout)
    video = next((s for s in data["streams"] if s.get("codec_type") == "video"), {})
    audio = next((s for s in data["streams"] if s.get("codec_type") == "audio"), None)

    def rate(value: str | None) -> float | None:
        if not value or "/" not in value:
            return None
        num, den = value.split("/")
        return round(int(num) / int(den), 6) if int(den) else None

    average = rate(video.get("avg_frame_rate"))
    nominal = rate(video.get("r_frame_rate"))
    return {
        "duration_seconds": round(float(data["format"]["duration"]), 3),
        "width": video.get("width"),
        "height": video.get("height"),
        "video_codec": video.get("codec_name"),
        "avg_frame_rate": average,
        "r_frame_rate": nominal,
        # Real footage is not guaranteed constant-rate, and a benchmark that
        # assumed a fixed frame grid would silently mismeasure it.
        "variable_frame_rate": (
            average is not None and nominal is not None
            and abs(average - nominal) > 0.01
        ),
        "has_audio": audio is not None,
        "audio_codec": audio.get("codec_name") if audio else None,
        "size_bytes": int(data["format"]["size"]),
        "sha256": digest_file(path),
        "md5": digest_file(path, "md5"),
    }


@dataclass
class FrameRef:
    """One reference frame decoded straight out of the file."""

    position: int
    pts: float
    path: Path
    sha256: str

    def to_dict(self) -> dict[str, Any]:
        return {"position": self.position, "pts": self.pts, "sha256": self.sha256}


def frame_times(video: Path, start: float, end: float) -> list[float]:
    """Presentation time of every frame in ``[start, end]``, from the file.

    Only a fallback now — :func:`decode_window` reads the times out of the
    decode it is already doing. Kept because a disagreement between the two is
    worth being able to check.

    The interval end is **absolute**, not a duration. A duration is measured
    from wherever the seek actually landed, which is the keyframe at or before
    the requested point; on a long-GOP codec that keyframe can be seconds
    early, and the window then ends before the frames anyone wanted. That bug
    silently returned an empty list two hundred seconds into an AV1 file.
    """
    result = _run([
        _binary("ffprobe"), "-v", "error", "-select_streams", "v",
        "-read_intervals", f"{max(0.0, start - 2.0):.3f}%{end + 0.5:.3f}",
        "-show_entries", "frame=best_effort_timestamp_time,pts_time",
        "-print_format", "json", str(video),
    ])
    times: list[float] = []
    for frame in json.loads(result.stdout).get("frames", []):
        raw = frame.get("best_effort_timestamp_time") or frame.get("pts_time")
        try:
            value = float(raw)
        except (TypeError, ValueError):
            continue
        if start <= value <= end:
            times.append(round(value, 6))
    return sorted(times)


_SHOWINFO_PTS = re.compile(r"pts_time:\s*([0-9]+(?:\.[0-9]+)?)")


def _showinfo_times(stderr: bytes) -> list[float]:
    """Presentation times reported by the `showinfo` filter, in output order.

    Read from the decode that is already happening rather than from a second
    pass. Beyond halving the cost on a slow codec, it removes the possibility
    of the frames and the times being paired up wrongly: showinfo reports
    exactly the frames that reached the encoder, in the order they reached it.
    """
    text = stderr.decode("utf-8", errors="replace")
    return [
        round(float(match), 6)
        for match in _SHOWINFO_PTS.findall(text)
    ]


def decode_window(
    video: Path, start: float, end: float, out_dir: Path, *, tag: str
) -> list[FrameRef]:
    """Decode every frame in ``[start, end]`` with its true presentation time.

    Frames are selected by time and written in presentation order, with the
    same ``-q:v 2`` the provider's extractor uses — which is what lets the
    match below come out byte-exact rather than merely close.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    pattern = out_dir / f"{tag}_%04d.jpg"
    # Seek to just before the window rather than filtering from the start of
    # the file. Without this, a probe at 12 minutes decodes twelve minutes of
    # video to look at a fraction of a second, and the run takes hours.
    # `-copyts` keeps the timeline absolute so `between(t, …)` still refers to
    # real presentation times; the lead gives the decoder a keyframe to start
    # from.
    lead = max(0.0, start - 2.0)
    result = _run([
        _binary("ffmpeg"), "-y", "-hide_banner", "-loglevel", "info",
        "-copyts", "-ss", f"{lead:.6f}",
        "-i", str(video),
        "-vf", f"select='between(t,{start:.6f},{end:.6f})',showinfo",
        "-vsync", "0", "-q:v", "2",
        str(pattern),
    ])
    decoded = sorted(out_dir.glob(f"{tag}_*.jpg"))
    times = _showinfo_times(result.stderr)
    if len(times) != len(decoded):
        # showinfo and the encoder disagreeing is unexpected; fall back to a
        # separate probe pass rather than pairing frames with the wrong times.
        times = frame_times(video, start, end)
    if len(times) != len(decoded):
        # Do not pair them up regardless: a mismatch means the times cannot be
        # trusted, and a wrong PTS would corrupt every number downstream.
        return [
            FrameRef(position=index, pts=float("nan"), path=path,
                     sha256=digest_file(path))
            for index, path in enumerate(decoded)
        ]
    return [
        FrameRef(position=index, pts=pts, path=path, sha256=digest_file(path))
        for index, (pts, path) in enumerate(zip(times, decoded, strict=True))
    ]


def _greyscale(path: Path):
    import numpy as np
    from PIL import Image

    with Image.open(path) as handle:
        image = handle.convert("L")
        height = max(1, round(image.height * COMPARE_WIDTH / image.width))
        image = image.resize((COMPARE_WIDTH, height))
        return np.asarray(image, dtype=np.float32)


def mean_absolute_difference(a: Path, b: Path) -> float:
    """Per-pixel MAE on a greyscale reduction, 0-255."""
    import numpy as np

    left, right = _greyscale(a), _greyscale(b)
    if left.shape != right.shape:
        return float("inf")
    return float(np.abs(left - right).mean())


@dataclass
class Localization:
    """Where in the file the returned frame actually came from."""

    probe: float
    matched: bool
    exact_byte_match: bool
    best_pts: float | None
    best_distance: float | None
    candidate_count: int
    pts_low: float | None
    pts_high: float | None
    ambiguous: bool
    window_frames: int
    signed_error_lo: float | None = None
    signed_error_hi: float | None = None
    note: str = ""
    neighbour_separation: float | None = None

    @property
    def signed_estimate(self) -> float | None:
        if self.signed_error_lo is None or self.signed_error_hi is None:
            return None
        return round((self.signed_error_lo + self.signed_error_hi) / 2, 6)

    @property
    def uncertainty(self) -> float | None:
        if self.signed_error_lo is None or self.signed_error_hi is None:
            return None
        return round((self.signed_error_hi - self.signed_error_lo) / 2, 6)

    @property
    def abs_lower_bound(self) -> float | None:
        if self.signed_error_lo is None or self.signed_error_hi is None:
            return None
        if self.signed_error_lo <= 0 <= self.signed_error_hi:
            return 0.0
        return round(min(abs(self.signed_error_lo), abs(self.signed_error_hi)), 6)

    @property
    def abs_upper_bound(self) -> float | None:
        if self.signed_error_lo is None or self.signed_error_hi is None:
            return None
        return round(max(abs(self.signed_error_lo), abs(self.signed_error_hi)), 6)

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["signed_estimate"] = self.signed_estimate
        data["uncertainty"] = self.uncertainty
        data["abs_lower_bound"] = self.abs_lower_bound
        data["abs_upper_bound"] = self.abs_upper_bound
        return data


def localize(
    returned: Path, window: list[FrameRef], probe: float
) -> Localization:
    """Find which frame of the window the provider returned.

    Byte equality first, because it is certain. Only when no reference frame
    is byte-identical does this fall back to comparing pixels, and then any
    reference within :data:`INDISTINGUISHABLE_MAE` of the best is kept as a
    candidate rather than discarded — a still shot must widen the answer, not
    be forced into a single frame.
    """
    if not window:
        return Localization(
            probe=probe, matched=False, exact_byte_match=False, best_pts=None,
            best_distance=None, candidate_count=0, pts_low=None, pts_high=None,
            ambiguous=False, window_frames=0,
            note="no reference frames decoded for this window",
        )

    usable = [ref for ref in window if ref.pts == ref.pts]  # drop NaN pts
    if len(usable) != len(window):
        return Localization(
            probe=probe, matched=False, exact_byte_match=False, best_pts=None,
            best_distance=None, candidate_count=0, pts_low=None, pts_high=None,
            ambiguous=True, window_frames=len(window),
            note="frame count and timestamp count disagreed; times untrustworthy",
        )

    digest = digest_file(returned)
    exact = [ref for ref in usable if ref.sha256 == digest]
    if len(exact) == 1:
        pts = exact[0].pts
        return _with_error(Localization(
            probe=probe, matched=True, exact_byte_match=True, best_pts=pts,
            best_distance=0.0, candidate_count=1, pts_low=pts, pts_high=pts,
            ambiguous=False, window_frames=len(usable),
            note="byte-identical to exactly one decoded frame",
        ))

    distances = [(mean_absolute_difference(returned, ref.path), ref) for ref in usable]
    distances.sort(key=lambda pair: pair[0])
    best_distance, best = distances[0]
    if best_distance == float("inf"):
        return Localization(
            probe=probe, matched=False, exact_byte_match=False, best_pts=None,
            best_distance=None, candidate_count=0, pts_low=None, pts_high=None,
            ambiguous=True, window_frames=len(usable),
            note="returned frame has a different geometry than the source",
        )

    candidates = [
        ref for distance, ref in distances
        if distance - best_distance <= INDISTINGUISHABLE_MAE
    ]
    separation = (
        round(distances[1][0] - best_distance, 4) if len(distances) > 1 else None
    )
    times = sorted(ref.pts for ref in candidates)
    if len(exact) > 1:
        note = "several decoded frames are byte-identical — a still shot"
    elif len(candidates) > 1:
        note = (
            f"{len(candidates)} frames indistinguishable within "
            f"{INDISTINGUISHABLE_MAE} MAE — a still or near-still shot"
        )
    else:
        note = "localized by pixel comparison"

    return _with_error(Localization(
        probe=probe, matched=True, exact_byte_match=False,
        best_pts=best.pts, best_distance=round(best_distance, 4),
        candidate_count=len(candidates), pts_low=times[0], pts_high=times[-1],
        ambiguous=len(candidates) > 1, window_frames=len(usable),
        note=note, neighbour_separation=separation,
    ))


def _with_error(localization: Localization) -> Localization:
    if localization.pts_low is None or localization.pts_high is None:
        return localization
    localization.signed_error_lo = round(localization.pts_low - localization.probe, 6)
    localization.signed_error_hi = round(localization.pts_high - localization.probe, 6)
    return localization


def build_probes(media: dict[str, Any], count: int = 30) -> list[float]:
    """Probe times spread over the file, half on the frame grid and half off.

    The split is the point. A request that lands exactly on a frame boundary
    and one that lands between two frames are different questions, and a probe
    set made only of round numbers answers just the easy one.

    Every value is rounded to a whole millisecond, because that is all the
    interface can carry: 0.1.4 names each returned file after
    ``round(seconds * 1000)``, so a request of 25.291666 s comes back as
    ``25292ms`` and there is no way to ask for anything finer. Rounding here
    rather than letting the round-trip do it keeps the time we compare against
    identical to the time we actually asked for — otherwise every measurement
    on a 60 fps source carries up to half a millisecond of our own error.

    A consequence worth naming: at 60 fps the frame grid is 16.667 ms, which
    whole milliseconds cannot express exactly. "On-grid" probes there are
    on-grid to the nearest millisecond, and the report should not claim more.
    """
    duration = float(media["duration_seconds"])
    fps = media.get("avg_frame_rate") or media.get("r_frame_rate") or 25.0
    period = 1.0 / fps

    def milli(value: float) -> float:
        return round(round(value * 1000) / 1000, 3)

    def on_grid(value: float) -> float:
        return milli(round(value / period) * period)

    usable = max(0.0, duration - 1.0)
    spread = max(3, count // 2)
    probes: list[float] = []
    for index in range(spread):
        base = usable * (index + 0.5) / spread
        aligned = on_grid(base)
        probes.append(aligned)
        # Half a frame later: off the grid by construction, which is where a
        # ceiling-rounding extractor becomes visible.
        probes.append(milli(aligned + period / 2))

    probes += [
        on_grid(period),                       # the second frame
        milli(period / 2),                     # inside the first frame
        on_grid(duration - 2 * period),        # near the end
        milli(on_grid(duration - 2 * period) + period / 2),
    ]
    return sorted({p for p in probes if 0.0 <= p < duration})


@dataclass
class RealMediaResult:
    """One real video, measured. No frames or media are kept."""

    label: str
    source: str
    source_kind: str
    media: dict[str, Any] = field(default_factory=dict)
    probes: list[float] = field(default_factory=list)
    status: str = ""
    frames_returned: int = 0
    wall_seconds: float = 0.0
    localizations: list[dict[str, Any]] = field(default_factory=list)
    summary: dict[str, Any] = field(default_factory=dict)
    detail: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
