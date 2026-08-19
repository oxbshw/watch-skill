"""Operator mode: Watch Skill drives a browser and proves what it did.

Watch Skill has one browser subsystem with two modes. In *observer* mode it
watches someone else work and verifies the result; in *operator* mode it does
the work itself and verifies its own. Both share the same page, the same
navigation policy, the same resource lease and the same evidence — the only
difference is who acted.

The invariant that runs through every type here: dispatching an action is not
the same as proving its effect. A click that Playwright reports as successful
has proved that a click was delivered, and nothing more.

    from watch_skill.operate import Action, ActionKind, BrowserRuntime, Target

    runtime = BrowserRuntime(source)
    result = runtime.run_task("sign in", [
        Action(kind=ActionKind.FILL, intent="enter the username",
               target=Target(label="Username"), value="ada",
               expect=Expectation(input_value=("#username", "ada"))),
    ])
    result.verified   # False unless every step proved its effect
"""
from watch_skill.operate.observe import (
    BrowserObservation,
    ElementView,
    PageView,
    delta,
    observe,
)
from watch_skill.operate.recover import MAX_ATTEMPTS, Recovery
from watch_skill.operate.resolve import resolve
from watch_skill.operate.runtime import BrowserRuntime, OperateError
from watch_skill.operate.types import (
    Action,
    ActionKind,
    ActionReceipt,
    Effects,
    Expectation,
    FailureKind,
    NetworkRecord,
    Resolution,
    ResolutionStrategy,
    SideEffect,
    Target,
    TaskResult,
    TaskStatus,
    Verdict,
)

__all__ = [
    "MAX_ATTEMPTS",
    "Action",
    "ActionKind",
    "ActionReceipt",
    "BrowserObservation",
    "BrowserRuntime",
    "Effects",
    "ElementView",
    "Expectation",
    "FailureKind",
    "NetworkRecord",
    "OperateError",
    "PageView",
    "Recovery",
    "Resolution",
    "ResolutionStrategy",
    "SideEffect",
    "Target",
    "TaskResult",
    "TaskStatus",
    "Verdict",
    "delta",
    "observe",
    "resolve",
]
