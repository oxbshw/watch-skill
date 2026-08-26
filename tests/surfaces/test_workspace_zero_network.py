"""The built workspace document, executed with the network taken away.

Static scanning already missed this class of defect once. `inline.mjs` refuses
to write a document containing a literal `/_next/static/...` reference, and it
was telling the truth — the reference was never literal. Webpack builds an
async chunk URL at runtime out of an id and a hash map:

    r.u = e => "static/chunks/" + e + "." + ({751:"86f3175086c57402"})[e] + ".js"

so `workspace.html` passed every string check while still reaching for a file
that only exists in `app/out/`. Inside an MCP host there is no `app/out/` and
no server at all — the document arrives as a string in a sandbox — and the
one code path that needed the chunk was the MCP path, the only path no test
exercised. The workspace rendered "No workspace transport" instead.

This file closes that gap the only way it can be closed: run the real artifact
in a real browser, intercept every request, and let the document ask for
whatever it likes. The two document fetches are fulfilled; everything else is
recorded and aborted. A chunk request cannot hide from that, whatever webpack
names it next.

Both transports are exercised, because they are different code paths and the
broken one was the untested one:

  standalone — a `watch-skill-api` meta tag, HTTP to the dev host
  mcp        — no meta tag, `App.connect()` over postMessage to a host

The MCP scenario speaks enough of the real MCP Apps protocol for `connect()`
to resolve, so the assertions cover a *connected* workspace rather than one
still deciding what it is.
"""
from __future__ import annotations

import json
import re
from typing import Any

import pytest

pytest.importorskip("playwright", reason="playwright is not installed")

from playwright.sync_api import sync_playwright  # noqa: E402

from watch_skill.surfaces.mcp.workspace_app import (  # noqa: E402
    bundle_available,
    bundle_path,
)

pytestmark = pytest.mark.timeout(300)

# Two origins that do not exist. Every request to them is answered from
# memory, so a relative asset reference resolves to a recordable URL on a
# host that is guaranteed not to be reachable by accident.
WORKSPACE_ORIGIN = "https://workspace.test"
HOST_ORIGIN = "https://host.test"

# The version the pinned SDK negotiates (`app.js`: `var E = "2026-01-26"`).
UI_PROTOCOL_VERSION = "2026-01-26"

MOCK_HOST_HTML = """<!doctype html><meta charset="utf-8">
<title>zero-network MCP Apps host</title>
<style>html,body{margin:0;height:100%%}iframe{width:100%%;height:100%%;border:0}</style>
<script>
// Enough of the host half of MCP Apps for App.connect() to resolve: answer
// `ui/initialize`, then serve the two tools the workspace reads state with.
// Deliberately not a sandbox proxy — this file is about what the document
// *fetches*, and a second nested frame would only add origins to reason about.
window.__toolCalls = [];
window.__uiInitialized = false;
const PAYLOADS = %(payloads)s;
addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || msg.jsonrpc !== "2.0" || msg.id === undefined) return;
  const frame = document.getElementById("app");
  const send = (body) => frame.contentWindow.postMessage(
    Object.assign({jsonrpc: "2.0", id: msg.id}, body), "*");

  if (msg.method === "ui/initialize") {
    window.__uiInitialized = true;
    send({result: {
      protocolVersion: %(version)s,
      hostInfo: {name: "zero-network-host", version: "0"},
      hostCapabilities: {},
      hostContext: {},
    }});
    return;
  }
  if (msg.method === "tools/call") {
    const name = msg.params && msg.params.name;
    window.__toolCalls.push(name);
    const text = PAYLOADS[name];
    if (text === undefined) {
      send({error: {code: -32601, message: "Unknown tool: " + name}});
    } else {
      send({result: {content: [{type: "text", text: text}]}});
    }
    return;
  }
  send({result: {}});
});
</script>
<iframe id="app" src="%(workspace)s/"></iframe>
"""


def _require_browser() -> None:
    from tests.conftest import require_verification_browser  # noqa: PLC0415

    # One browser, one page, no capture pipeline — far below the two-browser
    # scenarios, but measured rather than assumed.
    require_verification_browser(1, scenario_mb=400.0)


def _snapshot_payload() -> str:
    from watch_skill import workspace  # noqa: PLC0415

    return json.dumps(workspace.snapshot(None), ensure_ascii=False, default=str)


def _delta_payload(snapshot_json: str) -> str:
    snapshot = json.loads(snapshot_json)
    session = snapshot.get("session")
    return json.dumps({
        "schema_version": snapshot.get("schema_version", 1),
        "session_id": (session or {}).get("session_id"),
        "state": (session or {}).get("state"),
        "events": [],
        "cursor": snapshot.get("cursor"),
        "gap": False,
    }, ensure_ascii=False, default=str)


