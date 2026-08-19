"""Doing the thing, then finding out whether it actually happened.

The order in `perform` is the argument of the whole module:

    observe -> resolve -> dispatch -> observe -> verify -> receipt

Dispatch sits in the middle, not at the end. Playwright returning from
`click()` proves a click was delivered to an element; it proves nothing about
the application. So the step is bracketed by observations, the difference
between them is the *effect*, and the verdict is the effect compared against
an expectation written down beforehand.

An action with no expectation is `UNVERIFIED` rather than `SUCCEEDED`. That is
not pedantry — "the agent said it worked" is exactly the failure this
subsystem exists to catch, and the runtime is not allowed to make that claim
on its own behalf either.
"""
from __future__ import annotations

import time
from typing import Any

from watch_skill.operate.observe import BrowserObservation, observe
from watch_skill.operate.resolve import DESTRUCTIVE_CONFIDENCE_FLOOR, resolve
from watch_skill.operate.types import (
    Action,
    ActionKind,
    ActionReceipt,
    Effects,
    Expectation,
    FailureKind,
    NetworkRecord,
    Resolution,
    SideEffect,
    Verdict,
)

# Actions that do not address an element. Everything else must resolve a
# target before it is allowed to touch the page.
TARGETLESS = {
    ActionKind.NAVIGATE, ActionKind.SCROLL, ActionKind.PRESS,
    ActionKind.SWITCH_TAB, ActionKind.CLOSE_TAB, ActionKind.HANDLE_DIALOG,
}


class NetworkLog:
    """Requests seen during one step, correlated by time window.

    Correlation is by window rather than by initiator: Playwright will not
    tell us which click caused which request, and pretending otherwise would
    be a fiction in the receipt. A window is honest and sufficient — it is
    what lets the verifier notice that "Saved" appeared while `PATCH
    /settings` returned 500.

    Query strings are dropped. A URL is evidence; a URL carrying a session
    token is a leak, and receipts are meant to be readable by people.
    """

    def __init__(self) -> None:
        self.records: list[tuple[float, NetworkRecord]] = []

    def attach(self, page: Any) -> None:
        page.on("response", self._on_response)
        page.on("requestfailed", self._on_failed)

    def detach(self, page: Any) -> None:
        for event, handler in (("response", self._on_response),
                               ("requestfailed", self._on_failed)):
            try:
                page.remove_listener(event, handler)
            except Exception:  # noqa: BLE001 - a closed page has no listeners
                continue

    def _on_response(self, response: Any) -> None:
        try:
            self.records.append((time.time(), NetworkRecord(
                method=response.request.method,
                url=_strip_query(response.url),
                status=response.status,
                ok=response.status < 400,
            )))
        except Exception:  # noqa: BLE001
            return

    def _on_failed(self, request: Any) -> None:
        try:
            self.records.append((time.time(), NetworkRecord(
                method=request.method, url=_strip_query(request.url),
                status=0, ok=False, failed=True)))
        except Exception:  # noqa: BLE001
            return

    def since(self, when: float) -> list[NetworkRecord]:
        return [record for at, record in self.records if at >= when][-40:]


def _strip_query(url: str) -> str:
    return str(url).split("?", 1)[0][:200]


class ConsoleLog:
    """Console errors during one step. Page-authored, so evidence only."""

    def __init__(self) -> None:
        self.errors: list[tuple[float, str]] = []

    def attach(self, page: Any) -> None:
        page.on("console", self._on_console)
        page.on("pageerror", self._on_error)

    def detach(self, page: Any) -> None:
        for event, handler in (("console", self._on_console),
                               ("pageerror", self._on_error)):
            try:
                page.remove_listener(event, handler)
            except Exception:  # noqa: BLE001
                continue

    def _on_console(self, message: Any) -> None:
        try:
            if message.type == "error":
                self.errors.append((time.time(), str(message.text)[:200]))
        except Exception:  # noqa: BLE001
            return

    def _on_error(self, error: Any) -> None:
        self.errors.append((time.time(), str(error)[:200]))

    def since(self, when: float) -> list[str]:
        return [text for at, text in self.errors if at >= when][-10:]


