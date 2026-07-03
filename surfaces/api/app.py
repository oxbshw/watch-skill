"""AgentVision REST API (FastAPI): the universal adapter for non-MCP agents.

Every MCP tool has a REST twin; the OpenAPI spec at ``/openapi.json`` lets any
agent framework generate a client with zero custom code. Responses are JSON —
frames come back as filesystem paths plus optional base64 payloads (bounded by
``response_frame_cap``) so callers on the same machine can read files directly
and remote callers can opt into inline images.

Auth: when ``AGENTVISION_API_BEARER_TOKEN`` is set, every request must send
``Authorization: Bearer <token>``. Without it the API refuses to bind to
non-loopback hosts (see :func:`surfaces.api.serve`).
"""
from __future__ import annotations

import base64
import secrets
import tempfile
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from pydantic import BaseModel, Field

from agentvision import __version__
from agentvision.config import get_settings
from agentvision.errors import AgentVisionError
from agentvision.perceive.budget import parse_time

_HTTP_STATUS_BY_PREFIX = {
    "acquire": 502,
    "vision": 502,
    "transcribe": 502,
    "config": 400,
    "perceive": 422,
    "loop": 422,
    "index": 404,
}


def _http_error(exc: AgentVisionError) -> HTTPException:
    """Map a structured engine error onto an HTTP status, body preserved."""
    prefix = exc.code.split(".", 1)[0]
    status = _HTTP_STATUS_BY_PREFIX.get(prefix, 500)
    if exc.code.endswith((".not_found", ".unknown_video")):
        status = 404
    return HTTPException(status_code=status, detail=exc.to_dict())


def _require_auth(request: Request) -> None:
    """Constant-time bearer check when a token is configured."""
    token = get_settings().api_bearer_token
    if token is None:
        return
    header = request.headers.get("authorization", "")
    expected = f"Bearer {token.get_secret_value()}"
    if not secrets.compare_digest(header.encode(), expected.encode()):
        raise HTTPException(
            status_code=401,
            detail={"error": "auth.invalid_token", "message": "missing or wrong bearer token",
                    "fix": "send Authorization: Bearer <AGENTVISION_API_BEARER_TOKEN>"},
        )


def _frame_payload(frame_paths: list[str], inline: int) -> list[dict[str, Any]]:
    """Frame descriptors: always paths, base64 inline for the first ``inline``."""
    cap = get_settings().response_frame_cap
    out: list[dict[str, Any]] = []
    for i, raw in enumerate(frame_paths[:cap]):
        path = Path(raw)
        entry: dict[str, Any] = {"path": str(path)}
        if i < inline and path.is_file():
            entry["base64"] = base64.b64encode(path.read_bytes()).decode("ascii")
            entry["media_type"] = "image/jpeg"
        out.append(entry)
    return out


class WatchRequest(BaseModel):
    """POST /v1/watch body."""

    source: str = Field(description="URL, direct media URL, HLS/DASH manifest, or local path.")
    question: str | None = None
    start: str | None = Field(default=None, description="SS, MM:SS, or HH:MM:SS.")
    end: str | None = None
    budget: int | None = Field(default=None, description="Frame-cap override.")
    inline_frames: int = Field(default=0, ge=0, le=12, description="How many frames to inline as base64.")


class AskRequest(BaseModel):
    """POST /v1/ask body."""

    video: str = Field(description="video_id or original source URL/path.")
    question: str
    max_frames: int = Field(default=6, ge=1, le=12)
    inline_frames: int = Field(default=0, ge=0, le=12)


class CaptureRequest(BaseModel):
    """POST /v1/capture body."""

    target: str = Field(description="http(s) URL, `screen:`, `window:<title>`, or a video path.")
    duration: float = Field(default=10.0, gt=0, le=600)
    script: list[dict[str, Any]] | None = None


class LoopStartRequest(BaseModel):
    """POST /v1/loops body."""

    target: str
    pass_criteria: str
    script: list[dict[str, Any]] | None = None
    max_iterations: int = Field(default=5, ge=1, le=25)
    duration: float = Field(default=8.0, gt=0, le=600)


def _loop_response(state: Any) -> dict[str, Any]:
    from agentvision.loop.reportfmt import format_loop_state

    return {
        "loop_id": state.loop_id,
        "status": state.status,
        "target": state.target,
        "iterations": state.iterations,
        "report": format_loop_state(state),
    }


