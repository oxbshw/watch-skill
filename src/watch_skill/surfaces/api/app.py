"""Watch Skill REST API (FastAPI): the universal adapter for non-MCP agents.

Every MCP tool has a REST twin; the OpenAPI spec at ``/openapi.json`` lets any
agent framework generate a client with zero custom code. Responses are JSON —
frames come back as filesystem paths plus optional base64 payloads (bounded by
``response_frame_cap``) so callers on the same machine can read files directly
and remote callers can opt into inline images.

Auth: when ``WATCHSKILL_API_BEARER_TOKEN`` is set, every request must send
``Authorization: Bearer <token>``. Without it the API refuses to bind to
non-loopback hosts (see :func:`watch_skill.surfaces.api.serve`).
"""
from __future__ import annotations

import base64
import secrets
import tempfile
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from pydantic import BaseModel, Field

from watch_skill import __version__
from watch_skill.config import get_settings
from watch_skill.errors import WatchSkillError
from watch_skill.perceive.budget import parse_time

_HTTP_STATUS_BY_PREFIX = {
    "acquire": 502,
    "vision": 502,
    "transcribe": 502,
    "config": 400,
    "perceive": 422,
    "loop": 422,
    "index": 404,
}


def _http_error(exc: WatchSkillError) -> HTTPException:
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
                    "fix": "send Authorization: Bearer <WATCHSKILL_API_BEARER_TOKEN>"},
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


class LibraryAskRequest(BaseModel):
    """POST /v1/library/synthesize body."""

    question: str = Field(description="A question no single video answers.")
    k_videos: int = Field(default=5, ge=1, le=20, description="How many videos to consult.")


class CaptureRequest(BaseModel):
    """POST /v1/capture body."""

    target: str = Field(description="http(s) URL, `screen:`, `window:<title>`, or a video path.")
    duration: float = Field(default=10.0, gt=0, le=600)
    script: list[dict[str, Any]] | None = None


class VerifyRequest(BaseModel):
    """A contract to freeze and run. Mirrors the MCP verify_contract tool."""

    title: str
    checks: list[dict[str, Any]]
    working_dir: str = "."
    allowed_origins: list[str] = Field(default_factory=list)


class LoopStartRequest(BaseModel):
    """POST /v1/loops body."""

    target: str
    pass_criteria: str
    script: list[dict[str, Any]] | None = None
    max_iterations: int = Field(default=5, ge=1, le=25)
    duration: float = Field(default=8.0, gt=0, le=600)