class Run:
    """What one scripted load of the document did to the network."""

    def __init__(self) -> None:
        self.requests: list[str] = []
        self.console: list[str] = []
        self.body_text: str = ""
        self.tool_calls: list[str] = []
        self.ui_initialized: bool = False

    @property
    def asset_requests(self) -> list[str]:
        """Every request that was not one of the two fulfilled documents."""
        return list(self.requests)


def _run_document(html: str, *, mode: str, timeout_ms: int = 20_000) -> Run:
    """Load `html` with the network intercepted, and report what it asked for.

    `mode` is "mcp" (framed by a host that speaks the handshake) or
    "standalone" (a `watch-skill-api` meta tag and stubbed API responses).
    """
    run = Run()
    snapshot_json = _snapshot_payload()

    if mode == "standalone":
        # The tag is what `standaloneBase()` looks for. Injected here rather
        # than baked into the artifact, because the shipped document must not
        # carry an origin — see `devhost._bundle`.
        tag = f'<head><meta name="watch-skill-api" content="{WORKSPACE_ORIGIN}">'
        document = html.replace("<head>", tag, 1)
        assert document != html, "no <head> to inject the standalone tag into"
        entry = f"{WORKSPACE_ORIGIN}/"
    else:
        document = html
        entry = f"{HOST_ORIGIN}/"

    host_html = MOCK_HOST_HTML % {
        "payloads": json.dumps({
            "workspace_snapshot": snapshot_json,
            "workspace_delta": _delta_payload(snapshot_json),
        }),
        "version": json.dumps(UI_PROTOCOL_VERSION),
        "workspace": WORKSPACE_ORIGIN,
    }

    def handler(route: Any, request: Any) -> None:
        url = request.url
        if url in (f"{HOST_ORIGIN}/", HOST_ORIGIN):
            route.fulfill(status=200, content_type="text/html; charset=utf-8",
                          body=host_html)
            return
        if url in (f"{WORKSPACE_ORIGIN}/", WORKSPACE_ORIGIN):
            route.fulfill(status=200, content_type="text/html; charset=utf-8",
                          body=document)
            return
        if mode == "standalone" and url.startswith(f"{WORKSPACE_ORIGIN}/api/"):
            # The dev host's data endpoints. Data, not assets: answering them
            # keeps the standalone path alive far enough to render, and they
            # are excluded from the asset count on purpose.
            body = snapshot_json if "snapshot" in url else _delta_payload(snapshot_json)
            route.fulfill(status=200, content_type="application/json",
                          body=body)
            return
        # Anything else is the thing this test exists to catch.
        run.requests.append(url)
        route.abort()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            page = browser.new_page(viewport={"width": 1280, "height": 900})
            page.on("console", lambda m: run.console.append(f"[{m.type}] {m.text}"))
            page.route("**/*", handler)
            page.goto(entry, wait_until="load")
            frame = page.frame_locator("#app") if mode == "mcp" else None
            try:
                if frame is not None:
                    frame.locator(".shell").first.wait_for(timeout=timeout_ms)
                else:
                    page.locator(".shell").first.wait_for(timeout=timeout_ms)
            except Exception:  # noqa: BLE001 — the state is the assertion, not this
                pass
            # Let anything late — a lazy chunk, a font, a retry — actually fire.
            page.wait_for_timeout(2_500)
            if mode == "mcp":
                run.tool_calls = page.evaluate("window.__toolCalls || []")
                run.ui_initialized = bool(page.evaluate("window.__uiInitialized"))
                run.body_text = page.frame_locator("#app").locator("body").inner_text()
            else:
                run.body_text = page.locator("body").inner_text()
        finally:
            browser.close()
    return run


@pytest.fixture(scope="module")
def built_html() -> str:
    if not bundle_available():
        pytest.skip("the workspace bundle is not built; run `npm --prefix app run build`")
    _require_browser()
    return bundle_path().read_text(encoding="utf-8")


# --- the artifact, executed ---------------------------------------------------


def test_mcp_path_makes_no_asset_requests(built_html) -> None:
    """The path that was broken, asserted against the real document.

    On the previous build this fails with a request for
    `_next/static/chunks/751.<hash>.js`.
    """
    run = _run_document(built_html, mode="mcp")
    assert run.asset_requests == [], (
        f"the document reached for {len(run.asset_requests)} asset(s) it cannot "
        f"have inside a sandbox: {run.asset_requests[:5]}")


def test_mcp_path_connects_its_transport(built_html) -> None:
    """Self-containment is only worth anything if the app still works."""
    run = _run_document(built_html, mode="mcp")
    assert run.ui_initialized, (
        "the app never sent ui/initialize; the MCP transport did not start")
    assert "workspace_snapshot" in run.tool_calls, (
        f"the connected app never read canonical state; calls={run.tool_calls}")
    assert "No workspace transport" not in run.body_text, run.body_text[:400]


