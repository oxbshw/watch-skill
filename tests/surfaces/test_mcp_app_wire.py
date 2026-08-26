"""The MCP Apps surface as it exists *after serialization*.

Every other workspace test inspects Python objects. That was not enough twice
running, because both defects lived downstream of the objects:

1. The tool returned a list of plain dicts. FastMCP's `_convert_to_content`
   dispatches on instance type, no `ContentBlock` branch matched, and the whole
   list was JSON-dumped into one `TextContent`. The host saw no UI resource at
   all and 514 KB of HTML became model-visible text.
2. The fix for (1) returned real `mcp.types` blocks — protocol-valid, and still
   carrying the document, now as an `EmbeddedResource`. Claude Desktop treated
   the 528 KB result as tool output, blew the tool-output cap, diverted it to a
   file, and the app still never rendered.

Neither was visible in-process. So the rule for this file: assert only on
values that have been through `model_dump_json` and back.

The contract being defended is the one ext-apps 1.7.5 defines — the tool
advertises `_meta.ui.resourceUri` and returns data, and the host fetches the
document itself via `resources/read`:

    "When the host calls this tool, it reads `_meta.ui.resourceUri` to know
     which resource to fetch and render as an interactive UI."
    — MCP Apps Quickstart

so the document must cross the wire in exactly one place, and it is not the
tool result.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

pytest.importorskip("fastmcp", reason="mcp extra not installed")
pytest.importorskip("scenedetect", reason="perceive extra not installed")

import mcp.types as mt  # noqa: E402
from fastmcp import Client  # noqa: E402

from watch_skill.surfaces.mcp.server import mcp  # noqa: E402
from watch_skill.surfaces.mcp.workspace_app import (  # noqa: E402
    RESOURCE_MIME_TYPE,
    WORKSPACE_URI,
    model_visible,
)

# The strict ceiling for the whole serialized tool result. The summary is a
# few hundred bytes and the document is ~514 KB, so there are three orders of
# magnitude of headroom here; anything approaching this number means a payload
# nobody intended has started riding along.
TOOL_RESULT_CEILING_BYTES = 20_000

# Present in the built bundle, absent from everything else. Used to count
# document copies rather than infer them from size.
BUNDLE_MARKER = "watch_skill_workspace"


def _wire(obj: Any) -> Any:
    """Round-trip through JSON exactly as the transport does."""
    return json.loads(obj.model_dump_json(by_alias=True))


def _meta_of(payload: dict[str, Any]) -> dict[str, Any]:
    """`_meta` on the wire; `meta` is the pydantic field name behind it."""
    return payload.get("_meta") or payload.get("meta") or {}


def _ui_resource_uri(meta: dict[str, Any]) -> str | None:
    """Read the pointer the way the SDK tells hosts to read it.

    dist/src/app.d.ts: `const uiUri = uiMeta?.resourceUri ?? legacyUri`.
    """
    ui = meta.get("ui")
    modern = ui.get("resourceUri") if isinstance(ui, dict) else None
    return modern or meta.get("ui/resourceUri")


def assert_result_carries_no_document(payload: dict[str, Any]) -> None:
    """The regression predicate, in one place so it can be aimed at two things.

    Applied to the current implementation it must pass; applied to the
    implementation this replaced it must fail. A predicate that only ever sees
    the passing case is not evidence that it detects anything.
    """
    serialized = json.dumps(payload)
    assert len(serialized) < TOOL_RESULT_CEILING_BYTES, (
        f"the serialized tool result is {len(serialized)} bytes; the ceiling "
        f"is {TOOL_RESULT_CEILING_BYTES}. A host applies its tool-output cap "
        f"to this number.")

    types = [b["type"] for b in payload.get("content", [])]
    assert "resource" not in types, (
        f"the result carries an EmbeddedResource ({types}). The host fetches "
        f"the UI through resources/read; embedding it duplicates the document "
        f"and turns a render into tool output.")

    assert BUNDLE_MARKER not in serialized, "the workspace bundle is in the result"
    assert "<!DOCTYPE html" not in serialized
    assert "<!doctype html" not in serialized
    # The first defect's signature: the whole block list dumped as one string.
    for block in payload.get("content", []):
        if block["type"] == "text":
            assert not block["text"].lstrip().startswith('[{"type"')


@pytest.fixture(scope="module")
def session() -> dict[str, Any]:
    """One connection, every wire payload the assertions below need.

    The `*_mcp` client methods are the point. Their friendlier siblings
    (`call_tool`, `list_tools`) hand back FastMCP's own convenience objects,
    which are parsed and partly reassembled; these return the raw
    `mcp.types.*Result` models — the protocol payload itself — which is what
    gets serialized here and asserted against as plain JSON.
    """

    async def _run() -> dict[str, Any]:
        async with Client(mcp) as client:
            tools = await client.list_tools_mcp()
            resources = await client.list_resources_mcp()
            called = await client.call_tool_mcp("watch_workspace", {})
            # Deliberately not allowed to raise. An unregistered resource is
            # one of the failures under test, and letting it abort the shared
            # fixture would collapse every case in this file into the same
            # error — which is how a regression suite stops telling you which
            # thing broke.
            try:
                read_result = _wire(await client.read_resource_mcp(WORKSPACE_URI))
                read, read_error = read_result["contents"], None
            except Exception as exc:  # noqa: BLE001 — recorded, then asserted on
                read_result, read, read_error = {}, [], f"{type(exc).__name__}: {exc}"
            return {
                "initialized": client.is_connected(),
                "tools": _wire(tools)["tools"],
                "resources": _wire(resources)["resources"],
                "read": read,
                "read_result": read_result,
                "read_error": read_error,
                "call": _wire(called),
            }

    return asyncio.run(_run())


# --- A/B: the server is up and still advertises the one workspace tool -------


def test_initialize_succeeds(session) -> None:
    assert session["initialized"]


def test_tools_list_contains_watch_workspace(session) -> None:
    names = [t["name"] for t in session["tools"]]
    assert "watch_workspace" in names
    # One discovery-facing workspace tool, not a UI action surface. Counted by
    # `visibility` rather than by name, because the workspace *does* have
    # sibling tools now — `workspace_snapshot` and `workspace_delta`, which the
    # rendered app calls to read canonical state. Those carry
    # `_meta.ui.visibility == ["app"]`, the spec's marker for "callable by the
    # app, not offered to the model", so they are listed but not discovery-
    # facing. If a genuinely model-visible sibling ever appears, this fires.
    workspace_tools = [t for t in session["tools"] if "workspace" in t["name"]]
    visible = [t["name"] for t in workspace_tools if model_visible(_meta_of(t))]
    assert visible == ["watch_workspace"], (
        f"expected one model-visible workspace tool, got {visible}")


def test_the_apps_state_tools_are_listed_and_marked_app_only(session) -> None:
    """The tools the rendered workspace reads state with.

    Listed, because a host resolves a tool call against the list it cached —
    the official basic-host raises `Unknown tool` before the request ever
    leaves the browser — and marked `["app"]`, because no agent should be
    picking them out of a tool list.
    """
    by_name = {t["name"]: t for t in session["tools"]}
    for name in ("workspace_snapshot", "workspace_delta"):
        assert name in by_name, f"{name} is not callable by the app"
        assert _meta_of(by_name[name])["ui"]["visibility"] == ["app"]


def test_the_tool_definition_advertises_its_ui_resource(session) -> None:
    """What a host reads at connection time to know this tool renders.

    This pointer is the entire mechanism now. If it is wrong or missing, the
    host has no way to find the document, because nothing else in the result
    mentions it.
    """
    tool = next(t for t in session["tools"] if t["name"] == "watch_workspace")
    meta = _meta_of(tool)
    assert _ui_resource_uri(meta) == WORKSPACE_URI
    # Both spellings, because the SDK normalizes them into each other "for
    # compatibility with older hosts". Dropping either loses a generation.
    assert meta["ui"]["resourceUri"] == WORKSPACE_URI
    assert meta["ui/resourceUri"] == WORKSPACE_URI


def test_the_tool_definition_carries_no_document(session) -> None:
    """tools/list is sent to every client at connection time, rendered or not."""
    tool = next(t for t in session["tools"] if t["name"] == "watch_workspace")
    assert BUNDLE_MARKER not in json.dumps(tool)


# --- C: the resource is real, resolvable, and the only carrier --------------


def test_resources_list_exposes_the_workspace(session) -> None:
    entries = {r["uri"]: r for r in session["resources"]}
    assert WORKSPACE_URI in entries, (
        f"{WORKSPACE_URI} is not registered; resources/list = {sorted(entries)}")
    assert entries[WORKSPACE_URI]["mimeType"] == RESOURCE_MIME_TYPE
    # The listing advertises the resource; it does not ship it.
    assert BUNDLE_MARKER not in json.dumps(entries[WORKSPACE_URI])


def test_resources_read_returns_the_workspace_document(session) -> None:
    assert session["read_error"] is None, (
        f"resources/read {WORKSPACE_URI} failed: {session['read_error']}")
    contents = session["read"]
    assert len(contents) == 1
    item = contents[0]
    assert item["uri"] == WORKSPACE_URI
    assert item["mimeType"] == RESOURCE_MIME_TYPE
    html = item["text"]
    assert html.lstrip().lower().startswith("<!doctype html"), html[:120]
    assert BUNDLE_MARKER in html, "not the built workspace bundle"
    # Large here is correct. This is the one message that should be big.
    assert len(html) > TOOL_RESULT_CEILING_BYTES


def test_the_read_document_is_the_real_bundle_not_the_placeholder(session) -> None:
    """The placeholder is a valid document too, and it renders nothing."""
    assert session["read_error"] is None, session["read_error"]
    assert "Workspace bundle not built" not in session["read"][0]["text"]


def test_the_read_content_item_carries_the_sandbox_policy(session) -> None:
    """Where the host actually looks for CSP and permissions.

    McpUiAppResourceConfig: the `resources/list` entry is "a static default
    for hosts to review at connection time", and "when the `resources/read`
    content item also includes `_meta.ui`, the content-item value takes
    precedence". So the read item is the authoritative copy and must carry it.
    """
    assert session["read_error"] is None, session["read_error"]
    ui = _meta_of(session["read"][0]).get("ui")
    assert isinstance(ui, dict), "no `_meta.ui` on the resources/read content item"
    # Self-contained document: no external origin for scripts, styles, fetch.
    assert ui["csp"]["connectDomains"] == []
    assert ui["csp"]["resourceDomains"] == []
    assert "permissions" in ui


# --- D/E: calling the tool --------------------------------------------------


def test_tools_call_watch_workspace_succeeds(session) -> None:
    assert session["call"].get("isError") in (False, None)


def test_the_wire_result_keeps_the_text_summary(session) -> None:
    """A host with no MCP App rendering still gets the answer in words."""
    texts = [b["text"] for b in session["call"]["content"] if b["type"] == "text"]
    assert texts, "no text block survived serialization"
    assert any("Watch Skill workspace" in t for t in texts)
    assert any("assurance" in t for t in texts)


def test_the_wire_result_carries_the_ui_association_metadata(session) -> None:
    """The pointer, on the result as well as the definition.

    A host that inspects only the result still has to be able to find the UI.
    """
    meta = _meta_of(session["call"])
    assert _ui_resource_uri(meta) == WORKSPACE_URI
    assert meta["ui"]["resourceUri"] == WORKSPACE_URI
    assert meta["ui/resourceUri"] == WORKSPACE_URI


def test_the_wire_result_is_text_only(session) -> None:
    blocks = session["call"]["content"]
    assert [b["type"] for b in blocks] == ["text"], (
        f"expected one text block, got {[b['type'] for b in blocks]}")


def test_the_wire_result_carries_no_document(session) -> None:
    """The defect that broke the Claude Desktop acceptance test."""
    assert_result_carries_no_document(session["call"])


def test_the_wire_result_stays_small(session) -> None:
    """Stated as a number, because a cap is a number."""
    size = len(json.dumps(session["call"]))
    assert size < TOOL_RESULT_CEILING_BYTES, size


# --- F: the document crosses the wire in exactly one place ------------------


def test_the_document_appears_only_in_resources_read(session) -> None:
    """Counted across every payload the host receives, not assumed."""
    assert session["read_error"] is None, session["read_error"]
    counts = {
        "tools/list": json.dumps(session["tools"]).count(BUNDLE_MARKER),
        "resources/list": json.dumps(session["resources"]).count(BUNDLE_MARKER),
        "tools/call": json.dumps(session["call"]).count(BUNDLE_MARKER),
        "resources/read": json.dumps(session["read_result"]).count(BUNDLE_MARKER),
    }
    assert counts["tools/list"] == 0, counts
    assert counts["resources/list"] == 0, counts
    assert counts["tools/call"] == 0, counts
    assert counts["resources/read"] == 1, counts


# --- H: the implementation this replaced, aimed at the same predicate -------


def test_the_previous_implementation_fails_the_new_assertion() -> None:
    """Proof the regression check detects the shape it was written for.

    This rebuilds the exact result `watch_workspace` used to return — text plus
    an `EmbeddedResource` holding the document — and runs it through the same
    predicate the live result passes. If this ever stops raising, the predicate
    has gone blind and every other assertion in this file is decoration.
    """
    from watch_skill.surfaces.mcp.workspace_app import workspace_html

    html = workspace_html()
    legacy = mt.CallToolResult(
        content=[
            mt.TextContent(type="text", text="Watch Skill workspace"),
            mt.EmbeddedResource(
                type="resource",
                resource=mt.TextResourceContents(
                    uri=WORKSPACE_URI,
                    mimeType=RESOURCE_MIME_TYPE,
                    text=html,
                ),
            ),
        ],
    )
    payload = _wire(legacy)

    with pytest.raises(AssertionError) as caught:
        assert_result_carries_no_document(payload)
    # Size is the failure Claude Desktop hit first; naming it here keeps this
    # test tied to the observed defect rather than to any assertion order.
    assert "ceiling" in str(caught.value)

    # And the same payload with the document removed passes, which isolates the
    # embedded document as the cause rather than anything else about the shape.
    payload["content"] = payload["content"][:1]
    assert_result_carries_no_document(payload)
