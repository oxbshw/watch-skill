"""Drive the real Adversal MCP 0.1.4 server over stdio.

The server is the ``adversal-cli`` console script. This adapter spawns it the
way any MCP client would, calls its tools, times them, and hands the replies
to :mod:`adversal_parse`. It never edits the repository's ``.mcp.json`` and
never registers anything in an agent's configuration: a benchmark that
rearranges the machine it runs on is a benchmark nobody can rerun.

Authentication is browser-interactive and stored outside this repository, in
``~/.adversal/auth.txt``. This adapter reads none of it and never prints it.
When the session is missing, the calls that need it return
:attr:`OutcomeStatus.AUTH_REQUIRED` and the runner records that as an
un-measured path — never as a zero.
"""
from __future__ import annotations

import asyncio
import json
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

from watch_skill.bench.video_backends.adapters import adversal_parse
from watch_skill.bench.video_backends.sanitize import sanitize
from watch_skill.bench.video_backends.types import (
    BackendCue,
    BackendDescription,
    BackendFrame,
    CallRecord,
    Outcome,
    OutcomeStatus,
    TimestampSemantics,
)

PACKAGE = "adversal-cli"
EXPECTED_VERSION = "0.1.4"

# `_extract_requested_frames` writes `frame-{n:03d}-{ms}ms.jpg`, where `ms` is
# the time that was ASKED FOR, rounded to milliseconds. It is not the
# presentation time of the frame that came back, and the difference between
# those two is one of the things this benchmark exists to measure.
_REQUESTED_FRAME = re.compile(r"^frame-(\d+)-(\d+)ms\.(jpe?g|png)$", re.I)

_TIMESTAMP_KEYS = ("timestamp", "timestamp_seconds", "time", "start", "seconds", "ts")
_OCR_KEYS = ("ocr", "ocr_text", "text")
_PATH_KEYS = ("path", "file", "filename", "image", "frame")