def create_app() -> FastAPI:
    """Build the FastAPI app (separate factory so tests get fresh instances)."""
    app = FastAPI(
        title="AgentVision API",
        version=__version__,
        description="Give any agent a video input: watch, index, ask, capture, loop.",
        dependencies=[Depends(_require_auth)],
    )

    @app.get("/health", tags=["system"])
    def health() -> dict[str, str]:
        """Liveness probe (no dependency checks — see /v1/doctor)."""
        return {"status": "ok", "version": __version__}

    @app.post("/v1/doctor", tags=["system"])
    def doctor(fix: bool = Query(default=True)) -> dict[str, Any]:
        """Full dependency check; auto-remediates fixable issues when fix=true."""
        from agentvision.health.doctor import run_doctor

        return run_doctor(fix=fix).to_dict()

    @app.post("/v1/watch", tags=["video"])
    def watch_video(req: WatchRequest) -> dict[str, Any]:
        """Analyze + index any video source; the REST twin of MCP watch_video."""
        from agentvision.index import index_watch_result
        from agentvision.report import render_report
        from agentvision.watch import watch

        try:
            result = watch(
                req.source,
                start_seconds=parse_time(req.start),
                end_seconds=parse_time(req.end),
                max_frames=req.budget,
            )
            video_id = index_watch_result(result)
        except AgentVisionError as exc:
            raise _http_error(exc)
        frames = [str(f.path) for f in (result.perception.frames if result.perception else [])]
        return {
            "video_id": video_id,
            "question": req.question,
            "report": render_report(result),
            "frames": _frame_payload(frames, req.inline_frames),
            "transcript_source": result.transcript.source,
            "duration_seconds": result.metadata.duration_seconds,
        }

    @app.post("/v1/ask", tags=["video"])
    def ask_video(req: AskRequest) -> dict[str, Any]:
        """Retrieval-based answer over an already-indexed video."""
        from agentvision.index import ask_video as ask

        try:
            result = ask(req.video, req.question, max_frames=req.max_frames)
        except AgentVisionError as exc:
            raise _http_error(exc)
        result["frames"] = _frame_payload(
            [f["frame_path"] for f in result["frames"]], req.inline_frames
        )
        return result

    @app.get("/v1/videos/{video}/moment", tags=["video"])
    def get_moment(
        video: str,
        timestamp: str = Query(description="SS, MM:SS, or HH:MM:SS."),
        window: float = Query(default=10.0, gt=0, le=120),
        inline_frames: int = Query(default=0, ge=0, le=12),
    ) -> dict[str, Any]:
        """Dense frames + transcript + OCR around one moment."""
        from agentvision.index import get_moment as moment

        try:
            ctx = moment(video, parse_time(timestamp) or 0.0, window=window)
        except AgentVisionError as exc:
            raise _http_error(exc)
        return {
            "video_id": ctx.video_id,
            "timestamp": ctx.timestamp,
            "window": ctx.window,
            "segments": ctx.segments,
            "ocr": ctx.ocr,
            "frames": _frame_payload([f["frame_path"] for f in ctx.frames], inline_frames),
        }

    @app.get("/v1/search", tags=["video"])
    def search_videos(q: str = Query(min_length=1)) -> list[dict[str, Any]]:
        """Hybrid keyword + semantic search across every indexed video."""
        from agentvision.index import search_videos as search

        return search(q)

    @app.get("/v1/videos", tags=["video"])
    def list_videos() -> list[dict[str, Any]]:
        """Every video in the persistent index."""
        from agentvision.index import list_videos as videos

        return videos()

    @app.post("/v1/capture", tags=["loop"])
    def capture(req: CaptureRequest) -> dict[str, Any]:
        """Record a URL session / screen / window, then analyze + index it."""
        from agentvision.index import index_watch_result
        from agentvision.loop import capture as run_capture
        from agentvision.watch import watch

        try:
            out_dir = Path(tempfile.mkdtemp(prefix="agentvision-capture-"))
            cap = run_capture(req.target, out_dir, script=req.script, duration_seconds=req.duration)
            result = watch(str(cap.video_path), use_cache=False)
            result.acquisition.source = f"capture:{req.target}"
            video_id = index_watch_result(result)
        except AgentVisionError as exc:
            raise _http_error(exc)
        return {"video_id": video_id, "kind": cap.kind, "video_path": str(cap.video_path)}

    @app.post("/v1/loops", tags=["loop"])
    def loop_start(req: LoopStartRequest) -> dict[str, Any]:
        """Start THE LOOP: capture + critique iteration 0, return issues."""
        from agentvision.loop import loop_start as start

        try:
            state = start(
                req.target, req.pass_criteria, script=req.script,
                max_iterations=req.max_iterations, duration_seconds=req.duration,
            )
        except AgentVisionError as exc:
            raise _http_error(exc)
        return _loop_response(state)

    @app.post("/v1/loops/{loop_id}/iterate", tags=["loop"])
    def loop_iterate(loop_id: str) -> dict[str, Any]:
        """Re-capture + re-critique after the caller applied fixes."""
        from agentvision.loop import loop_iterate as iterate

        try:
            state = iterate(loop_id)
        except AgentVisionError as exc:
            raise _http_error(exc)
        return _loop_response(state)

    @app.get("/v1/loops/{loop_id}", tags=["loop"])
    def loop_status(loop_id: str) -> dict[str, Any]:
        """Persisted loop state (status, per-iteration critiques, artifacts)."""
        from agentvision.loop import loop_status as status

        try:
            state = status(loop_id)
        except AgentVisionError as exc:
            raise _http_error(exc)
        return _loop_response(state)

    return app


def serve(host: str = "127.0.0.1", port: int = 8748) -> None:
    """Run the REST API with uvicorn. Refuses public binds without a token."""
    import uvicorn

    from agentvision.errors import ConfigError

    if host not in ("127.0.0.1", "localhost", "::1") and get_settings().api_bearer_token is None:
        raise ConfigError(
            f"refusing to bind {host} without auth",
            code="config.public_bind_no_token",
            fix="set AGENTVISION_API_BEARER_TOKEN, or bind 127.0.0.1",
        )
    uvicorn.run(create_app(), host=host, port=port)
