"""The vocabulary of operating a browser: intents, targets, receipts, verdicts.

Every type here exists to keep one distinction sharp, and it is the
distinction the whole subsystem is for:

    dispatching an action is not the same as proving its effect.

A click that Playwright reports as successful has proved that a click was
dispatched. It has not proved that anything happened. So an action carries an
*expectation*, execution produces an *effect*, and a verdict is the comparison
of the two — never the return value of the click.

The second distinction is about who decides what. Target resolution, retries,
timeouts, idempotency and evidence are deterministic runtime concerns and are
typed here. A model may choose *which* action to take and may read the
resulting evidence; it never gets to declare that the action worked.
"""
from __future__ import annotations

import time
import uuid
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field

OPERATE_SCHEMA_VERSION = 1


class ActionKind(str, Enum):  # noqa: UP042 - matches the codebase's enums
    """What a step does. Deliberately closed.

    A string-typed `browser(command=...)` surface would put the model in
    charge of the runtime; a closed set means every action has a schema, a
    policy class, and something specific to verify afterwards.
    """

    NAVIGATE = "navigate"
    CLICK = "click"
    DOUBLE_CLICK = "double_click"
    FILL = "fill"
    TYPE = "type"
    CLEAR = "clear"
    SELECT = "select"
    CHECK = "check"
    UNCHECK = "uncheck"
    HOVER = "hover"
    PRESS = "press"
    SCROLL = "scroll"
    WAIT_FOR = "wait_for"
    SWITCH_TAB = "switch_tab"
    CLOSE_TAB = "close_tab"
    HANDLE_DIALOG = "handle_dialog"
    UPLOAD = "upload"


class SideEffect(str, Enum):  # noqa: UP042 - matches the codebase's enums
    """How dangerous a repeat of this action is.

    The recovery engine consults this before retrying anything. "It failed, so
    try again" is correct for a search box and catastrophic for a payment
    button, and the runtime must not need a model's opinion to tell them
    apart.
    """

    READ_ONLY = "read_only"
    """Observation only. Repeating changes nothing."""

    REVERSIBLE = "reversible"
    """Local or navigational. Repeating is safe."""

    SIDE_EFFECTING = "side_effecting"
    """May change server state. Repeat only with proof it did not take."""

    DESTRUCTIVE = "destructive"
    """Irreversible. Never repeated by the runtime."""


# The default risk of each action kind. `click` is the interesting one: a
# click can be either, so it is SIDE_EFFECTING unless the caller narrows it.
# Guessing low here would be the single most expensive wrong default in the
# subsystem.
DEFAULT_SIDE_EFFECT: dict[ActionKind, SideEffect] = {
    ActionKind.NAVIGATE: SideEffect.REVERSIBLE,
    ActionKind.CLICK: SideEffect.SIDE_EFFECTING,
    ActionKind.DOUBLE_CLICK: SideEffect.SIDE_EFFECTING,
    ActionKind.FILL: SideEffect.REVERSIBLE,
    ActionKind.TYPE: SideEffect.REVERSIBLE,
    ActionKind.CLEAR: SideEffect.REVERSIBLE,
    ActionKind.SELECT: SideEffect.REVERSIBLE,
    ActionKind.CHECK: SideEffect.REVERSIBLE,
    ActionKind.UNCHECK: SideEffect.REVERSIBLE,
    ActionKind.HOVER: SideEffect.READ_ONLY,
    ActionKind.PRESS: SideEffect.SIDE_EFFECTING,
    ActionKind.SCROLL: SideEffect.READ_ONLY,
    ActionKind.WAIT_FOR: SideEffect.READ_ONLY,
    ActionKind.SWITCH_TAB: SideEffect.READ_ONLY,
    ActionKind.CLOSE_TAB: SideEffect.REVERSIBLE,
    ActionKind.HANDLE_DIALOG: SideEffect.REVERSIBLE,
    ActionKind.UPLOAD: SideEffect.SIDE_EFFECTING,
}


