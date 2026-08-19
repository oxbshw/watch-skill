"""The browser runtime, against a real Chromium and a site that fights back.

Nothing here is mocked. A real browser drives a real local site, and each test
covers a way that browsers actually break agents — a control that has not
rendered yet, a node replaced under the handle, a modal intercepting the
click, work continuing in a tab nobody is looking at, and a page that reports
success over a failed request.

The last of those is the one this subsystem exists for.
"""
from __future__ import annotations

import pytest
from tests.conftest import require_verification_browser

from watch_skill.live.browser import BrowserOptions, BrowserSource
from watch_skill.live.browser_policy import NavigationPolicy
from watch_skill.live.capabilities import capability_for
from watch_skill.operate import (
    Action,
    ActionKind,
    BrowserRuntime,
    Expectation,
    FailureKind,
    SideEffect,
    Target,
    TaskStatus,
    Verdict,
)
from watch_skill.operate.fixture_site import FixtureSite

pytestmark = pytest.mark.timeout(600)


@pytest.fixture
def site():
    with FixtureSite() as running:
        yield running


@pytest.fixture
def runtime(site, tmp_path):
    """A real browser pointed at the fixture site.

    One governed browser, so the resource precondition is the single-browser
    one: the governor refuses when the machine cannot afford it, and that is
    the product working rather than a test defect.
    """
    if capability_for("browser").status != "available":
        pytest.skip("browser capture is unavailable")
    require_verification_browser(1)

    options = BrowserOptions(
        url=f"{site.base_url}/",
        fps=2.0,
        policy=NavigationPolicy(allow_loopback=True,
                                allowed_hosts=frozenset({"127.0.0.1"})),
        # Operator mode: a target=_blank link is often the task itself,
        # and an adopted popup is watched rather than unobserved.
        adopt_popups=True,
    )
    source = BrowserSource(options, tmp_path / "frames", session_id="op_test")
    source.start()
    engine = BrowserRuntime(source)
    try:
        yield engine
    finally:
        engine.close()
        source.stop()


def _goto(runtime: BrowserRuntime, url: str) -> None:
    receipt = runtime.act(Action(
        kind=ActionKind.NAVIGATE, url=url, intent=f"open {url}",
        expect=Expectation(url_contains=url.rsplit("/", 1)[-1])))
    assert receipt.succeeded, receipt.reason


# --- observation --------------------------------------------------------------


def test_observation_names_controls_the_way_the_resolver_finds_them(
    runtime, site,
) -> None:
    """Role and accessible name, not tag soup.

    If the snapshot described elements differently from how the resolver looks
    them up, a planner reading the snapshot could not address what it saw.
    """
    _goto(runtime, f"{site.base_url}/form")
    observation = runtime.observe()

    assert observation.url.endswith("/form")
    assert observation.title == "Sign up"
    names = {(element.role, element.name) for element in observation.elements}
    assert ("textbox", "Email") in names, names
    assert ("button", "Create account") in names, names
    # Bounded, and it says so rather than truncating in silence.
    assert len(observation.elements) <= 60


def test_the_summary_fences_page_authored_text_as_untrusted(runtime, site) -> None:
    _goto(runtime, f"{site.base_url}/injection")
    summary = runtime.observe().summarise()
    assert "untrusted" in summary.lower()


# --- resolution ---------------------------------------------------------------


def test_a_target_is_found_by_accessible_name_before_anything_weaker(
    runtime, site,
) -> None:
    _goto(runtime, f"{site.base_url}/form")
    receipt = runtime.act(Action(
        kind=ActionKind.FILL, intent="enter the email",
        target=Target(label="Email"), value="ada@example.com",
        expect=Expectation(input_value=("#email", "ada@example.com"))))

    assert receipt.succeeded, receipt.reason
    assert receipt.resolution is not None
    assert receipt.resolution.strategy.value == "label"
    assert receipt.resolution.confidence >= 0.9


def test_ambiguity_is_refused_rather_than_resolved_to_the_first_match(
    runtime, site,
) -> None:
    """Two buttons named "Delete account" is not a situation where the first
    one is probably right."""
    _goto(runtime, f"{site.base_url}/danger")
    receipt = runtime.act(Action(
        kind=ActionKind.CLICK, intent="delete the account",
        target=Target(role="button", name="Delete account")))

    assert receipt.verdict is Verdict.FAILED
    assert receipt.failure is FailureKind.TARGET_AMBIGUOUS
    assert receipt.resolution is not None
    assert receipt.resolution.match_count == 2
    assert "nth" in receipt.reason


def test_a_destructive_action_is_refused_on_a_weak_match(runtime, site) -> None:
    """Confidence gates irreversibility. A text match is 0.70; the floor for
    something that cannot be undone is 0.75."""
    _goto(runtime, f"{site.base_url}/danger")
    receipt = runtime.act(Action(
        kind=ActionKind.CLICK, intent="delete the account",
        target=Target(text="Delete account", nth=0),  # explicit index
        side_effect=SideEffect.DESTRUCTIVE))

    assert receipt.verdict is Verdict.REFUSED
    assert receipt.failure is FailureKind.POLICY_REFUSED
    assert "floor" in receipt.reason


