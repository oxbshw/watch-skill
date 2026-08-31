"""The Bridge surface: framing, negotiation, concurrency, and honesty.

The framing and dispatch tests drive :class:`BridgeServer` over in-memory
pipes, which is fast and covers the protocol. The process tests spawn a real
``watch-skill bridge`` child, because the properties that matter most at the
end — stdout carries frames and nothing else, EOF is a clean shutdown, no
orphan is left behind — are properties of a *process* and cannot be observed
from inside one.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from io import BytesIO
from typing import Any

import pytest

from watch_skill.surfaces.bridge import protocol
from watch_skill.surfaces.bridge.protocol import FrameError
from watch_skill.surfaces.bridge.schemas import EXPECTED_SCHEMA_DIGESTS, manifest
from watch_skill.surfaces.bridge.server import BridgeServer


def frame(payload: dict[str, Any]) -> bytes:
    body = json.dumps(payload).encode("utf-8")
    return b"Content-Length: %d\r\n\r\n" % len(body) + body


def drain(raw: bytes) -> list[dict[str, Any]]:
    """Decode every frame in a captured stdout buffer."""
    messages: list[dict[str, Any]] = []
    stream = BytesIO(raw)
    while True:
        body = protocol.read_frame(stream)
        if body is None:
            return messages
        messages.append(json.loads(body))


def converse(*requests: dict[str, Any], max_in_flight: int = 4) -> list[dict[str, Any]]:
    """Run a whole conversation against a server and return its replies."""
    stdin = BytesIO(b"".join(frame(request) for request in requests))
    stdout = BytesIO()
    BridgeServer(stdin, stdout, max_in_flight=max_in_flight).run()
    return drain(stdout.getvalue())


HANDSHAKE = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "watch.handshake",
    "params": {"protocolVersion": 1},
}


# -- framing -----------------------------------------------------------------


class TestFraming:
    def test_reads_a_frame_split_across_reads(self) -> None:
        """A frame arriving in pieces is still one frame."""

        class Trickle(BytesIO):
            def read(self, size: int = -1) -> bytes:  # noqa: D102
                return super().read(1 if size and size > 1 else size)

        payload = {"jsonrpc": "2.0", "id": 1, "method": "watch.health"}
        assert json.loads(protocol.read_frame(Trickle(frame(payload)))) == payload

    def test_end_of_stream_is_not_an_error(self) -> None:
        """EOF between frames is how a Host says goodbye, not a fault."""
        assert protocol.read_frame(BytesIO(b"")) is None

    def test_truncated_body_is_end_of_stream(self) -> None:
        """A parent killed mid-write leaves a partial frame; that is EOF."""
        assert protocol.read_frame(BytesIO(b"Content-Length: 99\r\n\r\n{")) is None

    def test_missing_content_length_is_refused(self) -> None:
        with pytest.raises(FrameError, match="Content-Length"):
            protocol.read_frame(BytesIO(b"X-Nonsense: 1\r\n\r\n{}"))

    def test_oversized_frame_is_refused_before_allocation(self) -> None:
        """No further bytes can make an over-limit frame legitimate."""
        declared = protocol.MAX_FRAME_BYTES + 1
        with pytest.raises(FrameError, match="exceeds"):
            protocol.read_frame(BytesIO(b"Content-Length: %d\r\n\r\n" % declared))

    def test_unterminated_header_is_refused(self) -> None:
        with pytest.raises(FrameError, match="header"):
            protocol.read_frame(BytesIO(b"Content-Length: 1" + b" " * 9000))


# -- handshake ---------------------------------------------------------------


class TestHandshake:
    def test_reports_the_running_core_not_a_literal(self) -> None:
        from watch_skill import __version__

        result = converse(HANDSHAKE)[0]["result"]
        assert result["coreVersion"] == __version__
        assert result["protocolVersion"] == 1
        assert result["protocolMin"] == 1

    def test_digests_are_computed_from_the_models(self) -> None:
        """The wire digests and the generated manifest are one artifact."""
        result = converse(HANDSHAKE)[0]["result"]
        assert result["schemaDigests"] == EXPECTED_SCHEMA_DIGESTS
        generated = {name: entry["digest"] for name, entry in manifest()["families"].items()}
        assert result["schemaDigests"] == generated

    def test_capabilities_come_from_probes_not_a_static_list(self) -> None:
        """Nothing is reported machine_tested: no real request has been made."""
        result = converse(HANDSHAKE)[0]["result"]
        statuses = {c["capabilityId"]: c["status"] for c in result["capabilities"]}
        assert statuses, "the handshake must report capabilities"
        assert "machine_tested" not in statuses.values()

    def test_a_capability_with_no_bridge_operation_says_unavailable(self) -> None:
        """The contract declares browser methods; this Core cannot serve them."""
        result = converse(HANDSHAKE)[0]["result"]
        statuses = {c["capabilityId"]: c["status"] for c in result["capabilities"]}
        assert statuses["watch.browser.observe"] == "unavailable"
        assert statuses["watch.evidence.resolve"] == "unavailable"

    def test_an_older_host_protocol_is_refused_with_both_versions(self) -> None:
        reply = converse({**HANDSHAKE, "params": {"protocolVersion": 0}})[0]
        assert reply["error"]["data"]["error"] == "bridge.protocol_mismatch"
        assert reply["error"]["data"]["details"]["coreMax"] == 1

    def test_work_before_the_handshake_is_refused(self) -> None:
        """Negotiation first: a request answered before it is a guess."""
        reply = converse(
            {"jsonrpc": "2.0", "id": 1, "method": "watch.library.list", "params": {}}
        )[0]
        assert reply["error"]["data"]["error"] == "bridge.handshake_required"


# -- dispatch ----------------------------------------------------------------


class TestDispatch:
    def test_unknown_method_is_method_not_found(self) -> None:
        reply = converse(HANDSHAKE, {"jsonrpc": "2.0", "id": 2, "method": "watch.nope"})[1]
        assert reply["error"]["code"] == protocol.METHOD_NOT_FOUND
        assert reply["error"]["data"]["error"] == "bridge.method_not_found"

    def test_a_declared_method_with_no_core_operation_is_unavailable(self) -> None:
        """Distinct from method_not_found: the Host was right to call it."""
        reply = converse(
            HANDSHAKE,
            {"jsonrpc": "2.0", "id": 2, "method": "watch.evidence.get",
             "params": {"evidenceId": "e_1"}},
        )[1]
        assert reply["error"]["data"]["error"] == "bridge.capability_unavailable"

    def test_library_list_reaches_the_real_index(self) -> None:
        """An empty index answers zero rows — never a plausible-looking one."""
        reply = converse(HANDSHAKE, {
            "jsonrpc": "2.0", "id": 2, "method": "watch.library.list", "params": {"limit": 5},
        })[1]
        assert reply["result"] == {"sources": [], "total": 0, "truncated": False}

    def test_invalid_params_name_the_parameter(self) -> None:
        reply = converse(HANDSHAKE, {
            "jsonrpc": "2.0", "id": 2, "method": "watch.library.search", "params": {},
        })[1]
        assert reply["error"]["data"]["error"] == "bridge.invalid_params"
        assert reply["error"]["data"]["details"]["parameter"] == "query"

    def test_a_bad_limit_is_refused_rather_than_clamped(self) -> None:
        """Clamping would let a caller believe it saw everything."""
        reply = converse(HANDSHAKE, {
            "jsonrpc": "2.0", "id": 2, "method": "watch.library.list",
            "params": {"limit": 10_000},
        })[1]
        assert reply["error"]["data"]["error"] == "bridge.invalid_params"

    def test_malformed_json_does_not_end_the_connection(self) -> None:
        """One bad frame must not take the requests behind it down."""
        stdin = BytesIO(
            frame(HANDSHAKE)
            + b"Content-Length: 7\r\n\r\nnotjson"
            + frame({"jsonrpc": "2.0", "id": 3, "method": "watch.health"})
        )
        stdout = BytesIO()
        BridgeServer(stdin, stdout).run()
        replies = drain(stdout.getvalue())
        assert replies[1]["error"]["data"]["error"] == "bridge.parse_error"
        assert replies[2]["id"] == 3, "the request after the bad frame is still served"

    def test_params_must_be_an_object(self) -> None:
        reply = converse(HANDSHAKE, {
            "jsonrpc": "2.0", "id": 2, "method": "watch.health", "params": [1, 2],
        })[1]
        assert reply["error"]["data"]["error"] == "bridge.invalid_request"

    def test_every_error_carries_a_fix(self) -> None:
        """A failure the reader cannot act on is not finished being reported."""
        replies = converse(
            HANDSHAKE,
            {"jsonrpc": "2.0", "id": 2, "method": "watch.nope"},
            {"jsonrpc": "2.0", "id": 3, "method": "watch.evidence.get", "params": {}},
            {"jsonrpc": "2.0", "id": 4, "method": "watch.library.search", "params": {}},
        )
        for reply in replies[1:]:
            fix = reply["error"]["data"]["fix"]
            assert isinstance(fix, str) and fix.strip()


# -- health ------------------------------------------------------------------


class TestHealth:
    def test_health_is_observed_not_remembered(self) -> None:
        result = converse(HANDSHAKE, {"jsonrpc": "2.0", "id": 2, "method": "watch.health"})[1]["result"]
        assert result["handshakeComplete"] is True
        assert result["pid"] == os.getpid()
        assert result["protocolMax"] == 1
        assert result["schemaDigests"] == EXPECTED_SCHEMA_DIGESTS

    def test_health_before_handshake_reports_that_honestly(self) -> None:
        result = converse({"jsonrpc": "2.0", "id": 1, "method": "watch.health"})[0]["result"]
        assert result["handshakeComplete"] is False


# -- redaction ---------------------------------------------------------------


class TestRedaction:
    def test_secret_named_fields_never_reach_the_wire(self) -> None:
        from watch_skill.surfaces.bridge.redact import scrub

        scrubbed = scrub({"apiKey": "sk-live-123", "OPENROUTER_API_KEY": "sk-2", "keep": "fine"})
        assert scrubbed == {
            "apiKey": "[redacted]",
            "OPENROUTER_API_KEY": "[redacted]",
            "keep": "fine",
        }

    def test_an_absolute_path_is_rewritten_not_forwarded(self) -> None:
        from watch_skill.surfaces.bridge.redact import logical_path

        for raw in (r"C:\Users\someone\notes.txt", "/home/someone/notes.txt"):
            assert "someone" not in logical_path(raw)

    def test_a_foreign_platform_path_is_hidden_whole(self) -> None:
        """The case that leaked, and the reason the check is `isabs`.

        A Bridge sees both spellings whatever it runs on: a Windows path in a
        message read on Linux, a POSIX path read on Windows. The foreign one is
        not absolute here, so `resolve()` used to anchor it to the working
        directory — after which it matched the `<home>` root, whose prefix was
        stripped while the username survived in the tail.
        """
        from watch_skill.surfaces.bridge.redact import logical_path

        foreign = "/home/someone/notes.txt" if os.name == "nt" else r"C:\Users\someone\notes.txt"
        assert logical_path(foreign) == "<path>"
        assert "someone" not in logical_path(foreign)

    def test_a_url_scheme_is_not_a_drive_letter(self) -> None:
        """`https://x` has a colon and a slash where `C:/x` does."""
        from watch_skill.surfaces.bridge.redact import logical_path

        assert logical_path("https://example.com/a") == "https://example.com/a"

    def test_scrub_survives_a_cycle(self) -> None:
        from watch_skill.surfaces.bridge.redact import scrub

        node: dict[str, Any] = {}
        node["self"] = node
        assert scrub(node) is not None  # a marker, not a RecursionError

    def test_a_core_exception_message_does_not_reach_the_host(self) -> None:
        """Arbitrary exception text is where a path or a key leaks out."""
        from watch_skill.surfaces.bridge import methods

        def explode(_params: dict[str, Any]) -> Any:
            raise RuntimeError(r"failed reading C:\Users\someone\.credentials.yaml")

        methods.HANDLERS["watch.test.explode"] = explode
        try:
            reply = converse(
                HANDSHAKE, {"jsonrpc": "2.0", "id": 2, "method": "watch.test.explode"}
            )[1]
        finally:
            del methods.HANDLERS["watch.test.explode"]

        data = reply["error"]["data"]
        assert data["error"] == "core.internal_error"
        assert data["details"] == {"exception": "RuntimeError"}
        assert "someone" not in json.dumps(reply)
        assert "credentials" not in json.dumps(reply)


# -- concurrency, deadlines, cancellation ------------------------------------


class TestConcurrency:
    def test_a_slow_request_does_not_block_a_fast_one(self) -> None:
        """Serialised handlers would make the concurrency contract a lie.

        Both sides are test handlers. The second request used to be a real
        `watch.library.list`, which reads as a better test and is a worse one:
        its first call pays a cold import of the index layer, and on a Windows
        runner that import outlasted the slow handler's sleep. The failure was
        real and it was not the server's — "this Core call is fast" was an
        assumption about import cost, not about concurrency.

        Ordering is now established by the handlers themselves rather than by
        elapsed time: the quick one waits for the slow one to be *inside* its
        handler before it returns, so overlap is what the assertion rests on.
        """
        from watch_skill.surfaces.bridge import methods

        entered = threading.Event()
        release = threading.Event()

        def slow(_params: dict[str, Any]) -> Any:
            entered.set()
            # Held until the quick request has been answered, so a server that
            # ran them one after another cannot pass by being fast enough.
            release.wait(10.0)
            return {"slow": True}

        def quick(_params: dict[str, Any]) -> Any:
            # Proof of overlap: this only returns once the slow handler is
            # running, and it runs while that one is still held.
            assert entered.wait(10.0), "the slow handler never started"
            release.set()
            return {"quick": True}

        methods.HANDLERS["watch.test.slow"] = slow
        methods.HANDLERS["watch.test.quick"] = quick
        try:
            stdin = BytesIO(
                frame(HANDSHAKE)
                + frame({"jsonrpc": "2.0", "id": 2, "method": "watch.test.slow"})
                + frame({"jsonrpc": "2.0", "id": 3, "method": "watch.test.quick"})
            )
            stdout = BytesIO()
            BridgeServer(stdin, stdout).run()
        finally:
            release.set()
            del methods.HANDLERS["watch.test.slow"]
            del methods.HANDLERS["watch.test.quick"]

        replies = {reply["id"]: reply for reply in drain(stdout.getvalue())}
        assert entered.is_set()
        # Both completed, which on a serialised server is impossible: the slow
        # handler would still be waiting for a release nobody could send.
        assert replies[2]["result"] == {"slow": True}
        assert replies[3]["result"] == {"quick": True}

    def test_beyond_the_ceiling_the_bridge_refuses_rather_than_queues(self) -> None:
        """Unbounded queueing is a memory bug wearing a feature's name."""
        from watch_skill.surfaces.bridge import methods

        release = threading.Event()

        def block(_params: dict[str, Any]) -> Any:
            release.wait(3.0)
            return {}

        methods.HANDLERS["watch.test.block"] = block
        try:
            stdin = BytesIO(
                frame(HANDSHAKE)
                + b"".join(
                    frame({"jsonrpc": "2.0", "id": n, "method": "watch.test.block"})
                    for n in (2, 3, 4)
                )
            )
            stdout = BytesIO()
            server = BridgeServer(stdin, stdout, max_in_flight=1)
            thread = threading.Thread(target=server.run)
            thread.start()
            thread.join(timeout=10)
            release.set()
        finally:
            del methods.HANDLERS["watch.test.block"]

        codes = [
            reply.get("error", {}).get("data", {}).get("error")
            for reply in drain(stdout.getvalue())
        ]
        assert "bridge.too_many_in_flight" in codes

    def test_a_deadline_does_not_claim_the_work_did_not_happen(self) -> None:
        """A deadline is evidence about elapsed time and nothing else."""
        from watch_skill.surfaces.bridge import methods

        def slow(_params: dict[str, Any]) -> Any:
            time.sleep(1.5)
            return {}

        methods.HANDLERS["watch.test.slow2"] = slow
        try:
            reply = converse(HANDSHAKE, {
                "jsonrpc": "2.0", "id": 2, "method": "watch.test.slow2", "deadlineMs": 120,
            })[1]
        finally:
            del methods.HANDLERS["watch.test.slow2"]

        data = reply["error"]["data"]
        assert data["error"] == "bridge.deadline_exceeded"
        assert "may still complete" in data["fix"]

    def test_cancellation_is_requested_never_asserted(self) -> None:
        """Python cannot stop a thread mid-syscall, and the wording says so."""
        from watch_skill.surfaces.bridge import methods

        entered = threading.Event()

        def slow(_params: dict[str, Any]) -> Any:
            entered.set()
            time.sleep(1.0)
            return {"finished": True}

        methods.HANDLERS["watch.test.cancel"] = slow
        try:
            stdin = BytesIO(
                frame(HANDSHAKE)
                + frame({
                    "jsonrpc": "2.0", "id": 2, "method": "watch.test.cancel",
                    "correlationId": "cor_1",
                })
                + frame({
                    "jsonrpc": "2.0", "method": "watch.cancel",
                    "params": {"correlationId": "cor_1"},
                })
            )
            stdout = BytesIO()
            BridgeServer(stdin, stdout).run()
        finally:
            del methods.HANDLERS["watch.test.cancel"]

        replies = drain(stdout.getvalue())
        cancelled = [r for r in replies if r.get("id") == 2]
        assert len(cancelled) == 1, "a request settles exactly once"
        assert cancelled[0]["error"]["data"]["error"] == "bridge.cancel_requested"

    def test_cancelling_an_unknown_correlation_is_not_an_error(self) -> None:
        """The Host aborts while a response is in flight; that is normal."""
        replies = converse(HANDSHAKE, {
            "jsonrpc": "2.0", "method": "watch.cancel", "params": {"correlationId": "gone"},
        })
        assert len(replies) == 1, "a notification gets no reply"