class ResolutionStrategy(str, Enum):  # noqa: UP042 - matches the codebase's enums
    """How a target was found, in the order the resolver tries them.

    The order is the point. Accessibility role and name survive a restyle, a
    re-render and a class-name change; a bounding box survives none of them.
    Vision is last not because it is bad but because it is the most expensive
    and the least stable, and reaching for it first is how a browser agent
    becomes both slow and brittle.
    """

    ELEMENT_REF = "element_ref"
    ROLE_AND_NAME = "role_and_name"
    LABEL = "label"
    PLACEHOLDER = "placeholder"
    TEST_ID = "test_id"
    SELECTOR = "selector"
    TEXT = "text"
    VISUAL = "visual"
    COORDINATES = "coordinates"


class FailureKind(str, Enum):  # noqa: UP042 - matches the codebase's enums
    """Why a step did not produce its expected effect.

    Classified rather than described, because recovery is a lookup on this
    value. A free-text reason would leave the runtime asking a model what to
    do about a stale element, which is a deterministic problem with a
    deterministic answer.
    """

    TARGET_NOT_FOUND = "target_not_found"
    TARGET_AMBIGUOUS = "target_ambiguous"
    STALE_TARGET = "stale_target"
    TARGET_OBSCURED = "target_obscured"
    TARGET_DISABLED = "target_disabled"
    NAVIGATION_TIMEOUT = "navigation_timeout"
    NAVIGATION_BLOCKED = "navigation_blocked"
    DIALOG_BLOCKING = "dialog_blocking"
    NEW_TAB_CREATED = "new_tab_created"
    FORM_VALIDATION_FAILED = "form_validation_failed"
    NETWORK_FAILURE = "network_failure"
    WRONG_PAGE_STATE = "wrong_page_state"
    VERIFICATION_FAILED = "verification_failed"
    RESOURCE_REFUSED = "resource_refused"
    POLICY_REFUSED = "policy_refused"
    ACTION_ERROR = "action_error"


class Verdict(str, Enum):  # noqa: UP042 - matches the codebase's enums
    """What the runtime is willing to say about a step."""

    SUCCEEDED = "succeeded"
    """The expected effect was observed."""

    FAILED = "failed"
    """The action ran and the expected effect was not observed."""

    UNVERIFIED = "unverified"
    """The action ran and nothing was asked of it. Not a success."""

    REFUSED = "refused"
    """The runtime declined before touching the page."""


class Target(BaseModel):
    """What to act on, described the way a person would describe it.

    Several fields may be set at once; the resolver tries them in
    `ResolutionStrategy` order and records which one won. That record is what
    makes a receipt reviewable: "found by accessible name" and "found at
    (412, 380)" are very different claims about the same click.
    """

    description: str = ""
    """Human-readable, for the receipt and for a person reading it later."""

    role: str = ""
    name: str = ""
    label: str = ""
    placeholder: str = ""
    test_id: str = ""
    selector: str = ""
    text: str = ""
    element_ref: str = ""
    coordinates: tuple[float, float] | None = None
    frame: str = ""
    """Frame URL or name when the target is inside an iframe."""

    nth: int | None = None
    """Which match to take when several are expected.

    `None` means "I expect one", and several matches are then refused rather
    than silently resolved to the first. An explicit index — including `0` —
    means "yes, several, I mean this one". Defaulting this to `0` made those
    two states indistinguishable, so deliberately choosing the first match was
    impossible to express."""


class Resolution(BaseModel):
    """The outcome of looking for a target."""

    schema_version: int = OPERATE_SCHEMA_VERSION
    found: bool = False
    strategy: ResolutionStrategy | None = None
    confidence: float = 0.0
    match_count: int = 0
    selector_used: str = ""
    describe: str = ""
    alternatives: list[str] = Field(default_factory=list)
    reason: str = ""

    @property
    def ambiguous(self) -> bool:
        return self.match_count > 1