def _dispatch(page: Any, action: Action, locator: Any) -> None:
    """Perform the action. Raises on a Playwright-level failure."""
    kind = action.kind
    timeout = action.timeout_seconds * 1000

    if kind is ActionKind.NAVIGATE:
        page.goto(action.url, wait_until="domcontentloaded", timeout=timeout)
    elif kind is ActionKind.CLICK:
        locator.click(timeout=timeout)
    elif kind is ActionKind.DOUBLE_CLICK:
        locator.dblclick(timeout=timeout)
    elif kind is ActionKind.FILL:
        locator.fill(action.value, timeout=timeout)
    elif kind is ActionKind.TYPE:
        locator.press_sequentially(action.value, timeout=timeout)
    elif kind is ActionKind.CLEAR:
        locator.fill("", timeout=timeout)
    elif kind is ActionKind.SELECT:
        locator.select_option(action.value, timeout=timeout)
    elif kind is ActionKind.CHECK:
        locator.check(timeout=timeout)
    elif kind is ActionKind.UNCHECK:
        locator.uncheck(timeout=timeout)
    elif kind is ActionKind.HOVER:
        locator.hover(timeout=timeout)
    elif kind is ActionKind.PRESS:
        page.keyboard.press(action.keys)
    elif kind is ActionKind.SCROLL:
        page.mouse.wheel(0, action.delta_y or 400)
    elif kind is ActionKind.UPLOAD:
        locator.set_input_files(action.files, timeout=timeout)
    elif kind is ActionKind.WAIT_FOR:
        if action.target and action.target.selector:
            page.wait_for_selector(action.target.selector, timeout=timeout)
        else:
            page.wait_for_timeout(min(timeout, 5000))
    elif kind is ActionKind.SWITCH_TAB:
        pages = list(page.context.pages)
        index = action.tab_index if action.tab_index is not None else len(pages) - 1
        pages[max(0, min(index, len(pages) - 1))].bring_to_front()
    elif kind is ActionKind.CLOSE_TAB:
        page.close()
    else:
        raise ValueError(f"no dispatch for {kind.value}")


def _classify(exc: Exception) -> tuple[FailureKind, str]:
    """Turn a Playwright exception into something recovery can act on.

    Matching on message text is unlovely, and it is what the library gives us.
    The alternative — a single ACTION_ERROR for everything — would make the
    recovery engine useless, because "the element went stale" and "the element
    is covered by a modal" want completely different responses.
    """
    name = type(exc).__name__
    text = str(exc)
    lowered = text.lower()

    if "timeout" in lowered and "navigat" in lowered:
        return FailureKind.NAVIGATION_TIMEOUT, text[:300]
    if "element is not attached" in lowered or "stale" in lowered:
        return FailureKind.STALE_TARGET, text[:300]
    if "intercepts pointer events" in lowered or "obscured" in lowered:
        return FailureKind.TARGET_OBSCURED, text[:300]
    if "not enabled" in lowered or "disabled" in lowered:
        return FailureKind.TARGET_DISABLED, text[:300]
    if "strict mode violation" in lowered:
        return FailureKind.TARGET_AMBIGUOUS, text[:300]
    if "timeout" in lowered:
        return FailureKind.TARGET_NOT_FOUND, text[:300]
    if "net::" in lowered or "err_" in lowered:
        return FailureKind.NETWORK_FAILURE, text[:300]
    return FailureKind.ACTION_ERROR, f"{name}: {text[:280]}"


