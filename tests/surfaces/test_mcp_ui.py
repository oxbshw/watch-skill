"""Inline UI resources: an enhancement that can never cost you the answer.

A client that renders `ui://` blocks shows a scrubbable timeline instead of
a wall of text. A client that does not ignores the block. The rule these
tests hold is that nothing in that path may take the text answer down with
it — a rendering nicety is not worth an error.
"""
from __future__ import annotations

import pytest

from watch_skill.surfaces.mcp.ui import MAX_INLINE_HTML_BYTES, ui_resource, video_ui


def test_the_block_has_the_shape_mcp_ui_clients_read() -> None:
    block = ui_resource("ui://watch-skill/video/abc", "<h1>hi</h1>")
    assert block["type"] == "resource"
    assert block["resource"]["uri"] == "ui://watch-skill/video/abc"
    assert block["resource"]["mimeType"] == "text/html"
    assert block["resource"]["text"] == "<h1>hi</h1>"


@pytest.mark.parametrize("uri", ["https://example.com/x", "file:///etc/passwd", "video/abc", ""])
def test_only_the_ui_scheme_is_accepted(uri: str) -> None:
    """A client trusts the scheme to decide what it will render."""
    with pytest.raises(ValueError, match="ui://"):
        ui_resource(uri, "<p>x</p>")


def test_an_unknown_video_is_no_ui_not_an_error() -> None:
    """The text answer must survive anything that goes wrong here."""
    assert video_ui("deadbeefdeadbeef") is None


def test_a_broken_renderer_is_no_ui_not_an_error(monkeypatch) -> None:
    import watch_skill.viewer as viewer

    def explode(_video_id: str):
        raise RuntimeError("index is on fire")

    monkeypatch.setattr(viewer, "render_viewer_html", explode)
    assert video_ui("whatever") is None


def test_an_oversized_page_is_dropped(monkeypatch) -> None:
    """Past a point it stops being a UI and becomes a payload that gets cut."""
    import watch_skill.viewer as viewer

    monkeypatch.setattr(
        viewer,
        "render_viewer_html",
        lambda vid: (vid, "x" * (MAX_INLINE_HTML_BYTES + 1)),
    )
    assert video_ui("v1") is None


def test_a_page_just_under_the_cap_is_kept(monkeypatch) -> None:
    import watch_skill.viewer as viewer

    monkeypatch.setattr(
        viewer, "render_viewer_html", lambda vid: (vid, "x" * (MAX_INLINE_HTML_BYTES - 10))
    )
    block = video_ui("v1")
    assert block is not None
    assert block["resource"]["uri"] == "ui://watch-skill/video/v1"


def test_the_ui_is_off_unless_asked_for(monkeypatch, tmp_path) -> None:
    """Most clients cannot render it; sending it anyway is a large no-op."""
    from watch_skill import config

    monkeypatch.setenv("WATCHSKILL_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("WATCHSKILL_MCP_INLINE_UI", raising=False)
    config.reset_settings()
    assert config.get_settings().mcp_inline_ui is False

    monkeypatch.setenv("WATCHSKILL_MCP_INLINE_UI", "true")
    config.reset_settings()
    assert config.get_settings().mcp_inline_ui is True


def test_watch_response_puts_text_first_and_ui_last(monkeypatch, tmp_path) -> None:
    """Order is the contract: a client reading only the first block still
    gets the answer."""
    import watch_skill.surfaces.mcp.server as server
    from watch_skill import config

    monkeypatch.setenv("WATCHSKILL_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("WATCHSKILL_MCP_INLINE_UI", "true")
    config.reset_settings()
    monkeypatch.setattr(server, "_frame_images", lambda paths, cap=None: [])
    monkeypatch.setattr(
        server, "_maybe_ui", lambda vid: [ui_resource(f"ui://watch-skill/video/{vid}", "<p>x</p>")]
    )

    class _Result:
        perception = None

    monkeypatch.setattr("watch_skill.report.render_report", lambda r: "REPORT BODY")
    blocks = server._watch_response("vid1", _Result(), question="what happens?")

    assert isinstance(blocks[0], str) and "REPORT BODY" in blocks[0]
    assert blocks[-1]["type"] == "resource"
