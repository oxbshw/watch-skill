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

import mcp.types as mt
from fastmcp.apps import (
    UI_EXTENSION_ID,
    AppConfig,
    ResourceCSP,
    ResourcePermissions,
    app_config_to_meta_dict,
)
from fastmcp.tools import ToolResult

# --- pinned against @modelcontextprotocol/ext-apps@1.7.5 --------------------
# Verified from the installed package's dist/src/app.d.ts:
#   export declare const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
#   export declare const RESOURCE_URI_META_KEY = "ui/resourceUri";
MCP_APPS_SDK_VERSION = "1.7.5"
RESOURCE_MIME_TYPE = "text/html;profile=mcp-app"
RESOURCE_URI_META_KEY = "ui/resourceUri"

# The nested key the SDK actually reads. `RESOURCE_URI_META_KEY` above is the
# flat *legacy* spelling; dist/src/server/index.d.ts documents both and says
# hosts must check each, so everything below emits the pair rather than
# picking a side:
#   _meta.ui.resourceUri            (preferred)
#   _meta["ui/resourceUri"]         (deprecated, older hosts)
# Note that `io.modelcontextprotocol/ui` is the *extension id* used for
# capability negotiation, NOT a `_meta` key — see UI_EXTENSION_ID's use in
# `_legacy_resource_meta` for the one place it is still written.
UI_META_KEY = "ui"

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


def resource_app_config() -> AppConfig:
    """How the host must sandbox the app, in FastMCP's typed spec model.

    `McpUiResourceMeta` is `{csp, permissions, domain, prefersBorder}` — there
    is no `preferredSize` in it, and the CSP is a *domain allowlist* rather
    than a policy string. The empty lists are deliberate: the document is
    self-contained, so it needs no external origin for scripts, styles,
    images, fonts, or fetch. This is what the host enforces on the iframe;
    `CONTENT_SECURITY_POLICY` enforces the same thing from inside the
    document, and neither is a substitute for the other.

    `resource_uri` and `visibility` are left unset because FastMCP rejects them
    on a resource — the resource *is* the UI.
    """
    return AppConfig(
        csp=ResourceCSP(
            connect_domains=[],
            resource_domains=[],
            frame_domains=[],
            base_uri_domains=[],
        ),
        permissions=ResourcePermissions(),
    )


def tool_app_config() -> AppConfig:
    """The tool's MCP Apps declaration: which UI resource it opens.

    `visibility` is deliberately unset. FastMCP treats `visibility == ["app"]`
    as a backend tool and drops it from `tools/list` entirely, which would hide
    the one discovery-facing workspace tool from the model.
    """
    return AppConfig(resource_uri=WORKSPACE_URI)


def _legacy_resource_meta() -> dict[str, Any]:
    """The pre-1.3 resource `_meta` block, kept for continuity.

    Written under the extension id rather than a real `_meta` key, and with a
    CSP shape the spec does not define. `preferredSize` is not a spec field
    either: `McpUiResourceMeta` in spec.types.d.ts is `{csp, permissions,
    domain, prefersBorder}` and has no size at all. No host reads any of this,
    but it is harmless and it is the only record of the intended size, so it
    stays alongside the conformant block that `resource_meta` merges in.
    """
    return {
        UI_EXTENSION_ID: {
            "csp": {"connect-src": [], "resource-src": ["self"]},
            "permissions": {},
            "preferredSize": {"width": 1180, "height": 760},
        }
    }


def resource_meta() -> dict[str, Any]:
    """The `_meta` block a host reads to decide how to sandbox the app."""
    return {
        **_legacy_resource_meta(),
        UI_META_KEY: app_config_to_meta_dict(resource_app_config()),
    }


# The tools the *app* calls, marked the way the spec marks them.
#
# `McpUiToolMeta.visibility` is `["model", "app"]` by default; `["app"]` means
# "callable by the app from this server only" — exactly what `workspace_
# snapshot` and `workspace_delta` are. They exist so the rendered workspace can
# read canonical state; no agent should ever pick them out of a tool list.
#
# Declared as a plain `meta=` rather than through `app=AppConfig(visibility=
# ["app"])`, and that is deliberate. FastMCP treats a tool with BOTH
# `meta.fastmcp.app` and `visibility == ["app"]` as a "backend tool" and drops
# it from `tools/list` altogether — its own source calls this out as a
# deviation: "FIXME: the latter isn't correct behavior according to the
# mcp-apps spec". A dropped tool is uncallable in practice, because hosts
# resolve names against the list they cached: the official basic-host raises
# `Unknown tool: workspace_snapshot` before it ever reaches the server.
#
# Writing the marker without `app=` keeps the tool listed, so any host can
# call it, while still telling a spec-aware host to keep it away from the
# model. Under FastMCP 3.4.2 the tool does remain model-visible; that is the
# SDK's gap, not a decision made here, and the honest cost of the workaround.
APP_ONLY_TOOL_META: dict[str, Any] = {UI_META_KEY: {"visibility": ["app"]}}