def verify(page: Any, expect: Expectation, effects: Effects,
           after: BrowserObservation) -> tuple[bool, str]:
    """Compare what was expected with what happened.

    Every clause is checked and the *first* failure is reported, because a
    reviewer wants the reason, not a list. `network_ok` is the clause that
    earns this module its keep: it is how a page that renders "Saved" over a
    500 gets rejected.
    """
    if expect.url_changes is True and not effects.navigated:
        return False, "expected a navigation and the URL did not change"
    if expect.url_changes is False and effects.navigated:
        return False, (f"expected to stay put but navigated to "
                       f"{effects.url_after}")
    if expect.url_contains and expect.url_contains not in after.url:
        return False, (f"expected {expect.url_contains!r} in the URL, got "
                       f"{after.url}")
    if expect.title_contains and expect.title_contains not in after.title:
        return False, (f"expected {expect.title_contains!r} in the title, got "
                       f"{after.title!r}")
    if expect.text_present and expect.text_present not in after.text:
        return False, f"expected the page to show {expect.text_present!r}"
    if expect.text_absent and expect.text_absent in after.text:
        return False, f"expected {expect.text_absent!r} to be gone"

    if expect.selector_present:
        if not _exists(page, expect.selector_present):
            return False, f"expected {expect.selector_present!r} to be present"
    if expect.selector_absent:
        if _exists(page, expect.selector_absent):
            return False, f"expected {expect.selector_absent!r} to be gone"
    if expect.element_enabled:
        if not _enabled(page, expect.element_enabled):
            return False, f"expected {expect.element_enabled!r} to be enabled"
    if expect.element_checked:
        if not _checked(page, expect.element_checked):
            return False, f"expected {expect.element_checked!r} to be checked"
    if expect.input_value:
        selector, wanted = expect.input_value
        actual = _value(page, selector)
        if actual != wanted:
            return False, (f"expected {selector!r} to hold {wanted!r}, "
                           f"found {actual!r}")

    if expect.no_console_errors and effects.console_errors:
        return False, (f"the page logged {len(effects.console_errors)} console "
                       f"error(s): {effects.console_errors[0]}")
    if expect.network_ok:
        bad = effects.failed_requests
        if bad:
            first = bad[0]
            return False, (f"{first.method} {first.url} returned "
                           f"{first.status or 'a transport failure'} while the "
                           f"UI reported success")
    return True, ""


def _exists(page: Any, selector: str) -> bool:
    try:
        return page.locator(selector).count() > 0
    except Exception:  # noqa: BLE001
        return False


def _enabled(page: Any, selector: str) -> bool:
    try:
        return page.locator(selector).first.is_enabled(timeout=1000)
    except Exception:  # noqa: BLE001
        return False


def _checked(page: Any, selector: str) -> bool:
    try:
        return page.locator(selector).first.is_checked(timeout=1000)
    except Exception:  # noqa: BLE001
        return False


def _value(page: Any, selector: str) -> str:
    try:
        return page.locator(selector).first.input_value(timeout=1000)
    except Exception:  # noqa: BLE001
        return ""


def _settle(page: Any, expect: Expectation) -> None:
    """Give the effect a bounded chance to appear.

    Event-driven where possible and capped either way. An unbounded
    `networkidle` on a page with a polling widget never returns, and a fixed
    sleep is a slower way of being wrong.
    """
    budget = max(0.0, min(expect.max_wait_seconds, 15.0))
    if budget <= 0:
        return
    try:
        page.wait_for_load_state("domcontentloaded", timeout=budget * 1000)
    except Exception:  # noqa: BLE001 - already loaded, or navigating again
        pass
    try:
        page.wait_for_timeout(min(400, budget * 1000))
    except Exception:  # noqa: BLE001
        pass


