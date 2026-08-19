"""What to do about a failure, decided by its class rather than by a model.

A stale element wants a re-observe and a re-resolve. A modal in the way wants
dismissing. A target that was never there wants a human, or a different plan.
These are deterministic problems with deterministic answers, and handing them
to a language model would be slower, less reliable, and impossible to test.

The engine only ever proposes *how* to retry. Whether a retry is permissible
at all is decided before we get here, by the action's side-effect class:
clicking "Next" again is fine, clicking "Buy now" again is not, and no amount
of clever recovery is allowed to blur that line.
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from watch_skill.operate.types import ActionReceipt, FailureKind, SideEffect

MAX_ATTEMPTS = 3
"""Attempts per action, including the first.

Bounded because an unbounded retry against a genuinely missing element is an
outage that looks like patience."""


class Recovery:
    """One recovery move: what it does and what it is called in evidence."""

    def __init__(self, name: str, apply: Callable[[Any], str]) -> None:
        self.name = name
        self.apply = apply


def _dismiss_dialog(page: Any) -> str:
    """A JS dialog blocks every other interaction until it is answered."""
    try:
        page.keyboard.press("Escape")
        return "pressed Escape to dismiss a blocking dialog"
    except Exception as exc:  # noqa: BLE001
        return f"could not dismiss the dialog: {type(exc).__name__}"


def _dismiss_overlay(page: Any) -> str:
    """Try the ordinary ways a modal closes, in the order a person would.

    Escape first because it is the least destructive; a close control second.
    Deliberately does not click anything that merely *looks* dismissive — a
    button reading "No thanks" on a page we do not understand is still a
    click on an unknown control.
    """
    try:
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
    except Exception:  # noqa: BLE001
        pass
    for selector in ('[aria-label="Close"]', '[aria-label="close"]',
                     'button[data-dismiss]', '.modal button.close'):
        try:
            locator = page.locator(selector)
            if locator.count() == 1 and locator.first.is_visible(timeout=500):
                locator.first.click(timeout=2000)
                return f"closed an overlay via {selector}"
        except Exception:  # noqa: BLE001
            continue
    return "pressed Escape to clear an overlay"


def _scroll_into_view(page: Any) -> str:
    try:
        page.mouse.wheel(0, 300)
        return "scrolled to bring the target into view"
    except Exception:  # noqa: BLE001
        return "could not scroll"


def _settle(page: Any) -> str:
    """Wait for the page to stop moving, bounded.

    The honest recovery for "it was not there yet": most `target_not_found`
    failures on a modern page are a race with a render, not a missing element.
    """
    try:
        page.wait_for_load_state("domcontentloaded", timeout=5000)
        page.wait_for_timeout(500)
        return "waited for the page to settle and re-observed"
    except Exception:  # noqa: BLE001
        return "waited for the page to settle"


def _focus_newest_tab(page: Any) -> str:
    """A click that opened a tab usually meant the work to continue there."""
    try:
        pages = list(page.context.pages)
        if len(pages) > 1:
            pages[-1].bring_to_front()
            return f"switched to the tab the action opened ({len(pages)} open)"
    except Exception:  # noqa: BLE001
        pass
    return "no additional tab to switch to"


# Which move answers which failure. A failure absent from this table has no
# deterministic answer and is reported rather than guessed at — that is the
# point at which a planner or a person should decide, not the runtime.
POLICIES: dict[FailureKind, Recovery] = {
    FailureKind.STALE_TARGET: Recovery("re-observe", _settle),
    FailureKind.TARGET_NOT_FOUND: Recovery("settle-and-retry", _settle),
    FailureKind.TARGET_OBSCURED: Recovery("dismiss-overlay", _dismiss_overlay),
    FailureKind.TARGET_DISABLED: Recovery("settle-and-retry", _settle),
    FailureKind.DIALOG_BLOCKING: Recovery("dismiss-dialog", _dismiss_dialog),
    FailureKind.NEW_TAB_CREATED: Recovery("switch-tab", _focus_newest_tab),
    FailureKind.NAVIGATION_TIMEOUT: Recovery("settle-and-retry", _settle),
    FailureKind.WRONG_PAGE_STATE: Recovery("settle-and-retry", _settle),
    FailureKind.VERIFICATION_FAILED: Recovery("settle-and-recheck", _settle),
}

# Failures where retrying is pointless or unsafe regardless of the action's
# risk class. Re-running a request that the server rejected on its merits, or
# re-attempting something policy refused, only wastes the budget.
NEVER_RETRY = {
    FailureKind.POLICY_REFUSED,
    FailureKind.NAVIGATION_BLOCKED,
    FailureKind.RESOURCE_REFUSED,
    FailureKind.FORM_VALIDATION_FAILED,
    FailureKind.TARGET_AMBIGUOUS,
}


def plan(receipt: ActionReceipt, attempt: int,
         retry_safe: bool) -> Recovery | None:
    """The move to try next, or None to stop and report.

    `retry_safe` is the caller's judgement about side effects and it wins over
    everything here. A `VERIFICATION_FAILED` on a payment is not retried, no
    matter how ordinary the recovery for that failure class looks — the effect
    may well have landed, and the failure may be in our reading of it.
    """
    if receipt.failure is None or receipt.succeeded:
        return None
    if attempt >= MAX_ATTEMPTS:
        return None
    if receipt.failure in NEVER_RETRY:
        return None
    if not retry_safe:
        return None
    return POLICIES.get(receipt.failure)


def describe_refusal(receipt: ActionReceipt, retry_safe: bool,
                     attempt: int) -> str:
    """Why no recovery was attempted. Goes into evidence.

    A run that simply stops is unreadable later; a run that says "not retried
    because the action may have side effects" can be acted on.
    """
    if receipt.failure is None:
        return ""
    if receipt.failure in NEVER_RETRY:
        return f"{receipt.failure.value} is not retryable"
    if not retry_safe:
        return ("not retried: the action may have taken effect and repeating "
                "it could duplicate a side effect")
    if attempt >= MAX_ATTEMPTS:
        return f"gave up after {MAX_ATTEMPTS} attempts"
    return f"no deterministic recovery is defined for {receipt.failure.value}"


def is_retryable(risk: SideEffect) -> bool:
    return risk in (SideEffect.READ_ONLY, SideEffect.REVERSIBLE)


__all__ = [
    "MAX_ATTEMPTS",
    "NEVER_RETRY",
    "POLICIES",
    "Recovery",
    "describe_refusal",
    "is_retryable",
    "plan",
]
