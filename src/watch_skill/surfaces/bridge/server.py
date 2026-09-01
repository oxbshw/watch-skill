"""The Bridge server loop: one reader, a bounded pool, one writer.

Shape of the process, and why it is this shape:

*One reader thread* owns stdin. Framing state cannot be shared, so nothing
else is allowed to touch it.

*A bounded worker pool* runs handlers. Core operations block — SQLite reads,
ffmpeg, a verification child process — so a single-threaded loop would make
the Host's concurrency guarantee a lie: two requests in flight would run one
after the other, and a slow index read would stall a health check behind it.
The pool is bounded because unbounded is a memory bug wearing a feature's
name; past the ceiling the server refuses with ``bridge.too_many_in_flight``
rather than queueing without limit.

*One writer lock* owns stdout. Two threads interleaving frames would corrupt
the stream for every request, not just theirs.

Three properties are easier to state than to notice missing:

* **stdout is protocol only.** Core's own modules print. Anything they write
  to stdout during a request would land mid-frame, so stdout is swapped for
  stderr around every handler and restored after.
* **a request settles exactly once.** Deadline, cancellation and completion
  race by construction; the first one to claim the id wins and the others are
  dropped.
* **cancellation is *requested*, never asserted.** Python cannot safely stop a
  thread mid-syscall. The Host is told the work was asked to stop, which is
  true, rather than that it did not happen, which would not be.
"""
from __future__ import annotations

import contextlib
import json
import logging
import os
import sqlite3
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, BinaryIO

from watch_skill.surfaces.bridge import protocol
from watch_skill.surfaces.bridge.capabilities import capability_report
from watch_skill.surfaces.bridge.methods import HANDLERS
from watch_skill.surfaces.bridge.protocol import (
    INTERNAL_ERROR,
    INVALID_REQUEST,
    METHOD_NOT_FOUND,
    PARSE_ERROR,
    PROTOCOL_VERSION,
    PROTOCOL_VERSION_MIN,
    WATCH_ERROR,
    BridgeError,
    FrameError,
)
from watch_skill.surfaces.bridge.redact import safe_message, scrub
from watch_skill.surfaces.bridge.schemas import EXPECTED_SCHEMA_DIGESTS
from watch_skill.surfaces.bridge.wire import (
    BridgeLimits,
    HandshakeResult,
    PolicySummary,
)

_log = logging.getLogger("watch_skill.bridge")

#: Concurrent handlers. Small on purpose: Core operations are IO- and
#: CPU-heavy, and a deep pool converts a burst into thrashing rather than
#: throughput.
DEFAULT_MAX_IN_FLIGHT = 4

#: Default deadline for a request that does not carry its own.
DEFAULT_DEADLINE_MS = 30_000


@dataclass
class _InFlight:
    """One request the pool is working on."""

    request_id: int | str
    method: str
    correlation_id: str | None
    started_at: float
    cancelled: threading.Event = field(default_factory=threading.Event)