def perform(page: Any, action: Action, network: NetworkLog,
            console: ConsoleLog, epoch: int = 0,
            sequence: int = 0) -> ActionReceipt:
    """Run one action end to end and return its receipt. Browser thread only."""
    started = time.time()
    receipt = ActionReceipt(
        action_id=action.action_id, kind=action.kind, intent=action.intent,
        risk=action.risk, sequence=sequence, started_wall_ts=started,
    )

    before = observe(page, epoch)
    locator = None

    if action.kind not in TARGETLESS:
        if action.target is None:
            receipt.verdict = Verdict.REFUSED
            receipt.failure = FailureKind.TARGET_NOT_FOUND
            receipt.reason = f"{action.kind.value} needs a target"
            return _finish(receipt, before, before, network, console, started)

        resolution, locator = resolve(page, action.target,
                                      int(action.timeout_seconds * 1000))
        receipt.resolution = resolution

        if not resolution.found:
            receipt.verdict = Verdict.FAILED
            receipt.failure = (FailureKind.TARGET_AMBIGUOUS
                               if resolution.ambiguous
                               else FailureKind.TARGET_NOT_FOUND)
            receipt.reason = resolution.reason
            return _finish(receipt, before, before, network, console, started)

        # A weak match is not allowed to press something irreversible. This is
        # the one place the runtime refuses on confidence alone, and it refuses
        # rather than asking anybody.
        if (action.risk is SideEffect.DESTRUCTIVE
                and resolution.confidence < DESTRUCTIVE_CONFIDENCE_FLOOR):
            receipt.verdict = Verdict.REFUSED
            receipt.failure = FailureKind.POLICY_REFUSED
            receipt.reason = (
                f"a destructive action resolved at confidence "
                f"{resolution.confidence:.2f} via {resolution.strategy.value if resolution.strategy else '?'}, "
                f"below the {DESTRUCTIVE_CONFIDENCE_FLOOR} floor")
            return _finish(receipt, before, before, network, console, started)
    else:
        receipt.resolution = Resolution(
            found=True, confidence=1.0,
            describe=action.url or action.keys or action.kind.value)

    mark = time.time()
    try:
        _dispatch(page, action, locator)
    except Exception as exc:  # noqa: BLE001 - classified, never propagated
        kind, reason = _classify(exc)
        receipt.verdict = Verdict.FAILED
        receipt.failure = kind
        receipt.reason = reason
        after = observe(page, epoch)
        return _finish(receipt, before, after, network, console, started, mark)

    _settle(page, action.expect)
    after = observe(page, epoch)

    receipt_effects = _effects(before, after, network, console, mark)
    if action.expect.is_empty():
        receipt.verdict = Verdict.UNVERIFIED
        receipt.reason = ("no expectation was stated, so the effect was not "
                          "checked")
    else:
        ok, why = verify(page, action.expect, receipt_effects, after)
        receipt.verdict = Verdict.SUCCEEDED if ok else Verdict.FAILED
        if not ok:
            receipt.failure = FailureKind.VERIFICATION_FAILED
            receipt.reason = why

    receipt.effects = receipt_effects
    receipt.finished_wall_ts = time.time()
    receipt.duration_ms = (receipt.finished_wall_ts - started) * 1000
    return receipt


def _effects(before: BrowserObservation, after: BrowserObservation,
             network: NetworkLog, console: ConsoleLog,
             mark: float) -> Effects:
    return Effects(
        navigated=before.url != after.url,
        url_before=before.url, url_after=after.url,
        title_before=before.title, title_after=after.title,
        dom_changed=(before.text != after.text
                     or len(before.elements) != len(after.elements)),
        text_delta_chars=len(after.text) - len(before.text),
        console_errors=console.since(mark),
        network=network.since(mark),
        new_tabs=max(0, after.tab_count - before.tab_count),
    )


def _finish(receipt: ActionReceipt, before: BrowserObservation,
            after: BrowserObservation, network: NetworkLog,
            console: ConsoleLog, started: float,
            mark: float | None = None) -> ActionReceipt:
    receipt.effects = _effects(before, after, network, console,
                               mark if mark is not None else started)
    receipt.finished_wall_ts = time.time()
    receipt.duration_ms = (receipt.finished_wall_ts - started) * 1000
    return receipt


__all__ = ["ConsoleLog", "NetworkLog", "TARGETLESS", "perform", "verify"]
