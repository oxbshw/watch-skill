"""Pillar 7 — webhook delivery: signed, retried, never fatal.

A real local HTTP receiver, not a mock transport: the signature is
verified by recomputing the HMAC over the exact bytes received.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from watch_skill.loop.webhook import deliver_event, webhook_on_event

EVENT = {
    "monitor_id": "abc123", "check": 0, "source": "screen:",
    "condition": "an error screen", "detections": [
        {"timestamp": 0.46, "severity": "critical", "description": "ERROR 502"}
    ],
    "at": "2026-07-11T12:00:00+00:00",
}


class _Receiver(BaseHTTPRequestHandler):
    fail_first = 0  # class-level knob per test

    def do_POST(self):  # noqa: N802 — http.server API
        body = self.rfile.read(int(self.headers["Content-Length"]))
        record = {
            "body": body,
            "signature": self.headers.get("X-WatchSkill-Signature"),
            "event_type": self.headers.get("X-WatchSkill-Event"),
        }
        self.server.received.append(record)  # type: ignore[attr-defined]
        if type(self).fail_first > 0:
            type(self).fail_first -= 1
            self.send_response(500)
        else:
            self.send_response(200)
        self.end_headers()

    def log_message(self, *args):  # keep test output clean
        pass


@pytest.fixture()
def receiver():
    server = HTTPServer(("127.0.0.1", 0), _Receiver)
    server.received = []  # type: ignore[attr-defined]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    _Receiver.fail_first = 0
    yield server
    server.shutdown()


def _url(server) -> str:
    return f"http://127.0.0.1:{server.server_address[1]}/hook"


def test_delivery_carries_verifiable_signature(receiver) -> None:
    ok = deliver_event(EVENT, _url(receiver), secret="s3cret", _sleep=lambda _: None)
    assert ok
    record = receiver.received[0]
    assert record["event_type"] == "monitor.detection"
    expected = hmac.new(b"s3cret", record["body"], hashlib.sha256).hexdigest()
    assert record["signature"] == f"sha256={expected}"
    assert json.loads(record["body"])["condition"] == "an error screen"


def test_no_secret_means_no_signature_header(receiver) -> None:
    assert deliver_event(EVENT, _url(receiver), secret=None, _sleep=lambda _: None)
    assert receiver.received[0]["signature"] is None


def test_retry_survives_a_transient_500(receiver) -> None:
    _Receiver.fail_first = 1
    ok = deliver_event(EVENT, _url(receiver), _sleep=lambda _: None)
    assert ok
    assert len(receiver.received) == 2, "one failed attempt + one success"


def test_dead_receiver_fails_quietly_not_fatally() -> None:
    ok = deliver_event(EVENT, "http://127.0.0.1:9/hook", _sleep=lambda _: None)
    assert ok is False  # returned, not raised


def test_on_event_factory_respects_configuration(
    receiver, monkeypatch: pytest.MonkeyPatch
) -> None:
    from watch_skill.config import reset_settings

    assert webhook_on_event(None) is None, "no URL configured -> no callback"

    monkeypatch.setenv("WATCHSKILL_WEBHOOK_URL", _url(receiver))
    monkeypatch.setenv("WATCHSKILL_WEBHOOK_SECRET", "hush")
    reset_settings()
    try:
        chained_calls: list[dict] = []
        send = webhook_on_event(chained_calls.append)
        assert send is not None
        send(EVENT)
        assert chained_calls == [EVENT], "explicit callback still runs"
        assert len(receiver.received) == 1
        expected = hmac.new(b"hush", receiver.received[0]["body"], hashlib.sha256).hexdigest()
        assert receiver.received[0]["signature"] == f"sha256={expected}"
    finally:
        monkeypatch.delenv("WATCHSKILL_WEBHOOK_URL")
        monkeypatch.delenv("WATCHSKILL_WEBHOOK_SECRET")
        reset_settings()
