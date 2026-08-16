"""A local host for the workspace, serving the same canonical functions.

Two audiences. A developer who wants to see the UI without wiring up an MCP
client, and the Playwright proof, which needs to drive the real interface
against real evidence rather than a mock.

It is deliberately the *same* functions the MCP tool calls — `workspace.
snapshot`, `workspace.delta`, the existing action and observer APIs. If this
host and the MCP host could disagree about what is true, the proof run
through this one would say nothing about the other.

Loopback only, and it says so. This serves session evidence with no
authentication, which is fine for a local development host and would not be
fine for anything else.
"""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlsplit


def _bundle() -> str:
    from watch_skill.surfaces.mcp.workspace_app import workspace_html

    html = workspace_html()
    # The standalone build reads its API origin from this tag rather than
    # having one compiled in, so the bundle shipped inside the Python package
    # contains no origin at all and cannot phone anywhere by default.
    marker = "<head>"
    tag = '<head><meta name="watch-skill-api" content="">'
    return html.replace(marker, tag, 1) if marker in html else html


class _Handler(BaseHTTPRequestHandler):
    server_version = "WatchSkillDevHost/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, *args: Any) -> None:  # noqa: A003
        """Quiet. A request log per frame poll buries everything else."""

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        # The same restrictions the MCP resource declares, so what is proved
        # here is proved under the policy the real thing runs under.
        self.send_header("Content-Security-Policy", _csp())
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, payload: Any) -> None:
        self._send(status, json.dumps(payload, default=str).encode("utf-8"),
                   "application/json")

    def do_GET(self) -> None:  # noqa: N802
        parts = urlsplit(self.path)
        query = parse_qs(parts.query)
        session = (query.get("session") or [None])[0]
        try:
            if parts.path in ("/", "/index.html"):
                self._send(200, _bundle().encode("utf-8"),
                           "text/html; charset=utf-8")
            elif parts.path == "/api/snapshot":
                from watch_skill import workspace

                self._json(200, workspace.snapshot(session))
            elif parts.path == "/api/delta":
                from watch_skill import workspace

                after = int((query.get("after_seq") or ["0"])[0])
                self._json(200, workspace.delta(str(session), after))
            elif parts.path == "/api/timeline":
                from watch_skill import workspace

                self._json(200, workspace.timeline(str(session)))
            elif parts.path == "/api/frame":
                self._frame(str(session))
            else:
                self._json(404, {"error": "not_found", "path": parts.path})
        except Exception as exc:  # noqa: BLE001 - a dev host reports, never dies
            self._json(500, {"error": type(exc).__name__, "message": str(exc)})

    def _frame(self, session_id: str) -> None:
        """The newest buffered frame, as bytes.

        Resolved through the buffer by session, so a request cannot name a
        path and cannot reach another session's media.
        """
        from watch_skill.live import buffer as buf

        newest = buf.newest_frame_media_ts(session_id)
        if newest is None:
            self._json(404, {"error": "no_frame"})
            return
        frames = buf.frames_between(session_id, max(0.0, newest - 1.0),
                                    newest + 0.001, limit=4)
        for segment in reversed(frames):
            if segment.path.is_file():
                self._send(200, segment.path.read_bytes(), "image/jpeg")
                return
        self._json(404, {"error": "no_frame"})

    def do_POST(self) -> None:  # noqa: N802
        parts = urlsplit(self.path)
        length = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(min(length, 256_000)).decode("utf-8", "replace")
        try:
            body = json.loads(raw or "{}")
        except ValueError:
            self._json(400, {"error": "malformed_json"})
            return
        if parts.path != "/api/call":
            self._json(404, {"error": "not_found"})
            return
        try:
            self._json(200, _dispatch(str(body.get("tool", "")),
                                      dict(body.get("arguments") or {})))
        except Exception as exc:  # noqa: BLE001
            self._json(400, {"error": type(exc).__name__, "message": str(exc)})


def _csp() -> str:
    from watch_skill.surfaces.mcp.workspace_app import CONTENT_SECURITY_POLICY

    # The dev host serves its own API, so connect-src and img-src have to
    # permit 'self' where the embedded resource permits neither. Stated as a
    # deliberate difference rather than by relaxing the shared constant.
    return (CONTENT_SECURITY_POLICY
            .replace("connect-src 'none'", "connect-src 'self'")
            .replace("default-src 'none'", "default-src 'none'"))


def _dispatch(tool: str, args: dict[str, Any]) -> dict[str, Any]:
    """Route a UI command to the canonical API that owns it.

    A closed table. The UI cannot name an arbitrary callable, and every entry
    goes to the same governed path a CLI or MCP caller would take — approvals
    included, which is why the UI cannot fabricate one.
    """
    if tool == "pause" or tool == "resume":
        # Pause/resume is not implemented in the live core; saying so is
        # better than pretending the click did something.
        return {"ok": False, "error": "not_implemented",
                "message": "pause/resume is not implemented for live sessions"}
    if tool == "stop":
        from watch_skill.live.session import stop_live

        return {"ok": True, "status": stop_live(str(args["session"]))}
    if tool == "finalize":
        from watch_skill.live.finalize import finalize_session

        return {"ok": True, "result": finalize_session(str(args["session"]))}
    if tool == "approve_action":
        from watch_skill.actions import approve

        approval = approve(str(args["approval_id"]),
                           actor=str(args.get("actor") or "operator@workspace"),
                           reason=str(args.get("reason") or "approved in workspace"))
        return {"ok": True, "approval": approval.to_public()}
    if tool == "reject_action":
        from watch_skill.actions import reject

        approval = reject(str(args["approval_id"]),
                          actor=str(args.get("actor") or "operator@workspace"),
                          reason=str(args.get("reason") or "rejected in workspace"))
        return {"ok": True, "approval": approval.to_public()}
    if tool == "observer_cancel":
        from watch_skill.observer import cancel

        return {"ok": True, "run": cancel(str(args["run_id"])).to_public()}
    raise ValueError(f"unknown tool {tool!r}")


class DevHost:
    """The workspace served on loopback, for development and for the proof."""

    def __init__(self, port: int = 0) -> None:
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self._port = port

    @property
    def port(self) -> int:
        if self._server is None:
            raise RuntimeError("the dev host is not running")
        return int(self._server.server_address[1])

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def start(self) -> DevHost:
        server = ThreadingHTTPServer(("127.0.0.1", self._port), _Handler)
        server.daemon_threads = True
        self._server = server
        self._thread = threading.Thread(target=server.serve_forever,
                                        kwargs={"poll_interval": 0.05},
                                        name="ws-devhost", daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._thread is not None:
            self._thread.join(timeout=5.0)
            self._thread = None

    def __enter__(self) -> DevHost:
        return self.start()

    def __exit__(self, *exc: object) -> None:
        self.stop()


__all__ = ["DevHost"]