def model_visible(meta: dict[str, Any] | None) -> bool:
    """Whether a tool's `_meta` leaves it visible to the model.

    The spec's default is `["model", "app"]`, so an absent marker means
    visible. Used by the wire tests to count discovery-facing tools by what
    the spec says rather than by what one SDK version happens to list.
    """
    ui = (meta or {}).get(UI_META_KEY)
    visibility = ui.get("visibility") if isinstance(ui, dict) else None
    if not isinstance(visibility, list):
        return True
    return "model" in visibility


def tool_meta() -> dict[str, Any]:
    """The `_meta` block that points a tool result at the workspace UI."""
    return {RESOURCE_URI_META_KEY: WORKSPACE_URI}


def result_meta() -> dict[str, Any]:
    """`tool_meta` plus the preferred nested spelling, for the call result.

    The decorator puts both forms on the tool *definition*; a host that only
    inspects the *result* needs the same pointer there, so it is emitted in
    both places. Both spellings, not one: `registerAppTool` in the pinned SDK
    normalizes `_meta.ui.resourceUri` and the deprecated
    `_meta["ui/resourceUri"]` into each other "for compatibility with older
    hosts", and app.d.ts tells hosts to read `uiMeta?.resourceUri ?? legacyUri`.
    Emitting the pair is what that recommendation asks for.

    This pointer is now the *whole* UI payload of the result. The document it
    names is fetched separately, by the host, via `resources/read`.
    """
    return {**tool_meta(), UI_META_KEY: {"resourceUri": WORKSPACE_URI}}


def workspace_resource() -> dict[str, Any]:
    """The UI resource block, in the shape the official spec defines.

    This is what `resources/read ui://watch-skill/workspace` answers with, and
    it is the *only* place the document is allowed to cross the protocol. It
    is deliberately not reachable from any tool result — see
    `workspace_tool_result` for why.
    """
    return {
        "type": "resource",
        "resource": {
            "uri": WORKSPACE_URI,
            "mimeType": RESOURCE_MIME_TYPE,
            "text": workspace_html(),
            "_meta": resource_meta(),
        },
    }


def workspace_summary(session_id: str | None = None, mode: str = "auto") -> str:
    """The canonical workspace state, in words.

    This is the whole payload of the tool result. The words are not a fallback
    afterthought: a host that cannot render MCP Apps still gets a usable
    answer, and the agent reading the transcript gets the canonical state
    rather than a note saying a UI was shown somewhere it cannot see.
    """
    from watch_skill import workspace

    if mode == "new":
        state = workspace.snapshot(None)
        state["session"] = None
        state["events"] = []
    else:
        state = workspace.snapshot(session_id)

    return _summary(state)


def workspace_tool_result(session_id: str | None = None,
                          mode: str = "auto") -> ToolResult:
    """The tool result: state in words, plus a pointer to the UI. No HTML.

    Two separate defects were found here, and the second was created by the
    fix for the first, so both are worth naming.

    The original bug was a *serialization* one: the tool returned a list of
    plain dicts, FastMCP's `_convert_to_content` dispatches on instance type,
    no `ContentBlock` branch matched, and the whole list was JSON-dumped into
    one `TextContent`. The host saw no UI resource at all, and 514 KB of
    workspace HTML landed in the model's context as text.

    Returning real `mcp.types` blocks fixed the protocol shape but kept the
    document in the result, now as an `EmbeddedResource` — 528 KB on the wire.
    Claude Desktop treated that as tool output, and it exceeded the tool-output
    cap, so the result was diverted to a file and the app still never rendered.

    Embedding was never the contract. ext-apps 1.7.5 is explicit: the tool
    advertises `_meta.ui.resourceUri`, and "the host fetches the resource and
    displays it in a sandboxed iframe". The quickstart's tool handler returns
    `{ content: [{ type: "text", text: ... }] }` and nothing else; the document
    is served by `registerAppResource` through `resources/read`. So the pointer
    below is the entire UI contribution of this result, and the document goes
    out exactly once, only when the host asks for it by URI.
    """
    return ToolResult(
        content=[
            mt.TextContent(type="text", text=workspace_summary(session_id, mode)),
        ],
        meta=result_meta(),
    )


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
        # Only genuinely pending ones. `state["approvals"]` carries every
        # approval the session ever raised, including `expired` and already
        # decided records, and counting the lot told the model that two
        # expired requests were "awaiting a human decision" — a prompt to act
        # where no action is possible. The rendered workspace filters the same
        # way, so the words and the view now agree.
        pending = [approval for approval in (state.get("approvals") or [])
                   if approval.get("status") == "pending"]
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
    "APP_ONLY_TOOL_META",
    "CONTENT_SECURITY_POLICY",
    "MCP_APPS_SDK_VERSION",
    "RESOURCE_MIME_TYPE",
    "RESOURCE_URI_META_KEY",
    "UI_META_KEY",
    "WORKSPACE_URI",
    "bundle_available",
    "model_visible",
    "bundle_path",
    "resource_app_config",
    "resource_meta",
    "result_meta",
    "tool_app_config",
    "tool_meta",
    "workspace_html",
    "workspace_resource",
    "workspace_summary",
    "workspace_snapshot_json",
    "workspace_tool_result",
]
