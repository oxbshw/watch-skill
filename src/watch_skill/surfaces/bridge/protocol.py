"""Wire constants, framing, and the structured error contract.

Framing is LSP-style: ``Content-Length: <n>\r\n\r\n`` followed by exactly
``n`` bytes of UTF-8 JSON. Newline-delimited JSON was not an option — Core
streams transcripts and OCR text, which contain newlines, so a delimiter that
can appear inside a payload cannot delimit it.

Everything here is transport. No Core module is imported by this file, which
is what lets the framing tests run without importing the engine.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, BinaryIO

#: The protocol version this Core speaks.
PROTOCOL_VERSION = 1

#: The oldest protocol version this Core will still negotiate down to.
PROTOCOL_VERSION_MIN = 1

#: Largest frame this Core will read. Matches the Host's own ceiling, because
#: a limit only one side enforces is a limit that produces a hang on the other.
#: A frame past this is not a large message, it is a broken or hostile one, and
#: those two differ in exactly one way that matters: only one can be waited out.
MAX_FRAME_BYTES = 64 * 1024 * 1024

_HEADER_TERMINATOR = b"\r\n\r\n"
_CONTENT_LENGTH = re.compile(rb"content-length:\s*(\d+)", re.IGNORECASE)

# JSON-RPC's own reserved codes, plus the one application code that carries a
# WatchError in `data`. The Host maps -32601 to `bridge.method_not_found` and
# -32000 to whatever the payload says, so these values are load-bearing.
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
WATCH_ERROR = -32000


class FrameError(Exception):
    """The byte stream stopped being a sequence of frames.

    Raised only for damage no further bytes can repair — a missing
    ``Content-Length``, a declared length past :data:`MAX_FRAME_BYTES`. A
    truncated stream is EOF, which is not an error, and is signalled by
    :func:`read_frame` returning ``None``.
    """


@dataclass(frozen=True)
class BridgeError(Exception):
    """The error contract both sides share.

    ``fix`` is required rather than optional, and the type enforces it: a
    failure the reader cannot act on is a failure the product has not finished
    reporting. ``details`` carries structured context, never a credential and
    never an absolute host path — :func:`redact` is applied on the way out.
    """

    error: str
    message: str
    fix: str
    details: dict[str, Any] = field(default_factory=dict)
    retryable: bool = False
    correlation_id: str | None = None

    def to_wire(self) -> dict[str, Any]:
        """Serialize to the `WatchError` shape the Host's contracts declare."""
        return {
            "error": self.error,
            "message": self.message,
            "fix": self.fix,
            "details": self.details,
            "retryable": self.retryable,
            "correlationId": self.correlation_id,
        }


def read_frame(stream: BinaryIO) -> bytes | None:
    """Read exactly one frame, or ``None`` at a clean end of stream.

    Returning ``None`` for EOF rather than raising is the whole shutdown
    story: the Host closes stdin when it is done, and a Core that treated that
    as a fault would log an error on every normal exit.

    Args:
        stream: the binary stdin to read from.

    Returns:
        The frame body as raw bytes, or ``None`` when the stream ended between
        frames.

    Raises:
        FrameError: the stream is no longer parseable as frames.
    """
    header = bytearray()
    while not header.endswith(_HEADER_TERMINATOR):
        byte = stream.read(1)
        if not byte:
            # EOF mid-header is still EOF. A partial header is what a killed
            # parent leaves behind, and reporting it as a protocol violation
            # would make every abrupt shutdown look like a Core defect.
            return None
        header.extend(byte)
        if len(header) > 8192:
            raise FrameError("header exceeded 8192 bytes without a terminator")

    match = _CONTENT_LENGTH.search(bytes(header))
    if match is None:
        raise FrameError("frame header carried no Content-Length")
    length = int(match.group(1))
    if length > MAX_FRAME_BYTES:
        # Refuse now rather than allocate: no further bytes can make a frame
        # this size legitimate, and waiting for them hides the reason.
        raise FrameError(
            f"declared frame of {length} bytes exceeds the {MAX_FRAME_BYTES}-byte limit"
        )

    body = bytearray()
    while len(body) < length:
        chunk = stream.read(length - len(body))
        if not chunk:
            return None
        body.extend(chunk)
    return bytes(body)


def write_frame(stream: BinaryIO, payload: dict[str, Any]) -> None:
    """Write one framed JSON message and flush it.

    Flushing is not optional: the Host is blocked reading, so a buffered reply
    is an indistinguishable-from-hung request.
    """
    body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
    stream.write(b"Content-Length: %d\r\n\r\n" % len(body))
    stream.write(body)
    stream.flush()


def response(request_id: int | str | None, result: Any) -> dict[str, Any]:
    """A JSON-RPC success envelope."""
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def error_response(
    request_id: int | str | None, code: int, error: BridgeError
) -> dict[str, Any]:
    """A JSON-RPC failure envelope carrying the shared error contract.

    The contract travels in ``data`` rather than being flattened into
    ``message``, because the Host renders ``fix`` as its own line and would
    otherwise have to parse prose to find it.
    """
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": code, "message": error.message, "data": error.to_wire()},
    }