def _loop_response(state: Any) -> dict[str, Any]:
    from watch_skill.loop.reportfmt import format_loop_state

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
        title="Watch Skill API",
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
        from watch_skill.health.doctor import run_doctor

        return run_doctor(fix=fix).to_dict()

    @app.post("/v1/watch", tags=["video"])
    def watch_video(req: WatchRequest) -> dict[str, Any]:
        """Analyze + index any video source; the REST twin of MCP watch_video."""
        from watch_skill.index import index_watch_result
        from watch_skill.report import render_report
        from watch_skill.watch import watch

        try:
            result = watch(
                req.source,
                start_seconds=parse_time(req.start),
                end_seconds=parse_time(req.end),
                max_frames=req.budget,
            )
            video_id = index_watch_result(result)
        except WatchSkillError as exc:
            raise _http_error(exc) from exc
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
        from watch_skill.index import ask_video as ask

        try:
            result = ask(req.video, req.question, max_frames=req.max_frames)
        except WatchSkillError as exc:
            raise _http_error(exc) from exc
        result["frames"] = _frame_payload(
            [f["frame_path"] for f in result["frames"]], req.inline_frames
        )
        return result

    @app.post("/v1/answer", tags=["video"])
    def answer(req: AskRequest) -> dict[str, Any]:
        """Self-healing answer (v0.6): confidence-scored, escalating, honest.

        The structured twin of MCP ask_video — returns the full Answer
        payload (confidence, verified, escalations_used, evidence, savings).
        /v1/ask remains the raw-retrieval endpoint.
        """
        from watch_skill.answer import answer_question

        try:
            result = answer_question(req.video, req.question)
        except WatchSkillError as exc:
            raise _http_error(exc) from exc
        payload = result.to_dict()
        payload["frames"] = _frame_payload(result.frames, req.inline_frames)
        return payload

    @app.get("/v1/videos/{video}/freshness", tags=["video"])
    def freshness(video: str) -> dict[str, Any]:
        """Whether the indexed evidence still describes the live source."""
        from watch_skill.index.store import check_freshness, source_revisions

        try:
            payload = check_freshness(video)
            payload["revisions"] = source_revisions(video)
        except WatchSkillError as exc:
            raise _http_error(exc) from exc
        return payload

    @app.post("/v1/live", tags=["live"])
    def live_start(body: dict[str, Any]) -> dict[str, Any]:
        """Start watching something as it happens."""
        from watch_skill.live import start_live

        try:
            session = start_live(
                body["target"], kind=body.get("kind", "file_replay"),
                profile=body.get("profile", "local-lite"),
                fps=float(body.get("fps", 2.0)),
                buffer_seconds=float(body.get("buffer_seconds", 120.0)),
                allow_local=bool(body.get("allow_local", False)),
                allowed_hosts=body.get("allowed_hosts") or None,
            )
        except WatchSkillError as exc:
            raise _http_error(exc) from exc
        return session.to_public()

    @app.get("/v1/live", tags=["live"])
    def live_list(active_only: bool = False) -> dict[str, Any]:
        from watch_skill.live import list_live

        return {"sessions": list_live(active_only)}

    @app.get("/v1/live/{session_id}", tags=["live"])
    def live_status(session_id: str) -> dict[str, Any]:
        from watch_skill.live import status

        try:
            return status(session_id)
        except WatchSkillError as exc:
            raise _http_error(exc) from exc

    @app.get("/v1/live/{session_id}/events", tags=["live"])
    def live_events(
        session_id: str, cursor: str = "", limit: int = 50, wait: float = 0.0
    ) -> dict[str, Any]:
        """Cursor-addressed event deltas. Repeating a cursor is idempotent."""
        from watch_skill.live import observe

        try:
            return observe(session_id, cursor=cursor or None, limit=limit,
                           timeout_seconds=wait)
        except WatchSkillError as exc:
            raise _http_error(exc) from exc

    @app.get("/v1/live/{session_id}/aligned", tags=["live"])
    def live_aligned(
        session_id: str, media_ts: float, window: float = 2.0
    ) -> dict[str, Any]:
        """Everything every stream observed around one moment."""
        from watch_skill.live import aligned_evidence

        try:
            return aligned_evidence(session_id, media_ts, window=window)
        except WatchSkillError as exc:
            raise _http_error(exc) from exc

    @app.get("/v1/live/{session_id}/fused", tags=["live"])
    def live_fused(session_id: str, window: float = 2.0) -> dict[str, Any]:
        """Correlated multimodal timeline; observation and inference kept apart."""
        from watch_skill.live.fusion import fuse_session

        try:
            return fuse_session(session_id, window=window)
        except WatchSkillError as exc:
            raise _http_error(exc) from exc

    @app.post("/v1/live/{session_id}/ask", tags=["live"])
    def live_ask(session_id: str, body: dict[str, Any]) -> dict[str, Any]:
        from watch_skill.live import ask_live

        try:
            return ask_live(session_id, body["question"],
                            scope=body.get("scope", "recent"),
                            seconds=float(body.get("seconds", 30.0)))
        except WatchSkillError as exc:
            raise _http_error(exc) from exc

    @app.post("/v1/live/{session_id}/stop", tags=["live"])
    def live_stop(session_id: str, finalize: bool = True) -> dict[str, Any]:
        from watch_skill.live import stop_live
        from watch_skill.live.finalize import finalize_session

        try:
            payload = stop_live(session_id)
            if finalize:
                payload["finalized_video_id"] = finalize_session(session_id)
        except WatchSkillError as exc:
            raise _http_error(exc) from exc
        return payload

    @app.get("/v1/capture-capabilities", tags=["system"])
    def capture_capabilities() -> dict[str, Any]:
        """What this machine can actually record, and how each was checked."""
        from watch_skill.live import capability_matrix

        return capability_matrix()

    @app.get("/v1/jobs", tags=["jobs"])
    def jobs_list(state: str | None = None, limit: int = 25) -> dict[str, Any]:
        """Durable jobs on this machine, newest first."""
        from watch_skill import jobs

        return {"jobs": [job.to_dict() for job in jobs.list_jobs(state, limit)]}

    @app.get("/v1/jobs/{job_id}", tags=["jobs"])
    def jobs_status(job_id: str, events: bool = False) -> dict[str, Any]:
        """One durable job's state, optionally with its append-only log."""
        from watch_skill import jobs

        try:
            job = jobs.get(job_id)
        except WatchSkillError as exc:
            raise _http_error(exc) from exc
        payload = job.to_dict()
        if events:
            payload["events"] = [e.model_dump(mode="json") for e in jobs.events(job_id)]
        return payload

    @app.post("/v1/jobs/{job_id}/cancel", tags=["jobs"])
    def jobs_cancel(job_id: str) -> dict[str, Any]:
        """Ask a job to stop; running jobs stop at their next checkpoint."""
        from watch_skill import jobs

        try:
            return jobs.cancel(job_id).to_dict()
        except WatchSkillError as exc:
            raise _http_error(exc) from exc

    @app.get("/v1/plan", tags=["system"])
    def plan(frames: int = 0, tier: str = "strong") -> dict[str, Any]:
        """The effective policy and what a run would send, before it runs."""
        from watch_skill.policy import execution_plan

        settings = get_settings()
        provider = (settings.vision_cheap_provider if tier == "cheap"
                    else settings.vision_strong_provider)
        model = (settings.vision_cheap_model if tier == "cheap"
                 else settings.vision_strong_model)
        return execution_plan(phase=f"vision.{tier}", provider=provider,
                              model=model, frames=frames)

    @app.post("/v1/verify", tags=["verify"])
    def verify(req: VerifyRequest) -> dict[str, Any]:
        """Run a frozen contract's deterministic checks over an agent run."""
        from watch_skill.verify import draft_contract, verify_run

        try:
            contract = draft_contract(req.title, req.checks, created_by="rest").freeze()
            bundle, attestation = verify_run(
                contract, working_dir=req.working_dir,
                allowed_origins=req.allowed_origins,
            )
        except WatchSkillError as exc:
            raise _http_error(exc) from exc
        payload = bundle.model_dump(mode="json")
        payload["attestation"] = attestation.model_dump(mode="json")
        return payload

    @app.get("/v1/verify/{run_id}", tags=["verify"])
    def verify_show(run_id: str) -> dict[str, Any]:
        """Read a recorded run back, re-checking its attestation."""
        from watch_skill.verify import load_run

        try:
            contract, bundle, attestation = load_run(run_id)
        except WatchSkillError as exc:
            raise _http_error(exc) from exc
        return {
            "contract": contract.model_dump(mode="json"),
            "evidence": bundle.model_dump(mode="json"),
            "attestation": attestation.model_dump(mode="json"),
        }

    @app.get("/v1/videos/{video}/moment", tags=["video"])
    def get_moment(
        video: str,
        timestamp: str = Query(description="SS, MM:SS, or HH:MM:SS."),
        window: float = Query(default=10.0, gt=0, le=120),
        inline_frames: int = Query(default=0, ge=0, le=12),
    ) -> dict[str, Any]:
        """Dense frames + transcript + OCR around one moment."""
        from watch_skill.index import get_moment as moment

        try:
            ctx = moment(video, parse_time(timestamp) or 0.0, window=window)
        except WatchSkillError as exc:
            raise _http_error(exc) from exc
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
        from watch_skill.index import search_videos as search

        return search(q)

    @app.get("/v1/videos", tags=["video"])
    def list_videos() -> list[dict[str, Any]]:
        """Every video in the persistent index."""
        from watch_skill.index import list_videos as videos

        return videos()

    @app.post("/v1/library/synthesize", tags=["library"])
    def library_synthesize(req: LibraryAskRequest) -> dict[str, Any]:
        """Cross-video synthesis from distilled notes, per-video citations."""
        from watch_skill.library import library_synthesize as run

        try:
            return run(req.question, k_videos=req.k_videos).to_dict()
        except WatchSkillError as exc:
            raise _http_error(exc) from exc

    @app.get("/v1/library/overview", tags=["library"])
    def library_overview() -> dict[str, Any]:
        """What the library knows: sizes, note counts, cross-video entities."""
        from watch_skill.library import library_overview as run

        return run()

    @app.post("/v1/capture", tags=["loop"])
    def capture(req: CaptureRequest) -> dict[str, Any]:
        """Record a URL session / screen / window, then analyze + index it."""
        from watch_skill.index import index_watch_result
        from watch_skill.loop import capture as run_capture
        from watch_skill.watch import watch

        try:
            out_dir = Path(tempfile.mkdtemp(prefix="watch-skill-capture-"))
            cap = run_capture(req.target, out_dir, script=req.script, duration_seconds=req.duration)
            result = watch(str(cap.video_path), use_cache=False)
            result.acquisition.source = f"capture:{req.target}"
            video_id = index_watch_result(result)
        except WatchSkillError as exc:
            raise _http_error(exc) from exc
        return {"video_id": video_id, "kind": cap.kind, "video_path": str(cap.video_path)}

    @app.post("/v1/loops", tags=["loop"])
    def loop_start(req: LoopStartRequest) -> dict[str, Any]:
        """Start THE LOOP: capture + critique iteration 0, return issues."""
        from watch_skill.loop import loop_start as start

        try:
            state = start(
                req.target, req.pass_criteria, script=req.script,
                max_iterations=req.max_iterations, duration_seconds=req.duration,
            )
        except WatchSkillError as exc:
            raise _http_error(exc) from exc
        return _loop_response(state)

    @app.post("/v1/loops/{loop_id}/iterate", tags=["loop"])
    def loop_iterate(loop_id: str) -> dict[str, Any]:
        """Re-capture + re-critique after the caller applied fixes."""
        from watch_skill.loop import loop_iterate as iterate

        try:
            state = iterate(loop_id)
        except WatchSkillError as exc:
            raise _http_error(exc) from exc
        return _loop_response(state)

    @app.get("/v1/loops/{loop_id}", tags=["loop"])
    def loop_status(loop_id: str) -> dict[str, Any]:
        """Persisted loop state (status, per-iteration critiques, artifacts)."""
        from watch_skill.loop import loop_status as status

        try:
            state = status(loop_id)
        except WatchSkillError as exc:
            raise _http_error(exc) from exc
        return _loop_response(state)

    return app


def serve(host: str = "127.0.0.1", port: int = 8748) -> None:
    """Run the REST API with uvicorn. Refuses public binds without a token."""
    import uvicorn

    from watch_skill.errors import ConfigError

    if host not in ("127.0.0.1", "localhost", "::1") and get_settings().api_bearer_token is None:
        raise ConfigError(
            f"refusing to bind {host} without auth",
            code="config.public_bind_no_token",
            fix="set WATCHSKILL_API_BEARER_TOKEN, or bind 127.0.0.1",
        )
    uvicorn.run(create_app(), host=host, port=port)