class Expectation(BaseModel):
    """What should be true afterwards, written down before acting.

    Optional, and when it is absent the verdict is `UNVERIFIED` rather than
    `SUCCEEDED` — an action nobody stated an expectation for has not been
    proved to do anything, and calling that success is the exact failure mode
    this subsystem exists to prevent.
    """

    url_changes: bool | None = None
    url_contains: str = ""
    title_contains: str = ""
    text_present: str = ""
    text_absent: str = ""
    selector_present: str = ""
    selector_absent: str = ""
    element_enabled: str = ""
    element_checked: str = ""
    input_value: tuple[str, str] | None = None
    """(selector, expected value) — proves a fill actually landed."""

    no_console_errors: bool = False
    network_ok: bool = False
    """Every request correlated with this action returned < 400. This is what
    catches a page that renders "Saved" over a failed PATCH."""

    max_wait_seconds: float = 5.0

    def is_empty(self) -> bool:
        """Whether anything at all was asked of this action.

        `url_changes` is checked against None rather than for truthiness:
        `url_changes=False` is a real expectation — "this must not navigate" —
        and treating it as unset marked genuinely verified actions as
        UNVERIFIED.
        """
        return not any((
            self.url_changes is not None,
            self.url_contains, self.title_contains,
            self.text_present, self.text_absent, self.selector_present,
            self.selector_absent, self.element_enabled, self.element_checked,
            self.input_value is not None,
            self.no_console_errors, self.network_ok,
        ))


class Action(BaseModel):
    """One step: what to do, to what, and what should follow."""

    schema_version: int = OPERATE_SCHEMA_VERSION
    action_id: str = Field(
        default_factory=lambda: f"act_{uuid.uuid4().hex[:12]}")
    kind: ActionKind
    intent: str = ""
    """Why, in words. Carried into the receipt so a reviewer reading it a week
    later knows what was being attempted, not just what was pressed."""

    target: Target | None = None
    value: str = ""
    keys: str = ""
    delta_y: int = 0
    url: str = ""
    tab_index: int | None = None
    accept_dialog: bool = True
    files: list[str] = Field(default_factory=list)
    expect: Expectation = Field(default_factory=Expectation)
    side_effect: SideEffect | None = None
    timeout_seconds: float = 15.0

    @property
    def risk(self) -> SideEffect:
        return self.side_effect or DEFAULT_SIDE_EFFECT.get(
            self.kind, SideEffect.SIDE_EFFECTING)

    @property
    def retry_safe(self) -> bool:
        """Whether the runtime may repeat this on its own.

        Deliberately conservative: only actions that cannot change server
        state qualify. Anything else needs proof the first attempt did not
        take, which the caller must supply as an expectation.
        """
        return self.risk in (SideEffect.READ_ONLY, SideEffect.REVERSIBLE)


class NetworkRecord(BaseModel):
    """One request observed while a step ran.

    Query strings are dropped and headers are never captured: a URL is
    evidence, and a URL with a session token in it is a leak.
    """

    method: str = ""
    url: str = ""
    status: int = 0
    ok: bool = True
    failed: bool = False


class Effects(BaseModel):
    """What actually changed, measured either side of the action."""

    schema_version: int = OPERATE_SCHEMA_VERSION
    navigated: bool = False
    url_before: str = ""
    url_after: str = ""
    title_before: str = ""
    title_after: str = ""
    dom_changed: bool = False
    text_delta_chars: int = 0
    console_errors: list[str] = Field(default_factory=list)
    network: list[NetworkRecord] = Field(default_factory=list)
    new_tabs: int = 0
    dialogs: int = 0
    downloads: list[str] = Field(default_factory=list)

    @property
    def failed_requests(self) -> list[NetworkRecord]:
        return [r for r in self.network if r.failed or (r.status >= 400)]