class BridgeServer:
    """Serves the Bridge protocol on a pair of binary streams.

    Streams are injected rather than reached for, which is what lets the tests
    drive a full conversation through pipes without spawning a process.
    """

    def __init__(
        self,
        stdin: BinaryIO,
        stdout: BinaryIO,
        *,
        max_in_flight: int = DEFAULT_MAX_IN_FLIGHT,
    ) -> None:
        self._stdin = stdin
        self._stdout = stdout
        self._max_in_flight = max_in_flight
        self._write_lock = threading.Lock()
        self._settled_lock = threading.Lock()
        self._settled: set[int | str] = set()
        self._in_flight: dict[int | str, _InFlight] = {}
        self._by_correlation: dict[str, _InFlight] = {}
        self._pool = ThreadPoolExecutor(
            max_workers=max_in_flight, thread_name_prefix="watch-bridge"
        )
        self._stopping = threading.Event()
        self._handshaken = False
        self._negotiated = PROTOCOL_VERSION

    # -- output --------------------------------------------------------------

    def _emit(self, payload: dict[str, Any]) -> None:
        """Write one frame under the writer lock, tolerating a closed pipe.

        A Host that exited takes stdout with it. That is a normal end, not a
        fault, so a broken pipe stops the server instead of raising into a
        worker where it would be reported as a Core defect.
        """
        with self._write_lock:
            try:
                protocol.write_frame(self._stdout, payload)
            except (BrokenPipeError, OSError, ValueError):
                self._stopping.set()

    def _settle(self, request_id: int | str, payload: dict[str, Any]) -> None:
        """Deliver a request's one and only outcome.

        Deadline, cancellation and completion all race to get here. Claiming
        the id under a lock is what keeps a cancelled-then-completed request
        from writing two responses for one id, which the Host reads as a
        protocol violation.
        """
        with self._settled_lock:
            if request_id in self._settled:
                return
            self._settled.add(request_id)
            entry = self._in_flight.pop(request_id, None)
        if entry is not None and entry.correlation_id:
            self._by_correlation.pop(entry.correlation_id, None)
        self._emit(payload)

    def _fail(
        self, request_id: int | str | None, code: int, error: BridgeError
    ) -> None:
        payload = protocol.error_response(request_id, code, error)
        if request_id is None:
            self._emit(payload)
        else:
            self._settle(request_id, payload)

    # -- connection-level methods -------------------------------------------

    def _handshake(self, params: dict[str, Any]) -> dict[str, Any]:
        """Negotiate the protocol and report what this Core actually is.

        Every value here is read from the running process: the version from
        the installed distribution, the digests from the wire models, the
        capabilities from Core's own probes. Nothing is a literal, because a
        literal is a claim that keeps being made after it stops being true.
        """
        from watch_skill import __version__

        requested = params.get("protocolVersion", PROTOCOL_VERSION)
        if not isinstance(requested, int) or isinstance(requested, bool):
            raise BridgeError(
                error="bridge.invalid_params",
                message='"protocolVersion" must be an integer.',
                fix="Send the protocol version this Host speaks.",
                details={"parameter": "protocolVersion"},
            )
        if requested < PROTOCOL_VERSION_MIN:
            raise BridgeError(
                error="bridge.protocol_mismatch",
                message=(
                    f"This Host speaks Bridge protocol {requested}; Watch Core "
                    f"supports {PROTOCOL_VERSION_MIN} to {PROTOCOL_VERSION}."
                ),
                fix="Update the Workspace, or install a Watch Core that speaks this version.",
                details={
                    "requested": requested,
                    "coreMin": PROTOCOL_VERSION_MIN,
                    "coreMax": PROTOCOL_VERSION,
                },
            )
        # Negotiate down, never up: answering with a version the Host did not
        # ask for is how one side ends up sending frames the other cannot read.
        self._negotiated = min(requested, PROTOCOL_VERSION)
        self._handshaken = True

        result = HandshakeResult(
            core_version=__version__,
            core_build=os.environ.get("WATCH_CORE_BUILD") or None,
            protocol_version=self._negotiated,
            protocol_min=PROTOCOL_VERSION_MIN,
            capabilities=capability_report(__version__),
            schema_digests=dict(EXPECTED_SCHEMA_DIGESTS),
            policy=self._policy(),
            limits=BridgeLimits(
                max_request_bytes=protocol.MAX_FRAME_BYTES,
                max_in_flight=self._max_in_flight,
                default_deadline_ms=DEFAULT_DEADLINE_MS,
            ),
        )
        return result.model_dump(by_alias=True)

    def _policy(self) -> PolicySummary:
        """The policy Core is actually enforcing, read from settings.

        Falls back to the strictest reading rather than the most permissive
        one: if the policy cannot be established, claiming `offlineOnly` and
        `memory off` understates what Core may do, and the failure mode of
        understating is a disabled feature rather than an unexpected egress.
        """
        offline = True
        cloud_opt_in = False
        memory_mode = "off"
        retention = "none"
        try:
            from watch_skill.config import get_settings

            settings = get_settings()
            offline = bool(getattr(settings, "offline", offline))
            cloud_opt_in = bool(getattr(settings, "cloud_perception_opt_in", cloud_opt_in))
            memory_mode = str(getattr(settings, "memory_mode", memory_mode))
            retention = str(getattr(settings, "default_retention_class", retention))
        except Exception as exc:  # noqa: BLE001 - handshake must not fail on this
            _log.warning("policy read failed, reporting the strictest: %s", type(exc).__name__)
        if memory_mode not in ("off", "session_only", "local_personal", "workspace_shared"):
            memory_mode = "off"
        return PolicySummary(
            offline_only=offline,
            cloud_perception_opt_in=cloud_opt_in,
            memory_mode=memory_mode,  # type: ignore[arg-type]
            default_retention_class=retention,
        )

    def _health(self, _params: dict[str, Any]) -> dict[str, Any]:
        """`watch.health` — what this Core is doing right now.

        Distinct from the handshake: the handshake is negotiation and is
        answered once, while this is observation and is answered whenever the
        Host asks. Diagnostics reads this rather than remembering the
        handshake, so a Core that has since degraded is not still rendered
        with the numbers it reported at connect.
        """
        from watch_skill import __version__

        return {
            "coreVersion": __version__,
            "protocolVersion": self._negotiated,
            "protocolMin": PROTOCOL_VERSION_MIN,
            "protocolMax": PROTOCOL_VERSION,
            "handshakeComplete": self._handshaken,
            "inFlight": len(self._in_flight),
            "maxInFlight": self._max_in_flight,
            "schemaDigests": dict(EXPECTED_SCHEMA_DIGESTS),
            "pid": os.getpid(),
            "uptimeSeconds": round(time.monotonic() - _STARTED_AT, 3),
        }

    # -- dispatch ------------------------------------------------------------

    def _run_handler(self, entry: _InFlight, params: dict[str, Any]) -> None:
        """Execute one handler with stdout muted, and settle its outcome."""
        handler = HANDLERS[entry.method]
        try:
            # Core's modules print. On this process stdout is the wire, so a
            # stray print would land inside a frame and desynchronise every
            # request behind it. Redirecting to stderr keeps the output —
            # where the Host reads it as diagnostics — and off the protocol.
            with contextlib.redirect_stdout(sys.stderr):
                result = handler(params)
        except BridgeError as error:
            self._fail(
                entry.request_id,
                WATCH_ERROR,
                BridgeError(
                    error=error.error,
                    message=error.message,
                    fix=error.fix,
                    details=scrub(error.details),
                    retryable=error.retryable,
                    correlation_id=entry.correlation_id,
                ),
            )
            return
        except Exception as exc:  # noqa: BLE001 - every Core failure is mapped
            self._fail(entry.request_id, WATCH_ERROR, self._map_exception(exc, entry))
            return

        if entry.cancelled.is_set():
            # The work finished after cancellation was requested. Reporting
            # the result anyway would be a response to a request the Host has
            # already given up on, and it has already been told the work may
            # have taken effect.
            return
        self._settle(entry.request_id, protocol.response(entry.request_id, result))

    def _map_exception(self, exc: Exception, entry: _InFlight) -> BridgeError:
        """Turn a Core exception into the shared error contract.

        Core's own :class:`~watch_skill.errors.WatchSkillError` already carries
        a code and a fix, and those are kept: the engine is better placed than
        the transport to say what to do about its own failure. Everything else
        becomes ``core.internal_error`` with the *type* but not the message,
        because an arbitrary exception string is exactly where a path or a
        credential leaks out of a process that was otherwise careful.
        """
        try:
            from watch_skill.errors import WatchSkillError
        except ImportError:  # pragma: no cover - Core is always importable here
            WatchSkillError = ()  # type: ignore[assignment]

        # A storage failure is not an engine defect, and saying "internal
        # error" about one sends the reader to the wrong place. SQLite raises
        # `OperationalError` for a database that cannot be opened, a directory
        # that cannot be written, a lock that never cleared, and a first-run
        # migration two processes reached at once — all of which are about this
        # machine and all of which have different next steps than a bug.
        if isinstance(exc, sqlite3.Error):
            _log.warning("%s hit storage: %s", entry.method, type(exc).__name__)
            return BridgeError(
                error="core.storage_unavailable",
                message=(
                    f"Watch Core could not read its index while running {entry.method}."
                ),
                fix=(
                    "Check the index with `watch-skill doctor`. A first run on a "
                    "cold machine can also lose this race with itself; retrying "
                    "once is safe, because a read changes nothing."
                ),
                details={"exception": type(exc).__name__},
                retryable=True,
                correlation_id=entry.correlation_id,
            )

        if isinstance(exc, WatchSkillError):  # type: ignore[arg-type]
            _log.warning("%s failed: %s", entry.method, exc.code)
            return BridgeError(
                error=exc.code,
                message=safe_message(exc.message),
                fix=safe_message(exc.fix or "See `watch-skill doctor` for the state of this machine."),
                details=scrub(exc.details),
                retryable=False,
                correlation_id=entry.correlation_id,
            )
        _log.exception("%s raised %s", entry.method, type(exc).__name__)
        return BridgeError(
            error="core.internal_error",
            message=f"Watch Core failed while running {entry.method}.",
            fix="Check the Watch Core log for the full trace; the Host log carries the correlation id.",
            details={"exception": type(exc).__name__},
            retryable=False,
            correlation_id=entry.correlation_id,
        )

    def _deadline_watch(self, entry: _InFlight, deadline_ms: float) -> None:
        """Settle a request that outlived its deadline.

        The error says the work *may still be running*, and that is not
        hedging: a deadline is evidence about elapsed time and nothing else.
        Telling the caller a side effect did not happen, on that evidence, is
        how a duplicate action gets dispatched.
        """
        if entry.cancelled.wait(deadline_ms / 1000.0):
            return
        self._fail(
            entry.request_id,
            WATCH_ERROR,
            BridgeError(
                error="bridge.deadline_exceeded",
                message=f'"{entry.method}" did not return within {int(deadline_ms)}ms.',
                fix="Inspect the operation receipt before retrying; work already dispatched may still complete.",
                details={"method": entry.method},
                retryable=False,
                correlation_id=entry.correlation_id,
            ),
        )

    def _handle_request(self, message: dict[str, Any]) -> None:
        request_id = message.get("id")
        method = message.get("method")
        params = message.get("params")
        correlation_id = message.get("correlationId")

        if not isinstance(method, str):
            self._fail(
                request_id if isinstance(request_id, (int, str)) else None,
                INVALID_REQUEST,
                BridgeError(
                    error="bridge.invalid_request",
                    message="A request must carry a string method.",
                    fix="Send a JSON-RPC 2.0 request with a method name.",
                ),
            )
            return
        if params is None:
            params = {}
        if not isinstance(params, dict):
            self._fail(
                request_id if isinstance(request_id, (int, str)) else None,
                INVALID_REQUEST,
                BridgeError(
                    error="bridge.invalid_request",
                    message="Request params must be an object.",
                    fix="Send params as a JSON object, not an array or a scalar.",
                ),
            )
            return

        # Notifications carry no id and get no response, by definition.
        if request_id is None:
            self._handle_notification(method, params)
            return

        entry = _InFlight(
            request_id=request_id,
            method=method,
            correlation_id=str(correlation_id) if correlation_id else None,
            started_at=time.monotonic(),
        )

        # Connection-level methods answer on the reader thread. They are
        # bounded and cheap, and running them in the pool would let a full
        # pool make the connection itself unobservable.
        if method == "watch.handshake":
            self._answer_inline(entry, self._handshake, params)
            return
        if method == "watch.health":
            self._answer_inline(entry, self._health, params)
            return
        if method == "watch.shutdown":
            self._settle(request_id, protocol.response(request_id, {"stopping": True}))
            self._stopping.set()
            return

        if method not in HANDLERS:
            self._fail(
                request_id,
                METHOD_NOT_FOUND,
                BridgeError(
                    error="bridge.method_not_found",
                    message=f'Watch Core has no method "{method}".',
                    fix="Check the Workspace and Watch Core versions match in Settings -> Watch.",
                    details={"method": method},
                    correlation_id=entry.correlation_id,
                ),
            )
            return

        if not self._handshaken:
            self._fail(
                request_id,
                INVALID_REQUEST,
                BridgeError(
                    error="bridge.handshake_required",
                    message=f'"{method}" was called before the handshake.',
                    fix="Call watch.handshake first so both sides agree on the protocol.",
                    details={"method": method},
                    correlation_id=entry.correlation_id,
                ),
            )
            return

        with self._settled_lock:
            if len(self._in_flight) >= self._max_in_flight:
                over_capacity = True
            else:
                over_capacity = False
                self._in_flight[request_id] = entry
        if over_capacity:
            self._fail(
                request_id,
                WATCH_ERROR,
                BridgeError(
                    error="bridge.too_many_in_flight",
                    message=f"Watch Core is already running {self._max_in_flight} requests.",
                    fix="Wait for a request to finish, then retry.",
                    details={"maxInFlight": self._max_in_flight},
                    retryable=True,
                    correlation_id=entry.correlation_id,
                ),
            )
            return
        if entry.correlation_id:
            self._by_correlation[entry.correlation_id] = entry

        deadline_ms = message.get("deadlineMs") or params.get("deadlineMs") or DEFAULT_DEADLINE_MS
        try:
            deadline_ms = float(deadline_ms)
        except (TypeError, ValueError):
            deadline_ms = float(DEFAULT_DEADLINE_MS)

        threading.Thread(
            target=self._deadline_watch,
            args=(entry, deadline_ms),
            daemon=True,
            name=f"watch-bridge-deadline-{request_id}",
        ).start()
        self._pool.submit(self._run_handler, entry, params)

    def _answer_inline(self, entry: _InFlight, handler: Any, params: dict[str, Any]) -> None:
        try:
            with contextlib.redirect_stdout(sys.stderr):
                result = handler(params)
        except BridgeError as error:
            self._fail(entry.request_id, WATCH_ERROR, error)
            return
        except Exception as exc:  # noqa: BLE001
            self._fail(entry.request_id, INTERNAL_ERROR, self._map_exception(exc, entry))
            return
        self._settle(entry.request_id, protocol.response(entry.request_id, result))

    def _handle_notification(self, method: str, params: dict[str, Any]) -> None:
        if method == "watch.cancel":
            correlation_id = params.get("correlationId")
            entry = (
                self._by_correlation.get(str(correlation_id))
                if correlation_id is not None
                else None
            )
            if entry is None:
                # Cancelling something already finished is normal, not an
                # error: the Host aborted while the response was in flight.
                return
            entry.cancelled.set()
            self._fail(
                entry.request_id,
                WATCH_ERROR,
                BridgeError(
                    error="bridge.cancel_requested",
                    message=f'Cancellation was requested for "{entry.method}".',
                    fix="Check the operation receipt to see whether the work had already taken effect.",
                    details={"method": entry.method},
                    retryable=False,
                    correlation_id=entry.correlation_id,
                ),
            )
            return
        if method == "watch.shutdown":
            self._stopping.set()
            return
        _log.debug("ignoring unknown notification %s", method)

    # -- loop ----------------------------------------------------------------

    def run(self) -> int:
        """Read frames until EOF or shutdown. Returns the process exit code."""
        _log.info(
            "bridge listening: protocol %d-%d, %d workers",
            PROTOCOL_VERSION_MIN,
            PROTOCOL_VERSION,
            self._max_in_flight,
        )
        exit_code = 0
        try:
            while not self._stopping.is_set():
                try:
                    frame = protocol.read_frame(self._stdin)
                except FrameError as exc:
                    # An unframeable stream cannot be resynchronised by
                    # guessing where the next frame starts, so the connection
                    # ends loudly rather than silently dropping requests.
                    _log.error("protocol violation: %s", exc)
                    self._fail(
                        None,
                        PARSE_ERROR,
                        BridgeError(
                            error="bridge.protocol_violation",
                            message=f"The Host sent an unreadable frame: {exc}",
                            fix="Update the Workspace and Watch Core so their Bridge versions match.",
                        ),
                    )
                    exit_code = 2
                    break
                if frame is None:
                    _log.info("stdin closed; shutting down")
                    break
                self._dispatch_frame(frame)
        except KeyboardInterrupt:  # pragma: no cover - operator interrupt
            _log.info("interrupted; shutting down")
        finally:
            self.shutdown()
        return exit_code

    def _dispatch_frame(self, frame: bytes) -> None:
        try:
            message = json.loads(frame.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self._fail(
                None,
                PARSE_ERROR,
                BridgeError(
                    error="bridge.parse_error",
                    message=f"A frame was not valid UTF-8 JSON: {type(exc).__name__}",
                    fix="Send each request as one UTF-8 JSON object in a Content-Length frame.",
                ),
            )
            return
        if not isinstance(message, dict):
            self._fail(
                None,
                INVALID_REQUEST,
                BridgeError(
                    error="bridge.invalid_request",
                    message="A frame must contain a JSON object.",
                    fix="Send a JSON-RPC 2.0 request object.",
                ),
            )
            return
        self._handle_request(message)

    def shutdown(self) -> None:
        """Stop accepting work and let running handlers finish.

        Handlers are waited for rather than abandoned. A verification run that
        is halfway through writing its evidence bundle is the one thing whose
        loss cannot be reconstructed afterwards, so it gets to finish.
        Repeated calls are harmless — the Host sends shutdown and then closes
        stdin, and both arrive here.
        """
        self._stopping.set()
        self._pool.shutdown(wait=True, cancel_futures=True)
        try:
            from watch_skill.live import stop_all

            stop_all()
        except Exception as exc:  # noqa: BLE001 - shutdown must not raise
            _log.warning("live shutdown reported %s", type(exc).__name__)


_STARTED_AT = time.monotonic()


def serve(*, max_in_flight: int = DEFAULT_MAX_IN_FLIGHT) -> int:
    """Run the Bridge on this process's stdin and stdout.

    The first thing this does is take stdout away from everything else. Core's
    logging defaults to stderr, but a library that prints, or a warning routed
    to stdout, would corrupt the frame stream — so ``sys.stdout`` is rebound to
    stderr for the whole process and the real handle is kept privately here.
    """
    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer
    sys.stdout = sys.stderr  # type: ignore[assignment]

    logging.basicConfig(
        stream=sys.stderr,
        level=os.environ.get("WATCH_BRIDGE_LOG", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    server = BridgeServer(stdin, stdout, max_in_flight=max_in_flight)
    return server.run()


__all__ = ["BridgeServer", "DEFAULT_DEADLINE_MS", "DEFAULT_MAX_IN_FLIGHT", "serve"]
