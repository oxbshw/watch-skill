"""The MCP Apps surface, and the canonical state behind it.

Two things are being defended here. First, that the constants the official
spec defines are exactly right — get either wrong and a host silently
declines to render, which is the hardest class of bug to notice. Second, that
the UI is a *view*: everything it draws exists in a durable store first.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from watch_skill import workspace
from watch_skill.live import db as live_db
from watch_skill.live.types import (
    LiveEvent,
    LiveEventType,
    LiveSession,
    LiveSourceKind,
    LiveSourceSpec,
    Provenance,
)
from watch_skill.surfaces.mcp.workspace_app import (
    CONTENT_SECURITY_POLICY,
    MCP_APPS_SDK_VERSION,
    RESOURCE_MIME_TYPE,
    RESOURCE_URI_META_KEY,
    WORKSPACE_URI,
    open_workspace,
    resource_meta,
    tool_meta,
    workspace_resource,
)

SDK_DIST = (Path(__file__).resolve().parents[2] / "app" / "node_modules"
            / "@modelcontextprotocol" / "ext-apps")


# --- the official contract ---------------------------------------------------


def test_the_constants_match_the_installed_sdk() -> None:
    """Pinned against the real package, not against memory.

    A host looks for this exact MIME type and this exact meta key. If an SDK
    bump changes either, the workspace stops rendering with no error anywhere
    — so the mismatch has to fail here instead.
    """
    declaration = SDK_DIST / "dist" / "src" / "app.d.ts"
    if not declaration.is_file():
        pytest.skip("the ext-apps SDK is not installed; run `npm --prefix app install`")

    text = declaration.read_text(encoding="utf-8")
    assert f'RESOURCE_MIME_TYPE = "{RESOURCE_MIME_TYPE}"' in text
    assert f'RESOURCE_URI_META_KEY = "{RESOURCE_URI_META_KEY}"' in text

    package = json.loads((SDK_DIST / "package.json").read_text(encoding="utf-8"))
    assert package["version"] == MCP_APPS_SDK_VERSION, (
        f"pinned {MCP_APPS_SDK_VERSION}, installed {package['version']}")


def test_the_tool_result_carries_text_and_a_ui_resource() -> None:
    blocks = open_workspace(None)
    assert [b["type"] for b in blocks] == ["text", "resource"]
    resource = blocks[1]["resource"]
    assert resource["uri"] == WORKSPACE_URI
    assert resource["mimeType"] == RESOURCE_MIME_TYPE
    assert resource["text"], "the resource carried no document"
    assert "io.modelcontextprotocol/ui" in resource["_meta"]


def test_a_host_that_cannot_render_still_gets_a_usable_answer() -> None:
    """The text block is not an afterthought.

    An agent reading a transcript in a host with no MCP Apps support must get
    the canonical state in words, not a note saying a UI appeared somewhere
    it cannot see.
    """
    text = open_workspace(None)[0]["text"]
    assert "Watch Skill workspace" in text
    assert "assurance" in text


def test_the_meta_key_points_at_the_workspace_resource() -> None:
    assert tool_meta() == {RESOURCE_URI_META_KEY: WORKSPACE_URI}
    assert resource_meta()["io.modelcontextprotocol/ui"]["preferredSize"]["width"] > 0


def test_the_policy_forbids_remote_code_and_eval() -> None:
    """The workspace renders text a hostile page wrote. The policy is what
    keeps that quoting rather than executing."""
    assert "default-src 'none'" in CONTENT_SECURITY_POLICY
    assert "unsafe-eval" not in CONTENT_SECURITY_POLICY
    assert "connect-src 'none'" in CONTENT_SECURITY_POLICY
    for remote in ("http://", "https://", "cdn", "unpkg", "jsdelivr"):
        assert remote not in CONTENT_SECURITY_POLICY, remote


def test_the_bundled_document_loads_nothing_remote() -> None:
    """No remote *loadable* reference — which is not the same as no URL.

    An earlier version of this test rejected the string "http://" anywhere in
    the bundle and failed on `http://www.w3.org/2000/svg`. An XML namespace is
    an identifier, never fetched, and a link inside a React error message is
    documentation. Banning them proves nothing and trains people to weaken the
    check. What matters is whether the document can pull code or assets from
    somewhere else at run time.
    """
    html = workspace_resource()["resource"]["text"]

    quote = "[\"']"
    for pattern, what in (
        (rf"<script[^>]+src\s*=\s*{quote}https?://", "remote script"),
        (rf"<link[^>]+href\s*=\s*{quote}https?://", "remote stylesheet"),
        (rf"<img[^>]+src\s*=\s*{quote}https?://", "remote image"),
        (rf"@import\s+(?:url\()?{quote}?https?://", "remote CSS import"),
        (r"importScripts\(", "worker script import"),
    ):
        assert not re.search(pattern, html, re.IGNORECASE), what

    for host in ("cdn.jsdelivr", "unpkg.com", "cdnjs.", "fonts.googleapis",
                 "fonts.gstatic", "ajax.googleapis"):
        assert host not in html, host

    # And no dynamic evaluation, which is the other way remote code arrives.
    for construct in ("eval(", "new Function("):
        assert construct not in html, construct


# --- canonical state ---------------------------------------------------------


@pytest.fixture
def populated():
    session_id = "live_ws"
    live_db.insert_session(LiveSession(
        session_id=session_id,
        spec=LiveSourceSpec(kind=LiveSourceKind.BROWSER, target="x")))
    live_db.append_event(LiveEvent(
        session_id=session_id, seq=0, media_ts=1.0, wall_ts=1.0,
        type=LiveEventType.ERROR, summary="console.error: settlement failed",
        detector="browser:console",
        detail={"browser": {"kind": "console", "page_authored": True,
                            "navigation_epoch": 2, "redacted": False,
                            "detail": {"level": "error"}}}))
    live_db.append_event(LiveEvent(
        session_id=session_id, seq=0, media_ts=2.0, wall_ts=2.0,
        type=LiveEventType.UI_STATE_CHANGE, summary="a dialog seems to be open",
        provenance=Provenance.INFERENCE, detector="semantic:llava"))
    live_db.append_event(LiveEvent(
        session_id=session_id, seq=0, media_ts=3.0, wall_ts=3.0,
        type=LiveEventType.SCENE_CHANGE, summary="scene changed",
        detector="scene"))
    return session_id


def test_observations_and_inferences_land_in_different_tabs(populated) -> None:
    """They may never share a card, so they may not share a classification."""
    state = workspace.snapshot(populated)
    tabs = {event["summary"]: event["tab"] for event in state["events"]}
    assert tabs["console.error: settlement failed"] == "browser"
    assert tabs["a dialog seems to be open"] == "inferred"
    assert tabs["scene changed"] == "observed"

    inferred = [e for e in state["events"] if e["tab"] == "inferred"]
    assert all(e["provenance"] == "inference" for e in inferred)


def test_page_authored_text_is_marked_untrusted(populated) -> None:
    """Never dropped, never obeyed. Marked, so the UI can quote it."""
    state = workspace.snapshot(populated)
    console = next(e for e in state["events"] if e["detector"] == "browser:console")
    assert console["untrusted"] is True
    scene = next(e for e in state["events"] if e["detector"] == "scene")
    assert scene["untrusted"] is False


def test_a_snapshot_carries_the_assurance_and_policy_the_ui_must_show(
    populated,
) -> None:
    state = workspace.snapshot(populated)
    assert state["assurance"]["best_available"]
    assert "offline" in state["policy"]
    assert state["resources"]["scope"] == "process"
    assert state["session"]["session_id"] == populated


def test_deltas_are_cursor_based_and_never_resend_history(populated) -> None:
    first = workspace.delta(populated, after_seq=0)
    assert first["count"] == 3
    cursor = first["cursor"]

    again = workspace.delta(populated, after_seq=cursor)
    assert again["count"] == 0, "a second poll resent events already delivered"

    live_db.append_event(LiveEvent(
        session_id=populated, seq=0, media_ts=4.0, wall_ts=4.0,
        type=LiveEventType.SCENE_CHANGE, summary="later", detector="scene"))
    later = workspace.delta(populated, after_seq=cursor)
    assert [e["summary"] for e in later["events"]] == ["later"]


def test_a_delta_batch_is_bounded(populated) -> None:
    for index in range(60):
        live_db.append_event(LiveEvent(
            session_id=populated, seq=0, media_ts=float(index), wall_ts=1.0,
            type=LiveEventType.SCENE_CHANGE, summary=f"m{index}",
            detector="scene"))
    batch = workspace.delta(populated, after_seq=0, limit=10)
    assert batch["count"] == 10
    assert batch["has_more"] is True


def test_the_timeline_groups_events_into_lanes(populated) -> None:
    lanes = workspace.timeline(populated)
    assert "errors" in lanes["lanes"]
    assert "inferred" in lanes["lanes"]
    assert "scene" in lanes["lanes"]
    assert lanes["span_seconds"] >= 3.0
    assert lanes["marker_count"] == 3


def test_the_rail_is_bounded_and_never_the_whole_history() -> None:
    for index in range(8):
        live_db.insert_session(LiveSession(
            session_id=f"live_rail_{index}",
            spec=LiveSourceSpec(kind=LiveSourceKind.FILE_REPLAY, target="x")))
    rail = workspace.list_sessions(limit=3)
    assert len(rail["sessions"]) == 3
    assert rail["truncated"] is True


def test_an_empty_workspace_is_a_state_not_an_error() -> None:
    state = workspace.snapshot("live_does_not_exist")
    assert state["session"] is None
    assert state["events"] == []
    assert state["assurance"]["best_available"]
