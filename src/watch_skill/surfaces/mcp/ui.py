"""Inline UI resources for MCP clients that render them.

A video answer is a visual thing — a timeline, the frame it came from, the
line that was said. Text plus loose image blocks is the lossy rendering of
that, and it is what every client gets today.

`mcp-ui` established a small convention for the alternative: a tool returns
an embedded resource under a `ui://` URI with `text/html`, and a client that
understands it renders the page inline instead of printing it. Clients that
do not understand it ignore the block and show the text, so nothing is lost
by sending one.

The shape is written out here rather than pulled from the SDK. It is three
fields; the package that provides them is a thin set of dataclasses last
released in 2025, and the read path of a tool response is not somewhere to
add a stale dependency for that. If the convention moves, this file moves.

The HTML itself comes from `viewer.py` — the same renderer behind
`watch-skill viewer`, so the page a user shares and the page an agent shows
are the same page, and neither can quietly drift from the other.
"""
from __future__ import annotations

from typing import Any

# Anything above roughly this size stops being a UI and starts being a
# payload that will be dropped by a transport or truncated by a client.
# The viewer already caps frames; this is the backstop.
MAX_INLINE_HTML_BYTES = 4 * 1024 * 1024


def ui_resource(uri: str, html: str) -> dict[str, Any]:
    """One embedded UI resource block, in the shape mcp-ui clients expect."""
    if not uri.startswith("ui://"):
        raise ValueError(f"a UI resource URI must start with ui:// — got {uri!r}")
    return {
        "type": "resource",
        "resource": {"uri": uri, "mimeType": "text/html", "text": html},
    }


def video_ui(video_id: str) -> dict[str, Any] | None:
    """The viewer page for one video as a UI block, or None if it cannot be.

    Never raises. A missing video, an unreadable index, or a page too large
    to inline all mean "no UI this time" — the text answer beside it is the
    real result, and losing it to a rendering nicety would be the wrong
    trade.
    """
    try:
        from watch_skill.viewer import render_viewer_html

        resolved, html = render_viewer_html(video_id)
    except Exception:
        return None

    if len(html.encode("utf-8")) > MAX_INLINE_HTML_BYTES:
        return None
    return ui_resource(f"ui://watch-skill/video/{resolved}", html)