class AdversalMcpAdapter:
    """Adversal MCP 0.1.4, reached over stdio."""

    name = "adversal-mcp"

    def __init__(
        self,
        executable: str | None = None,
        *,
        python: str | None = None,
        timeout: float = 900.0,
    ) -> None:
        self.executable = executable or shutil.which("adversal-cli") or "adversal-cli"
        # The interpreter the package is installed into, used only to read its
        # version. adversal-cli needs Python >= 3.13 and Watch Skill supports
        # 3.11, so the two commonly live in different environments.
        self.python = python
        self.timeout = timeout
        self._description: BackendDescription | None = None

    # --- transport ----------------------------------------------------------

    async def _call_async(self, tool: str, arguments: dict[str, Any]) -> tuple[str, Any]:
        from fastmcp import Client
        from fastmcp.client.transports import StdioTransport

        transport = StdioTransport(command=self.executable, args=[])
        async with Client(transport) as client:
            result = await client.call_tool(tool, arguments)
        text = _result_text(result)
        return text, result

    def call(self, tool: str, arguments: dict[str, Any]) -> CallRecord:
        """One tool call, timed and classified.

        A fresh subprocess per call. That is slower than holding one open, and
        it is the honest choice: 0.1.4 caches its access token for the lifetime
        of the process, so a long-lived server would measure a warm token on
        every call but the first and quietly flatter the latency numbers.
        """
        started = time.perf_counter()
        try:
            text, _ = asyncio.run(
                asyncio.wait_for(self._call_async(tool, arguments), self.timeout)
            )
            status = adversal_parse.classify(text)
            error = None
        except TimeoutError:
            text, status = "", OutcomeStatus.TRANSPORT_ERROR
            error = f"timed out after {self.timeout}s"
        except Exception as exc:  # a broken call is a result, not a crash
            text, status = "", OutcomeStatus.TRANSPORT_ERROR
            error = f"{type(exc).__name__}: {exc}"[:300]
        elapsed = time.perf_counter() - started

        return CallRecord(
            tool=tool,
            arguments=sanitize(arguments),
            status=status,
            latency_seconds=round(elapsed, 4),
            # Sanitized here, at the moment of capture, so an unredacted
            # message never exists in a record that later gets written out.
            message_excerpt=sanitize(text)[:2000],
            error=sanitize(error) if error else None,
        )

    # --- identity -----------------------------------------------------------

    def package_version(self) -> tuple[str, str]:
        """The adversal-cli version, and how it was established.

        Read from installed package metadata, not from the MCP handshake: the
        handshake reports the FastMCP framework's version in the server-version
        field, and putting that number at the top of a report about 0.1.4 would
        be wrong in a way nobody would catch.
        """
        interpreter = self.python
        if interpreter is None:
            return "unknown", "no interpreter given for the adversal-cli environment"
        try:
            result = subprocess.run(
                [interpreter, "-c",
                 "import importlib.metadata as m;print(m.version('adversal-cli'))"],
                capture_output=True, text=True, timeout=60, check=True,
            )
            return result.stdout.strip(), f"importlib.metadata via {Path(interpreter).name}"
        except (OSError, subprocess.SubprocessError) as exc:
            return "unknown", f"could not read package metadata: {type(exc).__name__}"

    def describe(self) -> BackendDescription:
        if self._description is not None:
            return self._description

        version, source = self.package_version()
        server_name = server_version = protocol = None
        tools: list[str] = []
        notes: list[str] = []
        try:
            server_name, server_version, protocol, tools = asyncio.run(self._handshake())
        except Exception as exc:  # noqa: BLE001 — a failed handshake is a finding
            notes.append(f"handshake failed: {type(exc).__name__}: {exc}"[:200])

        if server_version and version != "unknown" and server_version != version:
            notes.append(
                f"the MCP handshake reports server version {server_version}, which is "
                f"the FastMCP framework's version, not adversal-cli's ({version}); "
                "the provider version is not discoverable over MCP"
            )
        if version != "unknown" and version != EXPECTED_VERSION:
            notes.append(
                f"installed adversal-cli is {version}, not the {EXPECTED_VERSION} "
                "this benchmark was written against"
            )

        self._description = BackendDescription(
            name=self.name,
            version=version,
            version_source=source,
            transport="stdio MCP (fastmcp client -> adversal-cli)",
            server_name=server_name,
            server_version=server_version,
            protocol_version=protocol,
            tools=sorted(tools),
            notes=notes,
        )
        return self._description

    async def _handshake(self) -> tuple[str | None, str | None, str | None, list[str]]:
        from fastmcp import Client
        from fastmcp.client.transports import StdioTransport

        transport = StdioTransport(command=self.executable, args=[])
        async with Client(transport) as client:
            init = getattr(client, "initialize_result", None)
            info = getattr(init, "serverInfo", None) if init else None
            tools = await client.list_tools()
            return (
                getattr(info, "name", None),
                getattr(info, "version", None),
                getattr(init, "protocolVersion", None) if init else None,
                [tool.name for tool in tools],
            )

    # --- operations ---------------------------------------------------------

    def submit(
        self,
        video: Path,
        *,
        output_dir: Path,
        timestamps: list[float] | None = None,
        video_url: str | None = None,
        **options: Any,
    ) -> Outcome:
        """Submit a source, optionally asking for exact local frames.

        ``timestamps`` is the path Adversal added in 0.1.4 and asked us to
        test. In 0.1.4 it is served by ffmpeg on *this* machine, before the
        upload and before any credential is needed — so it is measurable
        whether or not an account exists, and the report says which side of
        that line each number came from.
        """
        arguments: dict[str, Any] = {"output_path": str(output_dir)}
        if video_url is not None:
            arguments["video_url"] = video_url
        else:
            arguments["video_path"] = str(video)
        if timestamps:
            arguments["timestamps"] = [_format_timestamp(t) for t in timestamps]
        arguments.update(options)

        record = self.call("process_video", arguments)
        frames = (
            read_requested_frames(output_dir / "requested_frames")
            if timestamps else []
        )
        return Outcome(
            status=record.status,
            frames=frames,
            provider_job_id=adversal_parse.request_id(record.message_excerpt),
            calls=[record],
            detail=record.message_excerpt,
            artifacts={"requested_frames_dir": str(output_dir / "requested_frames")}
            if timestamps else {},
        )

    def poll(self, handle: str) -> Outcome:
        record = self.call("check_video_status", {"request_id": handle})
        return Outcome(
            status=record.status,
            provider_job_id=adversal_parse.request_id(record.message_excerpt) or handle,
            calls=[record],
            detail=record.message_excerpt,
        )

    def fetch_frames(self, handle: str, *, output_dir: Path) -> Outcome:
        record = self.call(
            "extract_frames", {"request_id": handle, "output_path": str(output_dir)}
        )
        frames: list[BackendFrame] = []
        if record.status is OutcomeStatus.OK:
            frames = read_frames_json(output_dir)
        return Outcome(
            status=record.status,
            frames=frames,
            provider_job_id=handle,
            calls=[record],
            detail=record.message_excerpt,
            artifacts={"frames_dir": str(output_dir)},
        )

    def fetch_transcript(self, handle: str, *, output_dir: Path) -> Outcome:
        record = self.call(
            "transcribe", {"request_id": handle, "output_path": str(output_dir)}
        )
        cues: list[BackendCue] = []
        source = None
        if record.status is OutcomeStatus.OK:
            cues, source = read_transcript_json(output_dir)
        return Outcome(
            status=record.status,
            cues=cues,
            transcript_source=source,
            provider_job_id=handle,
            calls=[record],
            detail=record.message_excerpt,
            artifacts={"transcript_dir": str(output_dir)},
        )

    def quota(self) -> Outcome:
        record = self.call("check_remaining_quota", {})
        return Outcome(status=record.status, calls=[record], detail=record.message_excerpt)

    def request_id_for(self, video: Path) -> Outcome:
        record = self.call("get_request_id", {"video_path": str(video)})
        return Outcome(
            status=record.status,
            provider_job_id=adversal_parse.request_id(record.message_excerpt),
            calls=[record],
            detail=record.message_excerpt,
        )