class ActionReceipt(BaseModel):
    """The record of one step, and the only thing entitled to claim success.

    Persisted whether the step worked or not. A receipt for a failure is more
    valuable than one for a success — it is the artefact that answers "what
    did the agent try, what happened, and why did Watch reject it".
    """

    schema_version: int = OPERATE_SCHEMA_VERSION
    action_id: str
    run_id: str = ""
    session_id: str = ""
    sequence: int = 0
    kind: ActionKind
    intent: str = ""
    risk: SideEffect = SideEffect.SIDE_EFFECTING
    resolution: Resolution | None = None
    effects: Effects = Field(default_factory=Effects)
    verdict: Verdict = Verdict.UNVERIFIED
    failure: FailureKind | None = None
    reason: str = ""
    attempt: int = 1
    recovered_from: FailureKind | None = None
    started_wall_ts: float = Field(default_factory=time.time)
    finished_wall_ts: float = 0.0
    duration_ms: float = 0.0
    evidence: list[str] = Field(default_factory=list)
    screenshot: str = ""

    @property
    def succeeded(self) -> bool:
        return self.verdict is Verdict.SUCCEEDED

    def to_public(self) -> dict[str, Any]:
        """The shape a surface or a model may see.

        Contains no filesystem paths and no raw page HTML: evidence is
        referenced by id and stays in the store.
        """
        return {
            "schema_version": self.schema_version,
            "action_id": self.action_id,
            "sequence": self.sequence,
            "action": self.kind.value,
            "intent": self.intent,
            "risk": self.risk.value,
            "target": (self.resolution.describe if self.resolution else ""),
            "resolution": {
                "strategy": (self.resolution.strategy.value
                             if self.resolution and self.resolution.strategy
                             else ""),
                "confidence": round(self.resolution.confidence, 3)
                if self.resolution else 0.0,
                "matches": self.resolution.match_count if self.resolution else 0,
            },
            "effects": {
                "navigated": self.effects.navigated,
                "url_change": (f"{self.effects.url_before} -> "
                               f"{self.effects.url_after}")
                if self.effects.navigated else "",
                "dom_changed": self.effects.dom_changed,
                "console_errors": self.effects.console_errors[:5],
                "network": [
                    f"{r.method} {r.url} -> {r.status or 'failed'}"
                    for r in self.effects.network[:10]
                ],
                "new_tabs": self.effects.new_tabs,
                "dialogs": self.effects.dialogs,
            },
            "verdict": self.verdict.value,
            "failure": self.failure.value if self.failure else "",
            "reason": self.reason,
            "attempt": self.attempt,
            "recovered_from": (self.recovered_from.value
                               if self.recovered_from else ""),
            "duration_ms": round(self.duration_ms, 1),
            "evidence": self.evidence,
        }


class TaskStatus(str, Enum):  # noqa: UP042 - matches the codebase's enums
    COMPLETED = "completed"
    FAILED = "failed"
    REFUSED = "refused"


class TaskResult(BaseModel):
    """What a browser task returns. Structured, never a sentence.

    `verified` is separate from `status` on purpose. A task that ran every
    step without error but proved nothing is `COMPLETED` and **not**
    `verified`, and the difference is the product.
    """

    schema_version: int = OPERATE_SCHEMA_VERSION
    run_id: str
    session_id: str = ""
    goal: str = ""
    status: TaskStatus = TaskStatus.FAILED
    verified: bool = False
    receipts: list[ActionReceipt] = Field(default_factory=list)
    failure_reason: str = ""
    final_url: str = ""
    final_title: str = ""
    started_wall_ts: float = Field(default_factory=time.time)
    finished_wall_ts: float = 0.0

    @property
    def actions(self) -> int:
        """Attempts made, retries included."""
        return len(self.receipts)

    @property
    def steps(self) -> int:
        """Distinct actions attempted. Retries reuse an action's id, so this
        counts the plan's steps rather than the work done on them."""
        return len({receipt.action_id for receipt in self.receipts})

    @property
    def recovery_count(self) -> int:
        return sum(1 for r in self.receipts if r.recovered_from is not None)

    @property
    def first_attempt_success(self) -> bool:
        """Every step worked without a retry. The metric that separates a
        runtime that is reliable from one that merely recovers well."""
        return bool(self.receipts) and all(
            r.attempt == 1 and r.succeeded for r in self.receipts)

    def to_public(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "run_id": self.run_id,
            "session_id": self.session_id,
            "goal": self.goal,
            "status": self.status.value,
            "verified": self.verified,
            "actions": self.actions,
            "steps": self.steps,
            "recovery_count": self.recovery_count,
            "first_attempt_success": self.first_attempt_success,
            "failure_reason": self.failure_reason,
            "final_state": {"url": self.final_url, "title": self.final_title},
            "receipts": [r.to_public() for r in self.receipts],
            "metrics": {
                "duration_ms": round(
                    (self.finished_wall_ts - self.started_wall_ts) * 1000, 1),
                "actions": self.actions,
                "recoveries": self.recovery_count,
            },
        }


__all__ = [
    "DEFAULT_SIDE_EFFECT",
    "OPERATE_SCHEMA_VERSION",
    "Action",
    "ActionKind",
    "ActionReceipt",
    "Effects",
    "Expectation",
    "FailureKind",
    "NetworkRecord",
    "Resolution",
    "ResolutionStrategy",
    "SideEffect",
    "Target",
    "TaskResult",
    "TaskStatus",
    "Verdict",
]
