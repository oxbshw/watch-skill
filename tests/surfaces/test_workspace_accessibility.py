"""Accessibility, keyboard reach, and reduced motion — on the real bundle.

An evidence tool that only works for people who can see colour, use a mouse,
and tolerate motion is not finished. These run against the same production
Next.js build every other proof uses, in a real browser, because an audit of a
mock says nothing about what ships.

axe-core is injected from `node_modules` rather than a CDN: the workspace CSP
has no remote origins, and a test that fetched its own auditor would be
testing a page the product never serves.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from watch_skill.surfaces.mcp.devhost import DevHost
from watch_skill.surfaces.mcp.workspace_app import bundle_available

REPO = Path(__file__).resolve().parents[2]
AXE = REPO / "app" / "node_modules" / "axe-core" / "axe.min.js"

pytestmark = pytest.mark.timeout(600)


def _require_bundle() -> None:
    if not bundle_available():
        pytest.skip("the workspace bundle is not built; run "
                    "`npm --prefix app install && npm --prefix app run build`")


@pytest.fixture
def page_and_host():
    _require_bundle()
    from playwright.sync_api import sync_playwright

    with DevHost() as host, sync_playwright() as play:
        browser = play.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.goto(host.base_url, wait_until="domcontentloaded")
        page.wait_for_selector("header.header", timeout=60_000)
        try:
            yield page, host
        finally:
            browser.close()


def test_the_workspace_has_no_serious_accessibility_violations(
    page_and_host, record_property,
) -> None:
    """Serious and critical only. Not every axe rule is a real defect here,
    but a serious one on a tool people work in all day is."""
    if not AXE.is_file():
        pytest.skip(f"axe-core is not installed at {AXE.parent.name}; run "
                    "`npm --prefix app install`")
    page, _ = page_and_host

    page.add_script_tag(content=AXE.read_text(encoding="utf-8"))
    result = page.evaluate(
        """async () => {
            const run = await window.axe.run(document, {
              resultTypes: ['violations'],
            });
            return run.violations.map(v => ({
              id: v.id, impact: v.impact, help: v.help,
              nodes: v.nodes.slice(0, 3).map(n => n.html.slice(0, 160)),
            }));
        }""")

    record_property("axe_violations", json.dumps(result))
    blocking = [v for v in result if v.get("impact") in ("serious", "critical")]
    assert not blocking, (
        "serious accessibility violations:\n"
        + json.dumps(blocking, indent=2)[:2000])


def test_every_control_is_reachable_by_keyboard(page_and_host) -> None:
    """Tab has to get to the things that matter, and focus has to be visible.

    A workspace whose approve button can only be clicked is one a
    keyboard-driven operator cannot use for the single most consequential
    action it offers.
    """
    page, _ = page_and_host

    reached: list[str] = []
    for _ in range(40):
        page.keyboard.press("Tab")
        info = page.evaluate(
            """() => {
                const el = document.activeElement;
                if (!el || el === document.body) return null;
                const style = getComputedStyle(el);
                return {
                  tag: el.tagName.toLowerCase(),
                  label: (el.getAttribute('aria-label') ||
                          el.textContent || '').trim().slice(0, 40),
                  outline: style.outlineStyle,
                  outlineWidth: style.outlineWidth,
                  boxShadow: style.boxShadow,
                };
            }""")
        if info is None:
            continue
        reached.append(f"{info['tag']}:{info['label']}")
        # Focus must be *visible*, not merely present. A focus ring removed
        # for tidiness is the most common way a keyboard user gets lost.
        visible = (info["outline"] not in ("none", "") or
                   info["boxShadow"] not in ("none", ""))
        assert visible, (
            f"focused element has no visible focus indicator: {info}")

    assert len(reached) >= 5, f"tab reached almost nothing: {reached}"
    # The session rail and the stage controls are the two things an operator
    # always needs; both must be in the tab order.
    joined = " ".join(reached).lower()
    assert "button" in joined


def test_motion_is_dropped_when_the_operator_asks_for_less(
    page_and_host,
) -> None:
    """`prefers-reduced-motion` is honoured by the stylesheet, not ignored."""
    page, host = page_and_host

    page.emulate_media(reduced_motion="reduce")
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("header.header", timeout=60_000)

    worst = page.evaluate(
        """() => {
            let maxMs = 0;
            for (const el of document.querySelectorAll('*')) {
              const s = getComputedStyle(el);
              for (const raw of [s.transitionDuration, s.animationDuration]) {
                for (const part of (raw || '').split(',')) {
                  const t = part.trim();
                  if (!t) continue;
                  const ms = t.endsWith('ms') ? parseFloat(t)
                           : t.endsWith('s') ? parseFloat(t) * 1000 : 0;
                  if (ms > maxMs) maxMs = ms;
                }
              }
            }
            return maxMs;
        }""")
    assert worst <= 1.0, (
        f"an animation still runs for {worst}ms under reduced-motion")


def test_the_narrow_viewport_stays_usable(page_and_host) -> None:
    """An embedded MCP host can be 420px wide, and it is still the same tool.

    The failure this guards against is not ugliness — it is a horizontally
    scrolling body, which on a dense evidence panel hides the right-hand half
    of every line with no indication that it exists.
    """
    page, _ = page_and_host

    page.set_viewport_size({"width": 420, "height": 820})
    page.wait_for_timeout(250)

    overflow = page.evaluate(
        """() => ({
            bodyScroll: document.body.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
        })""")
    assert overflow["bodyScroll"] <= overflow["clientWidth"] + 1, (
        f"the page scrolls horizontally at 420px: "
        f"{overflow['bodyScroll']} > {overflow['clientWidth']}")

    # The header must not stack into a tall column and push everything off.
    header = page.locator("header.header").bounding_box()
    assert header is not None and header["height"] < 260, (
        f"the header is {header and header['height']}px tall at 420px wide")

    # Tap targets stay tappable.
    small = page.evaluate(
        """() => [...document.querySelectorAll('button')]
              .filter(b => b.offsetParent !== null)
              .map(b => b.getBoundingClientRect().height)
              .filter(h => h > 0 && h < 24).length""")
    assert small == 0, f"{small} visible button(s) are under 24px tall"


def test_the_states_a_screen_reader_must_reach_are_named(page_and_host) -> None:
    """Preview, evidence and verdict are the three things a reader must find.

    Colour and position carry these for a sighted operator. Without an
    accessible name, a screen-reader user gets three unlabelled regions and no
    way to tell the live preview from the verification verdict.
    """
    page, _ = page_and_host

    for label in ("Live stage", "Evidence", "Verification", "Sessions",
                  "Vision model"):
        region = page.locator(f'[aria-label="{label}"]')
        assert region.count() > 0, f"no region named {label!r}"

    # The evidence tabs are a real tablist, not a row of styled divs.
    tablist = page.locator('[role="tablist"]')
    assert tablist.count() > 0, "the evidence tabs are not a tablist"
    tabs = page.locator('[role="tab"]')
    assert tabs.count() >= 5, f"only {tabs.count()} tabs are exposed"
    selected = page.evaluate(
        """() => [...document.querySelectorAll('[role="tab"]')]
              .filter(t => t.getAttribute('aria-selected') === 'true').length""")
    assert selected == 1, f"{selected} tabs claim to be selected"

    # Connection and verdict changes are announced rather than merely redrawn.
    live_regions = page.locator('[aria-live], [role="status"], [role="alert"]')
    assert live_regions.count() > 0, (
        "nothing is announced; state changes would be silent")


def test_both_themes_are_first_class(page_and_host) -> None:
    """Dark is not an afterthought with unreadable text in it."""
    page, _ = page_and_host

    for scheme in ("light", "dark"):
        page.emulate_media(color_scheme=scheme)
        page.wait_for_timeout(150)
        painted = page.evaluate(
            """() => {
                const body = getComputedStyle(document.body);
                return { bg: body.backgroundColor, fg: body.color };
            }""")
        # A transparent body borrows whatever the host paints behind it, which
        # is how a workspace ends up with dark text on a dark ground.
        assert painted["bg"] not in ("rgba(0, 0, 0, 0)", "transparent"), (
            f"{scheme}: body has no explicit background")
        assert painted["fg"], f"{scheme}: body has no explicit colour"