# --- artifact readers -------------------------------------------------------


def _result_text(result: Any) -> str:
    """Flatten an MCP tool result into the string 0.1.4 actually returns."""
    for attribute in ("data", "content"):
        value = getattr(result, attribute, None)
        if isinstance(value, str):
            return value
        if isinstance(value, list):
            parts = [getattr(item, "text", None) for item in value]
            joined = "\n".join(p for p in parts if isinstance(p, str))
            if joined:
                return joined
    return str(result)


def _format_timestamp(seconds: float) -> str:
    """Seconds as the plain decimal string the tool documents and parses."""
    return f"{seconds:.3f}".rstrip("0").rstrip(".") or "0"


def read_requested_frames(directory: Path) -> list[BackendFrame]:
    """Read the frames 0.1.4 wrote for an exact-timestamp request.

    The only time these carry is the one encoded in the filename, which is the
    time that was *requested*. Nothing in the output states the presentation
    time of the frame that was actually decoded, so the semantics are recorded
    as REQUESTED rather than assumed to be decoded media time.
    """
    if not directory.is_dir():
        return []
    frames: list[BackendFrame] = []
    for path in sorted(directory.iterdir()):
        match = _REQUESTED_FRAME.match(path.name)
        if match is None:
            continue
        ordinal, milliseconds = int(match.group(1)), int(match.group(2))
        requested = milliseconds / 1000.0
        frames.append(BackendFrame(
            index=ordinal - 1,
            timestamp_seconds=requested,
            path=path,
            provider_id=path.name,
            semantics=TimestampSemantics.REQUESTED,
            requested_seconds=requested,
            raw={"filename": path.name, "filename_ms": milliseconds},
        ))
    return sorted(frames, key=lambda frame: frame.index)


def _first(mapping: dict[str, Any], keys: tuple[str, ...]) -> Any:
    for key in keys:
        if key in mapping and mapping[key] is not None:
            return mapping[key]
    return None