# --- verification -------------------------------------------------------------


def test_an_action_with_no_expectation_is_unverified_not_successful(
    runtime, site,
) -> None:
    """The single most important default in the subsystem."""
    _goto(runtime, f"{site.base_url}/form")
    receipt = runtime.act(Action(
        kind=ActionKind.HOVER, intent="hover the submit button",
        target=Target(role="button", name="Create account")))

    assert receipt.verdict is Verdict.UNVERIFIED
    assert not receipt.succeeded
    assert "no expectation" in receipt.reason


def test_a_click_that_dispatches_but_changes_nothing_is_a_failure(
    runtime, site,
) -> None:
    """Playwright returning from click() proves a click was delivered."""
    _goto(runtime, f"{site.base_url}/form")
    receipt = runtime.act(Action(
        kind=ActionKind.CLICK, intent="submit the empty form",
        target=Target(role="button", name="Create account"),
        side_effect=SideEffect.REVERSIBLE,
        expect=Expectation(text_present="Account created")))

    assert receipt.verdict is Verdict.FAILED
    assert receipt.failure is FailureKind.VERIFICATION_FAILED
    # The server did receive it — the click worked, the outcome did not.
    assert site.state.form_submits >= 1


def test_the_page_says_saved_and_the_network_says_otherwise(
    runtime, site,
) -> None:
    """The scenario this whole subsystem is for.

    The UI paints "Saved" unconditionally; the PATCH behind it returns 500
    every time. An agent that trusts the screen reports success. One that
    correlates the network rejects it.
    """
    _goto(runtime, f"{site.base_url}/false-success")
    receipt = runtime.act(Action(
        kind=ActionKind.CLICK, intent="save the display name",
        target=Target(role="button", name="Save"),
        side_effect=SideEffect.REVERSIBLE,
        expect=Expectation(text_present="Saved", network_ok=True,
                           max_wait_seconds=4.0)))

    assert receipt.verdict is Verdict.FAILED, (
        "the runtime believed the page over the network")
    assert "500" in receipt.reason
    assert "/api/save" in receipt.reason
    # The failed request is in the receipt, not just in the message.
    assert any(r.status == 500 for r in receipt.effects.network)
    # And the page really did claim success, which is what makes it dangerous.
    assert site.state.save_attempts >= 1


# --- recovery -----------------------------------------------------------------


def test_a_control_that_has_not_rendered_yet_is_waited_for_not_failed(
    runtime, site,
) -> None:
    """`/delayed` withholds the button for 1.2s. One settle is enough."""
    _goto(runtime, f"{site.base_url}/delayed")
    receipt = runtime.act(Action(
        kind=ActionKind.CLICK, intent="continue",
        target=Target(role="button", name="Continue"),
        side_effect=SideEffect.REVERSIBLE,
        timeout_seconds=3.0,
        expect=Expectation(url_changes=False)))

    assert receipt.succeeded, receipt.reason


def test_a_modal_that_intercepts_the_click_is_dismissed_and_the_action_retried(
    runtime, site,
) -> None:
    """The recovery chain is recorded, so a second-attempt success does not
    read as though it simply worked."""
    _goto(runtime, f"{site.base_url}/overlay")
    receipt = runtime.act(Action(
        kind=ActionKind.CLICK, intent="open the article",
        target=Target(role="button", name="Read more"),
        side_effect=SideEffect.REVERSIBLE,
        timeout_seconds=4.0,
        expect=Expectation(text_present="Article opened",
                           max_wait_seconds=3.0)))

    assert receipt.succeeded, receipt.reason
    assert receipt.attempt >= 2, "the overlay should have forced a retry"
    assert receipt.recovered_from is not None
    assert any("recovery[" in note for note in receipt.evidence), receipt.evidence


def test_a_side_effecting_action_is_never_retried_by_the_runtime(
    runtime, site,
) -> None:
    """Clicking "Next" again is fine. Clicking "Buy" again is not, and the
    runtime must not need a model's opinion to tell them apart."""
    _goto(runtime, f"{site.base_url}/overlay")
    receipt = runtime.act(Action(
        kind=ActionKind.CLICK, intent="open the article",
        target=Target(role="button", name="Read more"),
        # The default for click. Left explicit because it is the point.
        side_effect=SideEffect.SIDE_EFFECTING,
        timeout_seconds=4.0,
        expect=Expectation(text_present="Article opened")))

    assert receipt.verdict is Verdict.FAILED
    assert receipt.attempt == 1, "a side-effecting action was retried"
    assert "duplicate a side effect" in receipt.reason


# --- tabs and frames ----------------------------------------------------------


