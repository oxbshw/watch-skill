"""The MCP Apps surface for the live workspace.

Exactly one new discovery-facing tool. The workspace needs a dozen operations
— start, stop, approve, seek, inspect a trigger — and exposing each as its own
tool would triple the server's discovery cost for a UI that most agents will
never open. So `watch_workspace` opens the view, and the view then calls the
*existing* canonical tools through the host for everything real.

Two constants come from the official SDK rather than being written out here,
because getting either wrong means a host silently declines to render:

``text/html;profile=mcp-app``
    the resource MIME type the host looks for
``ui/resourceUri``
    the tool-meta key that points a tool result at its UI resource

They are pinned against `@modelcontextprotocol/ext-apps@1.7.5` and asserted by
a test, so an SDK bump that changes them fails the suite here rather than
producing a workspace that never appears.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

# --- pinned against @modelcontextprotocol/ext-apps@1.7.5 --------------------
# Verified from the installed package's dist/src/app.d.ts:
#   export declare const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
#   export declare const RESOURCE_URI_META_KEY = "ui/resourceUri";
MCP_APPS_SDK_VERSION = "1.7.5"
RESOURCE_MIME_TYPE = "text/html;profile=mcp-app"
RESOURCE_URI_META_KEY = "ui/resourceUri"

WORKSPACE_URI = "ui://watch-skill/workspace"

# The app is served as one self-contained document. A strict policy is
# declared here rather than left to the host: the workspace renders text a
# hostile page authored, so `script-src 'self'` with no `unsafe-eval` and no
# remote origin is the difference between quoting an injection attempt and
# executing it.
CONTENT_SECURITY_POLICY = (
    "default-src 'none'; "
    "script-src 'self' 'unsafe-inline'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; "
    "media-src 'self' data: blob:; "
    "font-src 'self'; "
    "connect-src 'none'; "
    "frame-ancestors *; "
    "base-uri 'none'; "
    "form-action 'none'"
)


def bundle_path() -> Path:
    """Where the built single-file app lives inside the package."""
    return Path(__file__).resolve().parent / "static" / "workspace.html"


def bundle_available() -> bool:
    return bundle_path().is_file()


def workspace_html() -> str:
    """The built app, or an honest placeholder saying it was not built.

    A placeholder rather than an exception: a server whose UI bundle is
    missing should still start and still answer every other tool. The page
    says what is wrong and how to fix it, which is more useful to whoever hits
    it than a stack trace in the host's log.
    """
    path = bundle_path()
    if path.is_file():
        return path.read_text(encoding="utf-8")
    return (
        "<!doctype html><meta charset=utf-8>"
        "<title>Watch Skill workspace</title>"
        "<style>body{font:14px system-ui;margin:0;padding:32px;"
        "background:#0f1115;color:#e8eaf0}code{background:#1a1d24;"
        "padding:2px 6px;border-radius:4px}</style>"
        "<h1>Workspace bundle not built</h1>"
        "<p>The Watch Skill MCP App has not been built into this install.</p>"
        "<p>Build it with <code>npm --prefix app install &amp;&amp; "
        "npm --prefix app run build</code>.</p>"
    )


def resource_meta() -> dict[str, Any]:
    """The `_meta` block a host reads to decide how to sandbox the app."""
    return {
        "io.modelcontextprotocol/ui": {
            "csp": {"connect-src": [], "resource-src": ["self"]},
            "permissions": {},
            "preferredSize": {"width": 1180, "height": 760},
        }
    }


def tool_meta() -> dict[str, Any]:
    """The `_meta` block that points a tool result at the workspace UI."""
    return {RESOURCE_URI_META_KEY: WORKSPACE_URI}


def workspace_resource() -> dict[str, Any]:
    """The UI resource block, in the shape the official spec defines."""
    return {
        "type": "resource",
        "resource": {
            "uri": WORKSPACE_URI,
            "mimeType": RESOURCE_MIME_TYPE,
            "text": workspace_html(),
            "_meta": resource_meta(),
        },
    }


def open_workspace(session_id: str | None = None,
                   mode: str = "auto") -> list[dict[str, Any]]:
    """Build the tool result: a text summary plus the UI resource.

    The text block is not a fallback afterthought. A host that cannot render
    MCP Apps still gets a usable answer, and the agent reading the transcript
    gets the canonical state in words rather than a note saying a UI was
    shown somewhere it cannot see.
    """
    from watch_skill import workspace

    if mode == "new":
        state = workspace.snapshot(None)
        state["session"] = None
        state["events"] = []
    else:
        state = workspace.snapshot(session_id)

    return [
        {"type": "text", "text": _summary(state)},
        workspace_resource(),
    ]


def _summary(state: dict[str, Any]) -> str:
    """A words-only account of the same canonical state the UI will draw."""
    session = state.get("session")
    lines = ["Watch Skill workspace"]
    if session is None:
        lines.append("no active session — start one with `watch_live`")
    else:
        lines.append(
            f"session {session['session_id']} ({session['source']['kind']}) "
            f"is {session['state']}, {session['events_total']} events")
        observer = state.get("observer")
        if observer:
            # Never a bare "verified". The level it was established at travels
            # with it, because a green word whose oracle nobody can name is
            # precisely the claim this product exists to avoid making.
            lines.append(
                f"observer {observer['run_id']}: {observer['state']} "
                f"(assurance: {observer.get('assurance') or 'none yet'})")
        pending = state.get("approvals") or []
        if pending:
            lines.append(f"{len(pending)} approval(s) awaiting a human decision")
    lines.append(
        f"policy: {'offline' if state['policy'].get('offline') else 'network allowed'}"
        f"; best assurance available: {state['assurance']['best_available']}")
    return "\n".join(lines)


def workspace_snapshot_json(session_id: str | None = None) -> str:
    from watch_skill import workspace

    return json.dumps(workspace.snapshot(session_id), ensure_ascii=False,
                      default=str)


__all__ = [
    "CONTENT_SECURITY_POLICY",
    "MCP_APPS_SDK_VERSION",
    "RESOURCE_MIME_TYPE",
    "RESOURCE_URI_META_KEY",
    "WORKSPACE_URI",
    "bundle_available",
    "bundle_path",
    "open_workspace",
    "resource_meta",
    "tool_meta",
    "workspace_html",
    "workspace_resource",
    "workspace_snapshot_json",
]