def parse_time_value(value: Any) -> float | None:
    """Seconds from whatever 0.1.4 put in a timestamp field.

    The live service answers with ``"00:00:04"`` — a clock string, not a
    number, and quantised to whole seconds. The first version of this reader
    assumed numeric seconds, which turned every transcript cue into a cue with
    no time at all rather than into an obviously wrong one. Numeric forms are
    still accepted so a future release that switches to floats keeps working.

    The whole-second quantisation is preserved, not smoothed: a benchmark that
    interpolated here would be reporting precision the provider never sent.
    """
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if not text:
        return None
    if ":" in text:
        parts = text.split(":")
        if len(parts) > 3:
            return None
        try:
            numbers = [float(part) for part in parts]
        except ValueError:
            return None
        seconds = 0.0
        for number in numbers:
            seconds = seconds * 60 + number
        return seconds
    try:
        return float(text)
    except ValueError:
        return None


def read_frames_json(directory: Path) -> list[BackendFrame]:
    """Parse the ``frames.json`` that ``extract_frames`` extracts.

    The schema has been observed against the live service. 0.1.4 returns a
    JSON list of ``{frame, timestamp, text}``, where ``frame`` names a file in
    the extracted ``frames/`` directory, ``timestamp`` is an ``HH:MM:SS``
    clock string quantised to whole seconds, and ``text`` carries the OCR of
    that frame. An empty list is a valid answer and means the pipeline chose
    no frames for that video.

    The reader stays tolerant of other shapes and keeps every field it did not
    understand in ``raw``, because one observed release is not a contract.
    """
    manifest = directory / "frames.json"
    if not manifest.is_file():
        return []
    try:
        payload = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []

    rows: list[Any]
    if isinstance(payload, list):
        rows = payload
    elif isinstance(payload, dict):
        rows = next(
            (payload[key] for key in ("frames", "items", "results")
             if isinstance(payload.get(key), list)),
            [],
        )
    else:
        rows = []

    frames: list[BackendFrame] = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        seconds = parse_time_value(_first(row, _TIMESTAMP_KEYS))
        name = _first(row, _PATH_KEYS)
        path = None
        if isinstance(name, str):
            candidate = directory / name
            path = candidate if candidate.is_file() else directory / "frames" / Path(name).name
        ocr = _first(row, _OCR_KEYS)
        frames.append(BackendFrame(
            index=index,
            timestamp_seconds=seconds,
            path=path,
            provider_id=str(row.get("id")) if row.get("id") is not None else (
                name if isinstance(name, str) else None
            ),
            semantics=TimestampSemantics.UNKNOWN,
            ocr_text=ocr if isinstance(ocr, str) else None,
            raw=row,
        ))
    return frames


def read_transcript_json(directory: Path) -> tuple[list[BackendCue], str | None]:
    """Parse ``transcript.json``, observed against the live service.

    0.1.4 returns a JSON list of ``{start, end, text}``, with both times as
    ``HH:MM:SS`` clock strings at whole-second resolution. The quantisation is
    preserved rather than smoothed — interpolating would report precision the
    provider never sent.

    The transcript's *origin* — embedded captions, provider ASR, something
    else — is reported only if the payload states it, and 0.1.4 does not. It
    is never inferred: "probably Whisper" is not evidence, and Watch Skill
    records a transcript's source as provenance, so a guess there would
    corrupt real evidence.
    """
    path = directory / "transcript.json"
    if not path.is_file():
        return [], None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return [], None

    source = None
    rows: list[Any] = []
    if isinstance(payload, list):
        rows = payload
    elif isinstance(payload, dict):
        for key in ("source", "transcript_source", "engine", "model"):
            if isinstance(payload.get(key), str):
                source = payload[key]
                break
        rows = next(
            (payload[key] for key in ("segments", "cues", "transcript", "results", "items")
             if isinstance(payload.get(key), list)),
            [],
        )

    cues: list[BackendCue] = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        start = _first(row, ("start", "start_time", "from", "begin", "timestamp"))
        end = _first(row, ("end", "end_time", "to", "stop"))

        cues.append(BackendCue(
            index=index,
            start=parse_time_value(start),
            end=parse_time_value(end),
            text=str(_first(row, ("text", "content", "transcript")) or ""),
            speaker=row.get("speaker") if isinstance(row.get("speaker"), str) else None,
            provider_id=str(row.get("id")) if row.get("id") is not None else None,
            raw=row,
        ))
    return cues, source