# -- the real process --------------------------------------------------------


def _spawn_bridge() -> subprocess.Popen[bytes]:
    return subprocess.Popen(
        [sys.executable, "-m", "watch_skill.surfaces.cli.main", "bridge"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def _exchange(process: subprocess.Popen[bytes], payload: dict[str, Any]) -> dict[str, Any]:
    assert process.stdin is not None and process.stdout is not None
    process.stdin.write(frame(payload))
    process.stdin.flush()
    body = protocol.read_frame(process.stdout)
    assert body is not None, "the Bridge closed the stream"
    return json.loads(body)


@pytest.mark.timeout(120)
class TestRealProcess:
    def test_a_spawned_core_handshakes_over_its_own_stdio(self) -> None:
        from watch_skill import __version__

        process = _spawn_bridge()
        try:
            reply = _exchange(process, HANDSHAKE)
            assert reply["result"]["coreVersion"] == __version__
        finally:
            assert process.stdin is not None
            process.stdin.close()
            process.wait(timeout=30)

    def test_stdout_carries_frames_and_nothing_else(self) -> None:
        """One stray print corrupts every request behind it."""
        process = _spawn_bridge()
        try:
            _exchange(process, HANDSHAKE)
            # `doctor` and the capture matrix both print in other surfaces; a
            # second handshake re-runs them, so any leakage lands here.
            reply = _exchange(process, {**HANDSHAKE, "id": 2})
            assert reply["id"] == 2
        finally:
            assert process.stdin is not None
            process.stdin.close()
            process.wait(timeout=30)

    def test_closing_stdin_shuts_down_cleanly_and_leaves_no_child(self) -> None:
        """EOF is how a Host says it is done; it is not a fault."""
        process = _spawn_bridge()
        _exchange(process, HANDSHAKE)
        assert process.stdin is not None
        process.stdin.close()
        assert process.wait(timeout=30) == 0

    def test_operational_logging_goes_to_stderr(self) -> None:
        process = _spawn_bridge()
        try:
            _exchange(process, HANDSHAKE)
        finally:
            assert process.stdin is not None
            process.stdin.close()
            process.wait(timeout=30)
        assert process.stderr is not None
        assert b"bridge listening" in process.stderr.read()