def test_standalone_path_makes_no_asset_requests(built_html) -> None:
    """The path that always worked, so it keeps working."""
    run = _run_document(built_html, mode="standalone")
    assert run.asset_requests == [], (
        f"standalone reached for {len(run.asset_requests)} asset(s): "
        f"{run.asset_requests[:5]}")


def test_no_request_names_a_chunk_a_script_or_a_remote_origin(built_html) -> None:
    """The categories named in the self-containment goal, counted separately.

    One assertion per failure mode, so a regression says which kind it is
    rather than only that the count went up.
    """
    for mode in ("mcp", "standalone"):
        run = _run_document(built_html, mode=mode)
        urls = run.asset_requests
        assert [u for u in urls if "_next" in u] == [], f"{mode}: _next request"
        assert [u for u in urls if u.split("?")[0].endswith(".js")] == [], f"{mode}: js"
        assert [u for u in urls if u.split("?")[0].endswith(".css")] == [], f"{mode}: css"
        assert [u for u in urls if "chunk" in u.lower()] == [], f"{mode}: chunk"
        assert [u for u in urls
                if u.split("?")[0].endswith((".woff", ".woff2", ".ttf", ".otf"))
                ] == [], f"{mode}: font"
        assert [u for u in urls
                if u.split("?")[0].endswith(
                    (".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"))
                ] == [], f"{mode}: image"
        assert [u for u in urls
                if not u.startswith((WORKSPACE_ORIGIN, HOST_ORIGIN))
                ] == [], f"{mode}: remote origin"


# --- the harness, aimed at a document that does the wrong thing ---------------


def test_the_harness_catches_a_chunk_fetch() -> None:
    """Proof the interception detects what it claims to detect.

    Without this, every assertion above could be passing because the harness
    records nothing. The document below asks for a chunk by exactly the route
    webpack uses — a URL assembled at runtime, invisible to any string scan of
    the source — and the harness must see it.
    """
    escaping = (
        "<!doctype html><html><head></head><body>"
        "<div class='shell'>pretending to be the workspace</div>"
        "<script>"
        # Built the way webpack builds it: never a literal path in the source.
        "var u=function(e){return 'static/chunks/'+e+'.'+({751:'86f3175086c57402'})[e]+'.js'};"
        "var s=document.createElement('script');"
        "s.src='/_next/'+u(751);"
        "document.head.appendChild(s);"
        "</script></body></html>"
    )
    run = _run_document(escaping, mode="mcp", timeout_ms=4_000)
    assert run.asset_requests, "the harness recorded nothing — it is blind"
    assert any("751" in url and "_next" in url for url in run.asset_requests), (
        f"the chunk request was not recorded: {run.asset_requests}")


def test_the_harness_records_a_remote_origin() -> None:
    """The other half: a request off-origin is caught too."""
    escaping = (
        "<!doctype html><html><head></head><body><div class='shell'>x</div>"
        "<script>fetch('https://cdn.example.com/app.js').catch(function(){});</script>"
        "</body></html>"
    )
    run = _run_document(escaping, mode="mcp", timeout_ms=4_000)
    assert any("cdn.example.com" in url for url in run.asset_requests), (
        f"remote origin not recorded: {run.asset_requests}")


# --- the same invariant, read straight off the artifact -----------------------


ASYNC_CHUNK_TABLE = re.compile(r'"static/chunks/"[^;]{0,4000}?\(\{([^{}]*)\}\)')
CHUNK_ENTRY = re.compile(r'(\d+)\s*:\s*"([0-9a-f]+)"')


def test_every_async_chunk_is_already_in_the_document(built_html) -> None:
    """The build guard's invariant, asserted where CI will see it.

    `inline.mjs` folds in every chunk webpack's table can name, so `r.e()`
    resolves from memory. This proves it happened, and it does so by reading
    the same table webpack reads rather than by matching a filename — a new
    dynamic import shows up here under whatever id the next build gives it.

    The runtime test above is the stronger statement, because it lets the
    document ask. This one is the fast one, and it still fails on the previous
    build: chunk 751 was in the table and nowhere in the document.
    """
    table = ASYNC_CHUNK_TABLE.search(built_html)
    if table is None:
        # No table at all is the ideal end state: nothing to fetch.
        return
    ids = [chunk_id for chunk_id, _ in CHUNK_ENTRY.findall(table.group(1))]
    missing = [
        chunk_id for chunk_id in ids
        if f"[[{chunk_id}]" not in built_html and f"[[{chunk_id}," not in built_html
    ]
    assert missing == [], (
        f"webpack can request chunk(s) {missing} and the document does not "
        f"contain them; inside a sandbox that is a failed fetch, not a 404")
