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

import hashlib
import hmac
import json
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlsplit

# One secret per host process, never written down and never sent to the UI.
# What the UI receives is a token derived from it for one session, which is
# what makes preview access session-scoped rather than host-wide.
_SECRET = secrets.token_bytes(32)


def preview_token(session_id: str) -> str:
    """A capability to read one session's frames, and nothing else.

    Derived rather than stored so there is no table to leak or to keep in
    sync, and scoped to the session so a token seen in one workspace cannot
    fetch another session's media.
    """
    return hmac.new(_SECRET, session_id.encode("utf-8"),
                    hashlib.sha256).hexdigest()[:32]


def _token_ok(session_id: str, supplied: str) -> bool:
    if not session_id or not supplied:
        return False
    return hmac.compare_digest(preview_token(session_id), supplied)


def _bundle() -> str:
    from watch_skill.surfaces.mcp.workspace_app import workspace_html

    html = workspace_html()
    # The standalone build reads its API origin from this tag rather than
    # having one compiled in, so the bundle shipped inside the Python package
    # contains no origin at all and cannot phone anywhere by default.
    marker = "<head>"
    tag = '<head><meta name="watch-skill-api" content="">'
    return html.replace(marker, tag, 1) if marker in html else html


class _QuietServer(ThreadingHTTPServer):
    """A server that does not shout when a browser walks away.

    `socketserver` prints a full traceback for any exception raised while
    handling a request, and a client that navigates, reloads or closes mid-
    request produces one every time. On a proof run those tracebacks are
    printed by the hundred and bury the assertion that actually failed —
    which is precisely how an intermittent UI failure went a whole season
    without being read.
    """

    def handle_error(self, request, client_address) -> None:  # noqa: ANN001
        import sys as _sys  # noqa: PLC0415

        exc = _sys.exc_info()[1]
        if isinstance(exc, (ConnectionAbortedError, ConnectionResetError,
                            BrokenPipeError)):
            return
        super().handle_error(request, client_address)


class _Handler(BaseHTTPRequestHandler):
    server_version = "WatchSkillDevHost/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, *args: Any) -> None:  # noqa: A003
        """Quiet. A request log per frame poll buries everything else."""

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            # The same restrictions the MCP resource declares, so what is
            # proved here is proved under the policy the real thing runs
            # under.
            self.send_header("Content-Security-Policy", _csp())
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            # The client went away mid-response — a reload, a navigation, or a
            # closing browser. Ordinary, and not worth a traceback: printed on
            # every teardown it buries the failures a proof run cares about.
            return

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
            elif parts.path == "/favicon.ico":
                # Answered rather than 404'd. Every browser asks for this
                # unprompted, and a 404 becomes a console error that buries
                # the real ones the rendered proof is watching for.
                self._send(204, b"", "image/x-icon")
            elif parts.path == "/api/snapshot":
                from watch_skill import workspace

                payload = workspace.snapshot(session)
                self._json(200, _with_preview(payload))
            elif parts.path == "/api/preview/meta":
                self._preview_meta(str(session),
                                   (query.get("token") or [""])[0],
                                   float((query.get("after") or ["-1"])[0]))
            elif parts.path == "/api/preview/frame":
                self._preview_frame(str(session),
                                    (query.get("token") or [""])[0],
                                    float((query.get("at") or ["-1"])[0]))
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

    # --- continuous preview -------------------------------------------------

    def _preview_meta(self, session_id: str, token: str, after: float) -> None:
        """What the newest frame is, without sending it.

        Metadata first, bytes second, so the client can decide whether it
        already has this frame. Polling the image directly would re-download
        an unchanged frame forever and make "how old is what I am looking at"
        unanswerable.

        `after` is a cursor on media time. A client that reconnects sends the
        last frame it drew and resumes from there, which is what stops a
        reload from re-rendering frames it already has.
        """
        from watch_skill.live import buffer as buf

        if not _token_ok(session_id, token):
            self._json(403, {"error": "bad_preview_token"})
            return
        newest = buf.newest_frame_media_ts(session_id)
        if newest is None:
            self._json(200, {"available": False, "session": session_id,
                             "wall_ts": time.time()})
            return
        # Latest-frame-wins: the client is told about the newest frame only.
        # A queue of stale frames is exactly what a live preview must not
        # deliver — by the time it drained, none of it would be live.
        self._json(200, {
            "available": True,
            "session": session_id,
            "media_ts": round(newest, 3),
            "wall_ts": time.time(),
            "is_new": newest > after,
        })

    def _preview_frame(self, session_id: str, token: str, at: float) -> None:
        """One frame's bytes, named by media time rather than by path.

        The client never sees a filesystem path, and cannot ask for one: the
        only addressable thing is a timestamp inside a session it holds a
        token for.
        """
        from watch_skill.live import buffer as buf

        if not _token_ok(session_id, token):
            self._json(403, {"error": "bad_preview_token"})
            return
        target = at if at >= 0 else buf.newest_frame_media_ts(session_id)
        if target is not None:
            frames = buf.frames_between(session_id, max(0.0, target - 1.0),
                                        target + 0.001, limit=4)
            for segment in reversed(frames):
                if segment.path.is_file():
                    self._send(200, segment.path.read_bytes(), "image/jpeg")
                    return
        # 204, not 404. "No frame has been captured yet" is an ordinary state
        # of a healthy starting session, and reporting it as an error puts a
        # red line in the console of a workspace that is working correctly.
        self._send(204, b"", "image/jpeg")

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


