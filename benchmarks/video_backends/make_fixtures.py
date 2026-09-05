"""Render the deterministic video-backend fixtures + their proven ground truth.

An external video backend is only worth measuring against a source whose
truth we can state to the millisecond. These fixtures are generated, never
recorded: every cut lands on an exact frame boundary, every visual event
carries an identity that survives JPEG and rescaling, and every spoken cue
sits at an offset this script chose rather than one a human transcribed.

    uv run --no-sync python benchmarks/video_backends/make_fixtures.py

Two fixtures come out of it:

``visual_events.mp4``
    Hard cuts at known times, unique per-event colour identity, a rapid
    four-cut burst, a near-duplicate pair, a 200 ms event, one card that
    reappears fifteen seconds later, events pinned to both boundaries, and a
    **frame ladder**: twenty-five consecutive frames, each its own colour, so
    a frame taken from that half-second is identified to a single frame and
    its true time is known to 20 ms rather than to an interval.

``speech_events.mp4``
    Locally synthesized speech with exactly known cue intervals — silence
    first, one closely spaced pair, and a video track whose cards change in
    lockstep with the utterances so visual and spoken evidence can be
    checked against each other.

The MP4s are **not committed**. They are a few hundred kilobytes each and
regenerate from this script in about ten seconds on any machine with ffmpeg
(plus a system TTS voice for the speech fixture), which is cheaper than
carrying media in the tree. ``manifest.json`` *is* committed: it is the ground
truth, and it records the digests of the media it was proven against so a
stale fixture cannot be scored as a fresh one.

What regenerates identically is the **content**: every cut lands on the same
frame, every event keeps its colour identity, every cue keeps its interval,
because this script chose all of them. The **bytes** do not. Encoding the same
frames with a different ffmpeg produces a different file -- ffmpeg 9 wrote
visual_events.mp4 fifteen bytes larger than the build the committed manifest
records, with a different digest and the same ground truth. So treat a digest
mismatch as "regenerated here" rather than "corrupt", and re-record the
manifest only alongside the measurements it is the truth for: the digests
exist to stop a stale fixture being scored as a fresh one, not to assert that
two machines encode alike.

Ground truth here is verified, not asserted. Before the manifest is
written, every occurrence is sampled back out of the encoded video and its
colour identity checked against what this script intended. A mismatch is a
hard failure — a benchmark whose ground truth was never checked measures
nothing.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import platform
import shutil
import subprocess
import sys
import tempfile
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures"

MANIFEST_SCHEMA = "watch-skill/video-backend-fixtures/1"

# 50 fps: a 20 ms frame period, so every cut time below is an exact multiple
# of the frame interval and no ground-truth timestamp is a rounded decimal.
# At 30 fps a cut at 5.50 s would fall between frames and the "known" time
# would already be a half-frame lie.
FPS = 50
FRAME_MS = 1000 // FPS  # 20

WIDTH, HEIGHT = 640, 360

# The flat band each event's identity is read from: the top strip of the card,
# which carries no text. Sampled as a mean over ~50k pixels, so encoder noise
# averages away and a solid colour survives H.264 and a JPEG re-encode intact.
SAMPLE_TOP = 0.03
SAMPLE_BOTTOM = 0.13
SAMPLE_LEFT = 0.05
SAMPLE_RIGHT = 0.95


@dataclass(frozen=True)
class Event:
    """One visually distinct card. Identity, not position in time."""

    event_id: str
    label: str
    color: tuple[int, int, int]
    note: str = ""


@dataclass(frozen=True)
class Occurrence:
    """One appearance of an event on the timeline."""

    occurrence_id: str
    event_id: str
    start: float
    end: float
    properties: list[str] = field(default_factory=list)

    @property
    def midpoint(self) -> float:
        return round((self.start + self.end) / 2, 3)


# The frame ladder: twenty-five consecutive single-frame events. Colours come
# off a coarse lattice, so the closest pair is 60 apart in one channel and a
# decoded frame can be attributed to exactly one rung. This is the only part
# of the fixture where a returned frame's true time is known to a single frame
# period; everywhere else identity resolves to an interval, and the scorer
# reports a bound rather than pretending otherwise.
LADDER_LENGTH = 25
LADDER_START = 15.00


def _ladder_colors(count: int) -> list[tuple[int, int, int]]:
    lattice = [
        (r, g, b)
        for r in (40, 100, 160, 220)
        for g in (40, 120, 200)
        for b in (40, 140, 240)
    ]
    if count > len(lattice):
        raise SystemExit(f"ladder of {count} needs more lattice points than exist")
    return lattice[:count]


LADDER_EVENTS: list[Event] = [
    Event(f"LADDER_{i:02d}", f"LADDER_{i:02d}", color, f"frame ladder rung {i}")
    for i, color in enumerate(_ladder_colors(LADDER_LENGTH))
]

# Colours are hand-picked, not generated: every pair is far apart in RGB so
# nearest-colour classification is unambiguous, *except* the NEAR pair, which
# is 12 apart on purpose. Twelve clears the two-to-three level drift that
# limited-range yuv420p storage costs a flat card, yet is invisible to a human
# and to any perceptual hash with a sane threshold — which is exactly the
# frame a deduplicating pipeline is most likely to collapse.
EVENTS: list[Event] = [
    Event("EVENT_START", "EVENT_START", (218, 32, 32), "pinned to the first frame"),
    Event("EVENT_001", "EVENT_001", (32, 96, 218), "reappears late in the video"),
    Event("EVENT_002", "EVENT_002", (32, 176, 96), ""),
    Event("EVENT_SHORT", "EVENT_SHORT", (240, 196, 32), "200 ms — 10 frames"),
    Event("EVENT_003", "EVENT_003", (144, 48, 200), ""),
    Event("EVENT_R1", "EVENT_R1", (16, 168, 200), "rapid burst 1/4"),
    Event("EVENT_R2", "EVENT_R2", (232, 112, 24), "rapid burst 2/4"),
    Event("EVENT_R3", "EVENT_R3", (96, 208, 48), "rapid burst 3/4"),
    Event("EVENT_R4", "EVENT_R4", (208, 40, 144), "rapid burst 4/4"),
    Event("EVENT_004", "EVENT_004", (64, 64, 152), ""),
    Event("EVENT_NEAR_A", "EVENT_NEAR_A", (120, 120, 120), "near-duplicate pair, A"),
    Event("EVENT_NEAR_B", "EVENT_NEAR_B", (132, 120, 120), "near-duplicate pair, B (dR=12)"),
    Event("EVENT_005", "EVENT_005", (24, 132, 132), ""),
    Event("EVENT_END", "EVENT_END", (176, 176, 32), "pinned to the last frames"),
]

ALL_VISUAL_EVENTS: list[Event] = [*EVENTS, *LADDER_EVENTS]


def _build_occurrences() -> list[Occurrence]:
    """The timeline. Every boundary is a multiple of the 20 ms frame period,
    so each occurrence is a whole number of frames and "the cut is at 3.000 s"
    is literally true rather than true to the nearest half-frame.
    """
    before: list[tuple[str, float, float, list[str]]] = [
        ("EVENT_START", 0.00, 0.40, ["boundary-start"]),
        ("EVENT_001", 0.40, 3.00, ["first-appearance"]),
        ("EVENT_002", 3.00, 5.50, []),
        ("EVENT_SHORT", 5.50, 5.70, ["short-lived"]),
        ("EVENT_003", 5.70, 8.00, []),
        ("EVENT_R1", 8.00, 8.20, ["rapid"]),
        ("EVENT_R2", 8.20, 8.40, ["rapid"]),
        ("EVENT_R3", 8.40, 8.60, ["rapid"]),
        ("EVENT_R4", 8.60, 8.80, ["rapid"]),
        ("EVENT_004", 8.80, 11.00, []),
        ("EVENT_NEAR_A", 11.00, 13.00, ["near-duplicate"]),
        ("EVENT_NEAR_B", 13.00, 15.00, ["near-duplicate"]),
    ]
    ladder_end = round(LADDER_START + LADDER_LENGTH / FPS, 3)
    after: list[tuple[str, float, float, list[str]]] = [
        ("EVENT_005", ladder_end, round(ladder_end + 2.50, 3), []),
        ("EVENT_001", round(ladder_end + 2.50, 3), round(ladder_end + 4.50, 3),
         ["repeat-appearance"]),
        ("EVENT_END", round(ladder_end + 4.50, 3), round(ladder_end + 4.90, 3),
         ["boundary-end"]),
    ]

    rows = list(before)
    for index, event in enumerate(LADDER_EVENTS):
        start = round(LADDER_START + index / FPS, 3)
        rows.append((event.event_id, start, round(start + 1 / FPS, 3), ["frame-ladder"]))
    rows.extend(after)

    return [
        Occurrence(f"occ_{i:02d}", event_id, start, end, props)
        for i, (event_id, start, end, props) in enumerate(rows)
    ]


OCCURRENCES: list[Occurrence] = _build_occurrences()
VISUAL_DURATION = OCCURRENCES[-1].end

# Probes for the request-a-frame-at-T path. Midpoints establish plain
# accuracy; the triplets straddling a cut are what reveal whether a returned
# timestamp means the time we asked for or the frame the decoder landed on.
CUT_PROBE_OFFSETS = (-0.02, 0.0, 0.02)
CUT_PROBES = (3.00, 5.50, 8.20)


def _edge_probes() -> tuple[float, ...]:
    """The first frame, an early frame, and the last frame of the video.

    Derived from the timeline rather than written down, so extending the
    fixture can never leave a "near the end" probe stranded in the middle.
    """
    last = round(VISUAL_DURATION - 1 / FPS, 3)
    return (0.02, 0.10, last)


def _ffmpeg() -> str:
    binary = shutil.which("ffmpeg")
    if binary is None:
        raise SystemExit("ffmpeg is not on PATH — the fixtures cannot be built without it")
    return binary


def _ffprobe() -> str:
    binary = shutil.which("ffprobe")
    if binary is None:
        raise SystemExit("ffprobe is not on PATH — the fixtures cannot be verified without it")
    return binary


def _run(command: list[str], timeout: int = 300) -> subprocess.CompletedProcess:
    return subprocess.run(command, capture_output=True, timeout=timeout, check=True)


def _font(size: int):
    from PIL import ImageFont

    for name in ("consola.ttf", "DejaVuSansMono.ttf", "arial.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    # The bitmap fallback is ~11px and unreadable once scaled; identity here
    # never depends on OCR, so a missing font degrades the label rather than
    # the measurement — but say so rather than silently shipping mush.
    print("warning: no scalable font found; card labels will be tiny", file=sys.stderr)
    return ImageFont.load_default()


def _pattern_bits(event_id: str, count: int = 16) -> list[int]:
    """A stable black/white pattern for one event, derived from its id.

    Colour identifies a card exactly, but a perceptual hash is supposed to be
    an *independent* second opinion and it cannot be one if every card has the
    same layout: pHash reads structure and luminance, so a set of cards that
    differ only in hue hashes almost identically. These blocks give each card
    real structure to hash. The generator refuses to write a manifest whose
    cards are not pHash-separable, so the cross-check either works or the
    fixture does not ship.
    """
    digest = hashlib.sha256(f"pattern/{event_id}".encode()).digest()
    return [(digest[i // 8] >> (i % 8)) & 1 for i in range(count)]


def render_card(event: Event, path: Path) -> None:
    """One solid card: a flat identity band on top, a large label below it."""
    from PIL import Image, ImageDraw

    image = Image.new("RGB", (WIDTH, HEIGHT), event.color)
    draw = ImageDraw.Draw(image)

    # A dark plate behind the text keeps the label readable without touching
    # the sampled band, which stays the pure event colour.
    plate_top = int(HEIGHT * 0.30)
    draw.rectangle([0, plate_top, WIDTH, int(HEIGHT * 0.78)], fill=(16, 16, 20))

    font = _font(54)
    box = draw.textbbox((0, 0), event.label, font=font)
    draw.text(
        ((WIDTH - (box[2] - box[0])) / 2, plate_top + 30),
        event.label,
        font=font,
        fill=(245, 245, 245),
    )
    small = _font(22)
    rgb = f"rgb {event.color[0]} {event.color[1]} {event.color[2]}"
    box = draw.textbbox((0, 0), rgb, font=small)
    draw.text(
        ((WIDTH - (box[2] - box[0])) / 2, plate_top + 100),
        rgb,
        font=small,
        fill=(200, 200, 200),
    )

    # The structural signature pHash reads. Eight blocks per row over two
    # rows, each ~80x27 px — comfortably larger than the 1/32 of a frame that
    # survives pHash's 32x32 DCT, and still legible after a downscale to 512.
    bits = _pattern_bits(event.event_id)
    band_top = int(HEIGHT * 0.80)
    block_w, block_h = WIDTH // 8, int(HEIGHT * 0.10) // 2
    for position, bit in enumerate(bits):
        row, column = divmod(position, 8)
        x0 = column * block_w
        y0 = band_top + row * block_h
        draw.rectangle(
            [x0, y0, x0 + block_w - 1, y0 + block_h - 1],
            fill=(245, 245, 245) if bit else (10, 10, 10),
        )
    image.save(path)


def sample_identity_color(image_path: Path) -> tuple[float, float, float]:
    """Mean RGB of the flat identity band. The measurement, not a heuristic."""
    import numpy as np
    from PIL import Image

    with Image.open(image_path) as handle:
        array = np.asarray(handle.convert("RGB"), dtype=np.float64)
    height, width = array.shape[:2]
    patch = array[
        int(height * SAMPLE_TOP) : int(height * SAMPLE_BOTTOM),
        int(width * SAMPLE_LEFT) : int(width * SAMPLE_RIGHT),
    ]
    mean = patch.reshape(-1, 3).mean(axis=0)
    return (float(mean[0]), float(mean[1]), float(mean[2]))


def perceptual_hash(image_path: Path) -> str:
    import imagehash
    from PIL import Image

    with Image.open(image_path) as handle:
        return str(imagehash.phash(handle.convert("RGB")))


def _digest(path: Path, algorithm: str) -> str:
    digest = hashlib.new(algorithm)
    with path.open("rb") as handle:
        while chunk := handle.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def _encode_segment(card: Path, frames: int, out: Path) -> None:
    _run([
        _ffmpeg(), "-y", "-hide_banner", "-loglevel", "error",
        "-loop", "1", "-i", str(card),
        "-frames:v", str(frames),
        "-r", str(FPS),
        # Lossless, and the same settings as the ladder so the segments concat
        # with a stream copy. Flat cards cost almost nothing to store this way,
        # and it means any colour drift the scorer sees came from the provider
        # rather than from our own encoder.
        "-c:v", "libx264", "-preset", "veryfast", "-qp", "0",
        "-pix_fmt", "yuv420p",
        # Every segment starts on a keyframe: a backend that only ever returns
        # keyframes then has one available at each cut, so a poor result is
        # about its choices rather than about our GOP structure.
        "-g", str(FPS), "-keyint_min", "1", "-sc_threshold", "0",
        str(out),
    ])


def _encode_image_sequence(pattern: Path, frames: int, out: Path) -> None:
    """Encode one image per frame — the ladder, where every frame differs."""
    _run([
        _ffmpeg(), "-y", "-hide_banner", "-loglevel", "error",
        "-framerate", str(FPS), "-i", str(pattern),
        "-frames:v", str(frames), "-r", str(FPS),
        "-c:v", "libx264", "-preset", "veryfast", "-qp", "0",
        "-pix_fmt", "yuv420p",
        "-g", str(FPS), "-keyint_min", "1", "-sc_threshold", "0",
        str(out),
    ])


def _concat(segments: list[Path], out: Path, work: Path, audio: Path | None = None) -> None:
    listing = work / f"{out.stem}-concat.txt"
    listing.write_text(
        "\n".join(f"file '{segment.as_posix()}'" for segment in segments) + "\n",
        encoding="utf-8",
    )
    command = [
        _ffmpeg(), "-y", "-hide_banner", "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-i", str(listing),
    ]
    if audio is not None:
        command += ["-i", str(audio), "-c:a", "aac", "-b:a", "96k", "-shortest"]
    command += ["-c:v", "copy", str(out)]
    _run(command)


def extract_frame_at_index(video: Path, frame_index: int, out: Path) -> None:
    """Pull frame number `frame_index`, counted from zero, by decoding to it.

    Ground truth is verified with this rather than with ``-ss``. Seeking to a
    time and taking one frame is what a fast extractor does, and on this
    machine's ffmpeg it lands one frame *after* the frame whose display
    interval contains the requested time — which is a property worth measuring
    in a provider, and a disqualifying one in the check that is supposed to
    establish what the fixture actually contains.
    """
    _run([
        _ffmpeg(), "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(video),
        "-vf", f"select=eq(n\\,{frame_index})",
        # See realmedia.py: `-vsync` is gone in ffmpeg 9.
        "-fps_mode:v", "passthrough",
        "-frames:v", "1", "-q:v", "2", str(out),
    ])


def extract_frame(video: Path, seconds: float, out: Path) -> None:
    """Pull one frame by seeking to `seconds` — the fast-extractor idiom."""
    _run([
        _ffmpeg(), "-y", "-hide_banner", "-loglevel", "error",
        "-ss", f"{seconds:.3f}", "-i", str(video),
        "-frames:v", "1", "-q:v", "2", str(out),
    ])


def probe_media(video: Path) -> dict[str, Any]:
    result = _run([
        _ffprobe(), "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", str(video),
    ])
    data = json.loads(result.stdout)
    video_stream = next(
        (s for s in data["streams"] if s.get("codec_type") == "video"), {}
    )
    audio_stream = next(
        (s for s in data["streams"] if s.get("codec_type") == "audio"), None
    )
    return {
        "duration_seconds": round(float(data["format"]["duration"]), 3),
        "width": video_stream.get("width"),
        "height": video_stream.get("height"),
        "nb_frames": int(video_stream["nb_frames"]) if video_stream.get("nb_frames") else None,
        "video_codec": video_stream.get("codec_name"),
        "has_audio": audio_stream is not None,
        "audio_codec": audio_stream.get("codec_name") if audio_stream else None,
        "size_bytes": int(data["format"]["size"]),
    }


def audio_duration(path: Path) -> float:
    result = _run([
        _ffprobe(), "-v", "error", "-show_entries", "format=duration",
        "-print_format", "json", str(path),
    ])
    return round(float(json.loads(result.stdout)["format"]["duration"]), 3)


# --- the visual fixture -----------------------------------------------------


def build_visual(out_dir: Path, work: Path) -> dict[str, Any]:
    cards_dir = work / "cards"
    cards_dir.mkdir(parents=True, exist_ok=True)
    by_id = {event.event_id: event for event in ALL_VISUAL_EVENTS}

    cards: dict[str, Path] = {}
    for event in ALL_VISUAL_EVENTS:
        card = cards_dir / f"{event.event_id}.png"
        render_card(event, card)
        cards[event.event_id] = card

    # The ladder's twenty-five one-frame occurrences go out as a single image
    # sequence. Concatenating twenty-five one-frame MP4s instead would put a
    # container boundary between every pair of frames the ladder exists to
    # measure across, which is a risk taken for no benefit.
    ladder_ids = [event.event_id for event in LADDER_EVENTS]
    ladder_dir = work / "ladder"
    ladder_dir.mkdir(parents=True, exist_ok=True)
    for index, event_id in enumerate(ladder_ids):
        shutil.copyfile(cards[event_id], ladder_dir / f"rung_{index:03d}.png")

    segments: list[Path] = []
    emitted_ladder = False
    for occurrence in OCCURRENCES:
        if occurrence.event_id in ladder_ids:
            if not emitted_ladder:
                segment = work / "seg_ladder.mp4"
                _encode_image_sequence(ladder_dir / "rung_%03d.png", LADDER_LENGTH, segment)
                segments.append(segment)
                emitted_ladder = True
            continue
        frames = round((occurrence.end - occurrence.start) * FPS)
        if abs(frames - (occurrence.end - occurrence.start) * FPS) > 1e-6:
            raise SystemExit(
                f"{occurrence.occurrence_id} is not a whole number of frames at {FPS} fps"
            )
        segment = work / f"seg_{occurrence.occurrence_id}.mp4"
        _encode_segment(cards[occurrence.event_id], frames, segment)
        segments.append(segment)

    video = out_dir / "visual_events.mp4"
    _concat(segments, video, work)

    events_payload = {
        event.event_id: {
            "label": event.label,
            "color": list(event.color),
            "phash": perceptual_hash(cards[event.event_id]),
            "card_sha256": _digest(cards[event.event_id], "sha256"),
            "note": event.note,
        }
        for event in ALL_VISUAL_EVENTS
    }

    probes: list[float] = [occurrence.midpoint for occurrence in OCCURRENCES]
    for cut in CUT_PROBES:
        probes.extend(round(cut + offset, 3) for offset in CUT_PROBE_OFFSETS)
    probes.extend(_edge_probes())
    # The MCP tool rejects duplicate timestamp values outright, so the probe
    # list has to be a set before it is ever sent.
    probes = sorted({round(p, 3) for p in probes if 0 <= p < VISUAL_DURATION})

    media = probe_media(video)
    separation = verify_phash_separable(events_payload)
    verification = verify_visual(video, work, by_id)

    return {
        "file": video.name,
        "kind": "visual",
        "fps": FPS,
        "declared_duration_seconds": VISUAL_DURATION,
        "media": media,
        "sha256": _digest(video, "sha256"),
        # The MCP client keys its local job registry on MD5, so the manifest
        # records the identifier the provider will actually use for this file.
        "md5": _digest(video, "md5"),
        "identity_band": {
            "top": SAMPLE_TOP, "bottom": SAMPLE_BOTTOM,
            "left": SAMPLE_LEFT, "right": SAMPLE_RIGHT,
        },
        "events": events_payload,
        "occurrences": [asdict(o) for o in OCCURRENCES],
        "probe_timestamps": probes,
        "cut_times": list(CUT_PROBES),
        "frame_ladder": {
            "start": LADDER_START,
            "length_frames": LADDER_LENGTH,
            "frame_period_seconds": round(1 / FPS, 4),
            "event_ids": [event.event_id for event in LADDER_EVENTS],
            "why": (
                "Every rung is one frame of its own colour, so a frame decoded "
                "from this window is attributed to exactly one frame and its true "
                "time is known to the frame period. Outside the ladder an "
                "identity resolves only to an occurrence interval, and the scorer "
                "reports a bound instead of a point."
            ),
        },
        "phash_separation": separation,
        "verification": verification,
        "properties": [
            "hard-cuts-at-known-times", "unique-visual-event-ids",
            "rapid-sequential-changes", "near-duplicate-adjacent-events",
            "short-lived-event", "repeated-visual-much-later",
            "boundary-event-near-start", "boundary-event-near-end",
            "frame-exact-ladder",
        ],
    }


def verify_phash_separable(events: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Refuse to ship a fixture whose perceptual-hash cross-check is a no-op.

    An earlier revision of these cards differed only in hue. pHash reads
    structure, so a hundred pairs out of seven hundred hashed *identically*
    and the "independent" second opinion was really a coin toss — which would
    have shown up in a report as the provider disagreeing with itself. The
    block pattern fixes that, and this check is what keeps it fixed.
    """
    import itertools

    ids = sorted(events)
    distances = {
        (a, b): bin(int(events[a]["phash"], 16) ^ int(events[b]["phash"], 16)).count("1")
        for a, b in itertools.combinations(ids, 2)
    }
    collisions = [pair for pair, distance in distances.items() if distance == 0]
    values = sorted(distances.values())
    minimum = 6
    if collisions:
        raise SystemExit(
            f"{len(collisions)} card pairs share a perceptual hash — the pHash "
            f"cross-check would be meaningless. Examples: {collisions[:5]}"
        )
    if values[0] < minimum:
        raise SystemExit(
            f"closest card pair is only {values[0]} bits apart; {minimum} is the "
            "floor for pHash to be an independent identity channel"
        )
    return {
        "pairs": len(distances),
        "min_bits": values[0],
        "median_bits": values[len(values) // 2],
        "max_bits": values[-1],
        "required_min_bits": minimum,
        "why": (
            "Cards carry a per-event block pattern so a perceptual hash has real "
            "structure to read. Without it every card hashes alike and the "
            "cross-check silently stops being one."
        ),
    }


def verify_visual(video: Path, work: Path, by_id: dict[str, Event]) -> dict[str, Any]:
    """Read every occurrence back out of the encoded file and check it.

    Ground truth nobody verified is a claim. This decodes the midpoint of each
    occurrence and asserts the identity band still carries the colour this
    script drew, which is the same measurement the scorer will make against
    the provider's frames.
    """
    checks = []
    worst = 0.0
    probe_dir = work / "verify"
    probe_dir.mkdir(parents=True, exist_ok=True)
    for occurrence in OCCURRENCES:
        frame = probe_dir / f"{occurrence.occurrence_id}.png"
        # The first frame of the occurrence, addressed by index. Every
        # occurrence starts on an exact frame boundary by construction, so
        # this is the frame that must carry the event's colour.
        index = round(occurrence.start * FPS)
        extract_frame_at_index(video, index, frame)
        measured = sample_identity_color(frame)
        expected = by_id[occurrence.event_id].color
        drift = max(abs(m - e) for m, e in zip(measured, expected, strict=True))
        worst = max(worst, drift)
        checks.append({
            "occurrence_id": occurrence.occurrence_id,
            "event_id": occurrence.event_id,
            "frame_index": index,
            "at": round(index / FPS, 3),
            "expected_color": list(expected),
            "measured_color": [round(c, 2) for c in measured],
            "max_channel_drift": round(drift, 3),
        })
    # Half the 12-level gap between the near-duplicate pair. yuv420p is stored
    # limited-range, so a flat card's mean comes back a level or three off no
    # matter how losslessly it was encoded; the gap is set wide enough that
    # this never decides which of the pair a frame is, and tight enough that
    # the pair stays a genuine near-duplicate.
    tolerance = 6.0
    failures = [c for c in checks if c["max_channel_drift"] > tolerance]
    if failures:
        raise SystemExit(
            "fixture verification failed — the encoded video does not match the "
            f"intended ground truth (tolerance {tolerance}): "
            + json.dumps(failures, indent=2)
        )
    return {
        "method": "decode each occurrence midpoint and compare the identity band",
        "tolerance_max_channel_drift": tolerance,
        "worst_observed_drift": round(worst, 3),
        "checks": checks,
    }


# --- the speech fixture -----------------------------------------------------

# No proper nouns, and the vocabulary Watch Skill actually indexes: totals,
# error codes, UI words. A recogniser mangling a surname would say nothing
# about whether this backend is usable.
UTTERANCES: list[str] = [
    "the checkout total is not a number",
    "the server returned error five zero two",
    "the page is loading again now",
    "the order status failed to update",
]

# Layout intent, applied after each clip's real length is measured. The first
# gap is the leading silence; 0.15 s is the closely spaced pair.
LEAD_SILENCE = 2.00
GAPS = [0.15, 1.20, 0.90]

SPEECH_TAIL = 1.00


def _synthesize(text: str, out: Path) -> bool:
    system = platform.system()
    if system == "Windows":
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
    if system == "Darwin":
        aiff = out.with_suffix(".aiff")
        if subprocess.run(["say", "-o", str(aiff), text],
                          capture_output=True, timeout=120).returncode != 0:
            return False
        _run([_ffmpeg(), "-y", "-loglevel", "error", "-i", str(aiff), str(out)])
        aiff.unlink(missing_ok=True)
        return out.is_file()
    espeak = shutil.which("espeak-ng") or shutil.which("espeak")
    if espeak is None:
        return False
    return subprocess.run([espeak, "-w", str(out), text],
                          capture_output=True, timeout=120).returncode == 0


def build_speech(out_dir: Path, work: Path) -> dict[str, Any] | None:
    """Speech with cue intervals we chose rather than ones we transcribed."""
    parts_dir = work / "speech"
    parts_dir.mkdir(parents=True, exist_ok=True)

    clips: list[Path] = []
    for index, text in enumerate(UTTERANCES):
        clip = parts_dir / f"utt_{index}.wav"
        if not _synthesize(text, clip):
            print(
                "no system text-to-speech voice available — skipping the speech "
                "fixture (needs SAPI on Windows, `say` on macOS, espeak-ng on Linux)",
                file=sys.stderr,
            )
            return None
        # Normalized to one rate/layout up front so the placed offsets below
        # are sample-exact rather than resampled into approximate ones.
        normalized = parts_dir / f"utt_{index}_16k.wav"
        _run([
            _ffmpeg(), "-y", "-hide_banner", "-loglevel", "error", "-i", str(clip),
            "-ac", "1", "-ar", "16000", "-acodec", "pcm_s16le", str(normalized),
        ])
        clips.append(normalized)

    durations = [audio_duration(clip) for clip in clips]

    cues: list[dict[str, Any]] = []
    cursor = LEAD_SILENCE
    for index, (text, length) in enumerate(zip(UTTERANCES, durations, strict=True)):
        start = round(cursor, 3)
        end = round(start + length, 3)
        cues.append({
            "cue_id": f"cue_{index:02d}",
            "start": start,
            "end": end,
            "text": text,
            "properties": (
                ["after-silence"] if index == 0
                else ["closely-spaced"] if index == 1
                else []
            ),
        })
        cursor = end + (GAPS[index] if index < len(GAPS) else 0.0)
    total = round(cursor + SPEECH_TAIL, 2)

    # One filter graph: pad each clip to its slot, then mix. Concatenating
    # silence files instead would accumulate a rounding error per boundary.
    inputs: list[str] = []
    filters: list[str] = []
    for index, clip in enumerate(clips):
        inputs += ["-i", str(clip)]
        delay_ms = round(cues[index]["start"] * 1000)
        filters.append(f"[{index}:a]adelay={delay_ms}|{delay_ms}[a{index}]")
    mix = "".join(f"[a{i}]" for i in range(len(clips)))
    filters.append(f"{mix}amix=inputs={len(clips)}:normalize=0[out]")
    audio = work / "speech.wav"
    _run([
        _ffmpeg(), "-y", "-hide_banner", "-loglevel", "error", *inputs,
        "-filter_complex", ";".join(filters), "-map", "[out]",
        "-ac", "1", "-ar", "16000", "-acodec", "pcm_s16le",
        "-t", f"{total:.3f}", str(audio),
    ])

    # The video track changes in lockstep with the speech, so "was the frame
    # showing what the speaker was saying" is answerable from ground truth.
    cards_dir = work / "speech_cards"
    cards_dir.mkdir(parents=True, exist_ok=True)
    silence_event = Event("SPEECH_SILENCE", "SILENCE", (40, 40, 48), "no speech")
    speech_events = [
        Event(f"SPEECH_{i:02d}", f"SPEAKING_{i:02d}", color, UTTERANCES[i])
        for i, color in enumerate([(200, 60, 60), (60, 160, 200), (80, 190, 90), (210, 150, 40)])
    ]
    all_events = [silence_event, *speech_events]
    cards = {}
    for event in all_events:
        card = cards_dir / f"{event.event_id}.png"
        render_card(event, card)
        cards[event.event_id] = card

    spans: list[tuple[str, float, float]] = []
    cursor = 0.0
    for index, cue in enumerate(cues):
        if cue["start"] > cursor:
            spans.append(("SPEECH_SILENCE", cursor, cue["start"]))
        spans.append((f"SPEECH_{index:02d}", cue["start"], cue["end"]))
        cursor = cue["end"]
    if total > cursor:
        spans.append(("SPEECH_SILENCE", cursor, total))

    segments = []
    aligned_spans = []
    for index, (event_id, start, end) in enumerate(spans):
        frames = max(1, round((end - start) * FPS))
        segment = work / f"sp_seg_{index:02d}.mp4"
        _encode_segment(cards[event_id], frames, segment)
        segments.append(segment)
        # The encoded span is a whole number of frames, which can differ from
        # the audio slot by up to one frame. Recording what was encoded keeps
        # the visual ground truth honest instead of restating the intent.
        aligned_spans.append({
            "event_id": event_id,
            "start": round(start, 3),
            "encoded_frames": frames,
            "encoded_duration": round(frames / FPS, 3),
        })

    video = out_dir / "speech_events.mp4"
    _concat(segments, video, work, audio=audio)
    media = probe_media(video)

    return {
        "file": video.name,
        "kind": "speech",
        "fps": FPS,
        "media": media,
        "sha256": _digest(video, "sha256"),
        "md5": _digest(video, "md5"),
        "voice": f"system TTS ({platform.system()})",
        "language": "en",
        "note": (
            "Synthesized locally and rights-clear. A clean synthetic voice is an "
            "easier recognition problem than a real recording; any WER measured "
            "here must be reported as such."
        ),
        "cues": cues,
        "reference_text": " ".join(UTTERANCES),
        "visual_spans": aligned_spans,
        "events": {
            event.event_id: {
                "label": event.label,
                "color": list(event.color),
                "phash": perceptual_hash(cards[event.event_id]),
                "card_sha256": _digest(cards[event.event_id], "sha256"),
                "note": event.note,
            }
            for event in all_events
        },
        "properties": [
            "known-spoken-transcript", "known-cue-intervals",
            "closely-spaced-speech", "silence-then-speech",
            "visual-and-spoken-together",
        ],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="make_fixtures")
    parser.add_argument("--out", default=str(FIXTURES),
                        help="Directory to write the fixtures + manifest into.")
    parser.add_argument("--skip-speech", action="store_true",
                        help="Build only the visual fixture (no TTS needed).")
    args = parser.parse_args(argv)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="ws-vb-fixtures-") as tmp:
        work = Path(tmp)
        fixtures: dict[str, Any] = {"visual_events": build_visual(out_dir, work)}
        if not args.skip_speech:
            speech = build_speech(out_dir, work)
            if speech is not None:
                fixtures["speech_events"] = speech

    manifest = {
        "schema": MANIFEST_SCHEMA,
        "generated_by": "benchmarks/video_backends/make_fixtures.py",
        "fps": FPS,
        "frame_period_ms": FRAME_MS,
        "note": (
            "Ground truth for external video-backend evaluation. The MP4s are "
            "regenerated by the script above rather than committed; the digests "
            "recorded here are what each measurement was proven against."
        ),
        "fixtures": fixtures,
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )

    for name, fixture in fixtures.items():
        print(
            f"{name}: {fixture['file']} "
            f"({fixture['media']['duration_seconds']}s, "
            f"{fixture['media']['size_bytes'] / 1024:.0f} KB)"
        )
    print(f"\nwrote {out_dir / 'manifest.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