def test_a_link_that_opens_a_tab_is_seen_in_the_page_graph(runtime, site) -> None:
    _goto(runtime, f"{site.base_url}/newtab")
    before = runtime.observe().tab_count

    receipt = runtime.act(Action(
        kind=ActionKind.CLICK, intent="open the report",
        target=Target(role="link", name="Open report"),
        side_effect=SideEffect.REVERSIBLE,
        expect=Expectation(url_changes=False, max_wait_seconds=3.0)))
    assert receipt.succeeded, receipt.reason

    after = runtime.observe()
    assert after.tab_count == before + 1, "the new tab is missing from the graph"
    assert any("/report" in page.url for page in after.pages)


def test_a_target_inside_an_iframe_is_addressable(runtime, site) -> None:
    _goto(runtime, f"{site.base_url}/iframe")
    observation = runtime.observe()
    assert observation.frames, "the iframe is missing from the observation"

    receipt = runtime.act(Action(
        kind=ActionKind.FILL, intent="set the nickname",
        target=Target(label="Nickname", frame="/inner"), value="ada",
        expect=Expectation(max_wait_seconds=2.0, url_changes=False)))
    assert receipt.succeeded, receipt.reason


# --- tasks --------------------------------------------------------------------


def test_a_completed_task_that_proved_nothing_is_not_verified(
    runtime, site,
) -> None:
    """`status` and `verified` are separate fields for this reason."""
    result = runtime.run_task("look at the form", [
        Action(kind=ActionKind.NAVIGATE, url=f"{site.base_url}/form",
               intent="open the form"),
    ])

    assert result.status is TaskStatus.COMPLETED
    assert result.verified is False


def test_a_multi_step_task_reports_receipts_and_a_verdict(runtime, site) -> None:
    """The full happy path: fill, choose, accept, submit — each step proving
    its own effect before the next one runs."""
    result = runtime.run_task("create an account", [
        Action(kind=ActionKind.NAVIGATE, url=f"{site.base_url}/form",
               intent="open the sign-up form",
               expect=Expectation(text_present="Sign up")),
        Action(kind=ActionKind.FILL, intent="enter the email",
               target=Target(label="Email"), value="ada@example.com",
               expect=Expectation(input_value=("#email", "ada@example.com"))),
        Action(kind=ActionKind.SELECT, intent="choose the pro plan",
               target=Target(label="Plan"), value="pro",
               expect=Expectation(input_value=("#plan", "pro"))),
        Action(kind=ActionKind.CHECK, intent="accept the terms",
               target=Target(role="checkbox"),
               expect=Expectation(element_checked="#terms")),
        Action(kind=ActionKind.CLICK, intent="submit the form",
               target=Target(role="button", name="Create account"),
               side_effect=SideEffect.REVERSIBLE,
               expect=Expectation(text_present="Account created",
                                  max_wait_seconds=5.0)),
    ])

    assert result.status is TaskStatus.COMPLETED, result.failure_reason
    assert result.verified is True
    assert result.actions == 5
    assert all(r.succeeded for r in result.receipts)

    public = result.to_public()
    assert public["verified"] is True
    assert len(public["receipts"]) == 5
    assert public["receipts"][-1]["verdict"] == "succeeded"


def test_a_task_stops_at_the_first_step_that_did_not_do_what_it_claimed(
    runtime, site,
) -> None:
    """Continuing past a failed step means every later step is operating on a
    page the plan did not anticipate."""
    result = runtime.run_task("save settings", [
        Action(kind=ActionKind.NAVIGATE, url=f"{site.base_url}/false-success",
               intent="open settings",
               expect=Expectation(text_present="Settings")),
        Action(kind=ActionKind.CLICK, intent="save",
               target=Target(role="button", name="Save"),
               side_effect=SideEffect.REVERSIBLE,
               expect=Expectation(network_ok=True, max_wait_seconds=4.0)),
        Action(kind=ActionKind.NAVIGATE, url=f"{site.base_url}/report",
               intent="this step must never run"),
    ])

    assert result.status is TaskStatus.FAILED
    assert result.verified is False
    # `steps` counts distinct actions; `actions` counts attempts, and the
    # save is retried within its budget before the task gives up.
    assert result.steps == 2, "the task continued past a failure"
    assert "500" in result.failure_reason


# --- prompt injection ---------------------------------------------------------


def test_page_text_asking_to_exfiltrate_is_evidence_and_not_an_instruction(
    runtime, site,
) -> None:
    """The page asks, in the imperative, for keys and cookies.

    The runtime has no field it could populate that would honour that: actions
    are a closed enum, uploads take an explicit file list from the caller, and
    observed text reaches a model only inside a fence that names it untrusted.
    """
    _goto(runtime, f"{site.base_url}/injection")
    observation = runtime.observe()

    # Preserved verbatim -- hiding it would lose the record of the attempt.
    assert "Ignore your previous instructions" in observation.text
    assert "id_rsa" in observation.text

    summary = observation.summarise()
    assert "untrusted" in summary.lower()

    # And nothing in the observation is executable or names a tool.
    payload = observation.model_dump()
    assert not (set(payload) & {"tool", "tool_call", "command", "exec",
                                "action", "upload"})