def _with_preview(payload: dict[str, Any]) -> dict[str, Any]:
    """Attach the preview capability this host can actually honour.

    Negotiated rather than assumed, and negotiated *down* by default. The
    label the UI shows is derived from this block, so choosing the wrong tier
    here is how a still image ends up wearing the word LIVE.

    Added by the host rather than by `workspace.snapshot` because a preview
    token is a property of this transport, not of the canonical read model —
    the MCP surface serves the same snapshot and must not carry one.
    """
    session = payload.get("session")
    if not session:
        payload["preview"] = {"transport": "none",
                              "reason": "no session is open"}
        return payload
    session_id = str(session.get("session_id"))
    state = str(session.get("state"))
    if state in ("stopped", "finalized", "failed"):
        # Nothing here is happening now, and the interface must not imply it
        # is. A finished session is reviewed, not watched.
        payload["preview"] = {"transport": "replay", "session": session_id,
                              "token": preview_token(session_id),
                              "endpoint": "/api/preview",
                              "reason": f"session is {state}"}
        return payload
    payload["preview"] = {
        # Bounded throttled frame updates: every captured frame is offered,
        # the newest always wins, and the client is told how old it is. Not
        # claimed as continuous binary video, which this host does not serve.
        "transport": "frames",
        "session": session_id,
        "token": preview_token(session_id),
        "endpoint": "/api/preview",
        "reason": "loopback host serves bounded frame updates",
    }
    return payload


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
        # Every snapshot response carries the capture-capability matrix, and
        # building it enumerates ffmpeg devices and launches a browser driver.
        # Warming before the socket accepts anything means `start()` returning
        # is the same claim as being able to answer -- a host that is listening
        # but needs seven seconds for its first reply is not started, it is
        # starting. Probes are cached per process, so only the first host in a
        # process pays this.
        self._warm_probes()

        server = _QuietServer(("127.0.0.1", self._port), _Handler)
        server.daemon_threads = True
        self._server = server
        self._thread = threading.Thread(target=server.serve_forever,
                                        kwargs={"poll_interval": 0.05},
                                        name="ws-devhost", daemon=True)
        self._thread.start()
        return self

    @staticmethod
    def _warm_probes() -> None:
        """Build one snapshot before the socket opens.

        Not just the capture probes. The snapshot path also resolves lazy
        imports, opens the session and approval stores, and reads policy, and
        every one of those is cold exactly once per process. Warming the whole
        response is what makes the guarantee independent of which part happens
        to be slowest on a given machine -- warming only the probes left a
        cold Windows runner still exceeding a ten-second client timeout on its
        first request.

        Best effort throughout: a warm-up that fails must never stop a host
        from starting, because the request path recomputes anything missing.
        """
        try:
            from watch_skill import workspace

            _with_preview(workspace.snapshot())
        except Exception:  # noqa: BLE001 - warming is an optimisation, never a failure
            pass

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
