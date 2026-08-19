"""Finding the thing to act on, cheapest and most durable first.

The ladder is the whole design. Accessibility role and name survive a
restyle, a re-render, a class-name change and a framework upgrade; a CSS
selector survives some of those; a bounding box survives none. Vision sits at
the bottom not because it is inaccurate but because it is the most expensive
signal available and the least stable across a redeploy — reaching for it
first is how a browser agent becomes slow *and* brittle at the same time.

Two rules that are easy to get wrong and expensive to get wrong:

**Ambiguity is refused, not resolved.** Three buttons named "Delete" is not a
situation where the first one is probably right. The resolver reports the
count and the alternatives and lets the caller disambiguate with `nth` or a
narrower target.

**Confidence describes the strategy, not the model's feelings.** A match on an
accessible name is 0.95 because that is how durable accessible names are, and
the number is fixed per strategy so it means the same thing every time.
"""
from __future__ import annotations

from typing import Any

from watch_skill.operate.types import Resolution, ResolutionStrategy, Target

# How much each strategy is worth. Fixed per strategy so the number is
# comparable across runs and across pages: it is a statement about how stable
# the *method* is, not a guess about a particular element.
STRATEGY_CONFIDENCE: dict[ResolutionStrategy, float] = {
    ResolutionStrategy.ELEMENT_REF: 0.99,
    ResolutionStrategy.ROLE_AND_NAME: 0.95,
    ResolutionStrategy.LABEL: 0.93,
    ResolutionStrategy.TEST_ID: 0.92,
    ResolutionStrategy.PLACEHOLDER: 0.85,
    ResolutionStrategy.SELECTOR: 0.80,
    ResolutionStrategy.TEXT: 0.70,
    ResolutionStrategy.VISUAL: 0.55,
    ResolutionStrategy.COORDINATES: 0.40,
}

DESTRUCTIVE_CONFIDENCE_FLOOR = 0.75
"""Below this, an irreversible action is refused rather than guessed at.

A coordinate match is 0.40. That is fine for scrolling and unacceptable for
pressing something labelled "Delete account"."""


def _root(page: Any, target: Target) -> Any:
    """The page, or the frame the target says it lives in."""
    if not target.frame:
        return page
    for frame in page.frames:
        if target.frame in (frame.name or "") or target.frame in (frame.url or ""):
            return frame
    return page


def _candidates(root: Any, target: Target) -> list[tuple[ResolutionStrategy, Any]]:
    """Every way we could look for this target, best first.

    Built as a list rather than tried inline so the order is visible in one
    place and so a failed lookup can report what else was attempted.
    """
    out: list[tuple[ResolutionStrategy, Any]] = []

    if target.role and target.name:
        out.append((ResolutionStrategy.ROLE_AND_NAME,
                    root.get_by_role(target.role, name=target.name)))
    if target.label:
        out.append((ResolutionStrategy.LABEL, root.get_by_label(target.label)))
    if target.test_id:
        out.append((ResolutionStrategy.TEST_ID,
                    root.get_by_test_id(target.test_id)))
    if target.placeholder:
        out.append((ResolutionStrategy.PLACEHOLDER,
                    root.get_by_placeholder(target.placeholder)))
    if target.selector:
        out.append((ResolutionStrategy.SELECTOR, root.locator(target.selector)))
    if target.text:
        out.append((ResolutionStrategy.TEXT, root.get_by_text(target.text)))
    # Role alone is weak but better than nothing when a name was not given.
    if target.role and not target.name:
        out.append((ResolutionStrategy.ROLE_AND_NAME,
                    root.get_by_role(target.role)))
    return out


def resolve(page: Any, target: Target,
            timeout_ms: int = 5000) -> tuple[Resolution, Any | None]:
    """Find `target` on `page`. Runs on the browser thread.

    Returns the resolution *and* the locator, because the caller needs both:
    the locator to act on and the resolution to put in the receipt. A receipt
    that says only "clicked" is not evidence; one that says "clicked the
    element found by accessible name, 1 match, confidence 0.95" is.
    """
    root = _root(page, target)
    attempted: list[str] = []

    for strategy, locator in _candidates(root, target):
        try:
            count = locator.count()
        except Exception as exc:  # noqa: BLE001 - a bad selector is a miss
            attempted.append(f"{strategy.value}: {type(exc).__name__}")
            continue

        if count == 0:
            attempted.append(f"{strategy.value}: no match")
            continue

        if count > 1 and target.nth is None:
            # Refused rather than guessed. Reported with the count so the
            # caller can disambiguate deliberately.
            samples: list[str] = []
            for index in range(min(count, 4)):
                try:
                    samples.append(
                        (locator.nth(index).inner_text(timeout=500) or "")
                        .strip()[:60])
                except Exception:  # noqa: BLE001
                    samples.append(f"match {index}")
            return Resolution(
                found=False,
                strategy=strategy,
                match_count=count,
                describe=target.description or strategy.value,
                alternatives=samples,
                reason=(f"{count} elements match; pass nth= or narrow the "
                        f"target rather than acting on a guess"),
            ), None

        chosen = (locator.nth(target.nth) if target.nth is not None
                  else locator.first)
        try:
            chosen.wait_for(state="attached", timeout=timeout_ms)
        except Exception as exc:  # noqa: BLE001
            attempted.append(f"{strategy.value}: never attached")
            del exc
            continue

        return Resolution(
            found=True,
            strategy=strategy,
            confidence=STRATEGY_CONFIDENCE[strategy],
            match_count=count,
            selector_used=str(target.selector or target.name or target.label
                              or target.text or target.test_id),
            describe=target.description or _describe(target, strategy),
        ), chosen

    return Resolution(
        found=False,
        describe=target.description or "unnamed target",
        alternatives=attempted,
        reason="no strategy matched",
    ), None


def _describe(target: Target, strategy: ResolutionStrategy) -> str:
    if strategy is ResolutionStrategy.ROLE_AND_NAME:
        return f"{target.role} named {target.name!r}"
    if strategy is ResolutionStrategy.LABEL:
        return f"field labelled {target.label!r}"
    if strategy is ResolutionStrategy.TEST_ID:
        return f"test id {target.test_id!r}"
    if strategy is ResolutionStrategy.PLACEHOLDER:
        return f"input placeholder {target.placeholder!r}"
    if strategy is ResolutionStrategy.TEXT:
        return f"text {target.text!r}"
    return target.selector or "target"


__all__ = ["DESTRUCTIVE_CONFIDENCE_FLOOR", "STRATEGY_CONFIDENCE", "resolve"]
