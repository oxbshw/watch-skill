"""The oracles that read a running world, and the boundary they must respect.

The point of each of these is that the acting agent cannot make them pass by
asserting they passed. Where that boundary is checkable, it is checked in a
separate process.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from watch_skill.live.capabilities import capability_for
from watch_skill.live.fixture_app import BROKEN_STATUS, FIXED_STATUS, FixtureApp
from watch_skill.verify.checks import CheckContext, run_check
from watch_skill.verify.contract import Check, CheckStatus

pytestmark = pytest.mark.timeout(300)


@pytest.fixture
def app():
    with FixtureApp(splash_delay_ms=300) as running:
        yield running


def _ctx(tmp_path: Path, app=None) -> CheckContext:
    return CheckContext(
        working_dir=str(tmp_path),
        allowed_roots=[str(tmp_path)],
        allowed_origins=[app.base_url] if app else [],
    )


# --- directory manifest ------------------------------------------------------


def test_a_manifest_distinguishes_missing_from_unexpected(tmp_path: Path) -> None:
    """Two different facts: work that did not happen, and work nobody described."""
    root = tmp_path / "out"
    root.mkdir()
    (root / "report.md").write_text("x", encoding="utf-8")
    (root / "stray.tmp").write_text("y", encoding="utf-8")

    lenient = run_check(Check(
        id="m1", type="directory_manifest",
        params={"path": "out", "expected_files": ["report.md"]}), _ctx(tmp_path))
    assert lenient.status is CheckStatus.PASS
    assert lenient.observed["unexpected"] == ["stray.tmp"]

    exact = run_check(Check(
        id="m2", type="directory_manifest",
        params={"path": "out", "expected_files": ["report.md"], "exact": True}),
        _ctx(tmp_path))
    assert exact.status is CheckStatus.FAIL

    missing = run_check(Check(
        id="m3", type="directory_manifest",
        params={"path": "out", "expected_files": ["report.md", "summary.md"]}),
        _ctx(tmp_path))
    assert missing.status is CheckStatus.FAIL
    assert missing.observed["missing"] == ["summary.md"]


def test_a_manifest_cannot_escape_its_allowed_roots(tmp_path: Path) -> None:
    result = run_check(Check(
        id="escape", type="directory_manifest",
        params={"path": "../..", "expected_files": []}), _ctx(tmp_path))
    assert result.status is CheckStatus.ERROR
    assert result.error["code"] == "verify.check_refused"


# --- browser DOM -------------------------------------------------------------


def _require_browser() -> None:
    capability = capability_for("browser")
    if capability.status != "available":
        pytest.skip(f"browser capture is {capability.status}")


def test_a_dom_postcondition_reads_the_real_page(app, tmp_path: Path) -> None:
    """The order starts broken, so the postcondition must fail — honestly."""
    _require_browser()
    check = Check(id="status", type="browser_dom", params={
        "url": f"{app.base_url}/app", "selector": "#order-status",
        "mode": "text", "expected": FIXED_STATUS,
    })
    result = run_check(check, _ctx(tmp_path, app))
    assert result.status is CheckStatus.FAIL
    assert result.observed == BROKEN_STATUS

    # And once the world actually changes, the same check passes. Nothing
    # about the check moved — only the world did.
    app.state.status = FIXED_STATUS
    after = run_check(check, _ctx(tmp_path, app))
    assert after.status is CheckStatus.PASS
    assert after.observed == FIXED_STATUS


def test_dom_modes_read_what_they_claim(app, tmp_path: Path) -> None:
    _require_browser()
    ctx = _ctx(tmp_path, app)
    url = f"{app.base_url}/app"

    exists = run_check(Check(id="e", type="browser_dom", params={
        "url": url, "selector": "#submit", "mode": "exists"}), ctx)
    assert exists.status is CheckStatus.PASS

    # The broken app's submit button is disabled, which is the whole bug.
    enabled = run_check(Check(id="en", type="browser_dom", params={
        "url": url, "selector": "#submit", "mode": "enabled"}), ctx)
    assert enabled.status is CheckStatus.FAIL
    assert enabled.observed is False

    aria = run_check(Check(id="a", type="browser_dom", params={
        "url": url, "selector": "#order-status", "mode": "attribute",
        "attribute": "aria-invalid", "expected": "true"}), ctx)
    assert aria.status is CheckStatus.PASS

    absent = run_check(Check(id="ab", type="browser_dom", params={
        "url": url, "selector": "#nonexistent", "mode": "absent"}), ctx)
    assert absent.status is CheckStatus.PASS


def test_a_missing_element_is_a_failure_not_an_error(app, tmp_path: Path) -> None:
    """A postcondition about an element that never appears has failed.

    Reporting it as ERROR would let a genuinely unmet postcondition be
    dismissed as a flaky check.
    """
    _require_browser()
    result = run_check(Check(id="gone", type="browser_dom", params={
        "url": f"{app.base_url}/app", "selector": "#never-exists",
        "mode": "text", "expected": "anything", "timeout_ms": 1500}),
        _ctx(tmp_path, app))
    assert result.status is CheckStatus.FAIL


def test_a_dom_check_cannot_reach_an_origin_the_contract_did_not_name(
    app, tmp_path: Path
) -> None:
    """A verification contract must not be usable as an SSRF primitive."""
    _require_browser()
    result = run_check(Check(id="ssrf", type="browser_dom", params={
        "url": "http://169.254.169.254/latest/meta-data/",
        "selector": "body", "mode": "exists"}), _ctx(tmp_path, app))
    assert result.status is CheckStatus.ERROR
    assert result.error["code"] == "verify.check_refused"


def test_the_verifier_opens_its_own_browser_in_its_own_process(
    app, isolated_settings: Path
) -> None:
    """The independence claim, asserted across a process boundary.

    The acting agent's browser session is irrelevant here: the verifier is
    told a URL by the frozen contract and goes and looks for itself.
    """
    _require_browser()
    app.state.status = FIXED_STATUS
    probe = isolated_settings.parent / "probe_dom.py"
    probe.write_text(textwrap.dedent(f"""
        import json, sys
        sys.path.insert(0, {str(Path(__file__).resolve().parents[2] / "src")!r})
        from watch_skill.verify.checks import CheckContext, run_check
        from watch_skill.verify.contract import Check

        ctx = CheckContext(working_dir={str(isolated_settings)!r},
                           allowed_origins=[{app.base_url!r}])
        result = run_check(Check(id="dom", type="browser_dom", params={{
            "url": {f"{app.base_url}/app"!r}, "selector": "#order-status",
            "mode": "text", "expected": {FIXED_STATUS!r}}}), ctx)
        print(json.dumps({{"status": result.status.value,
                          "observed": result.observed,
                          "digest": result.output_digest}}))
    """), encoding="utf-8")
    result = subprocess.run(
        [sys.executable, str(probe)],
        env={**os.environ, "WATCHSKILL_DATA_DIR": str(isolated_settings)},
        capture_output=True, text=True, timeout=300,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    assert payload["status"] == "pass"
    assert payload["observed"] == FIXED_STATUS
    assert payload["digest"].startswith("sha256:")


# --- live evidence -----------------------------------------------------------


def test_a_clip_that_aged_out_fails_rather_than_passing_quietly(
    tmp_path: Path,
) -> None:
    """Evidence that cannot be re-read is not evidence."""
    from watch_skill.live import buffer as buf
    from watch_skill.live import db
    from watch_skill.live.types import LiveSession, LiveSourceKind, LiveSourceSpec

    db.insert_session(LiveSession(
        session_id="live_ev",
        spec=LiveSourceSpec(kind=LiveSourceKind.FILE_REPLAY, target="x")))
    artifact = tmp_path / "clip.mp4"
    artifact.write_bytes(b"not really a clip, but it hashes")
    segment = buf.record("live_ev", "clip", artifact, 1.0)

    present = run_check(Check(id="ev", type="live_evidence", params={
        "session_id": "live_ev", "artifact_id": segment.artifact_id}),
        _ctx(tmp_path))
    assert present.status is CheckStatus.PASS
    recorded_digest = present.observed

    pinned = run_check(Check(id="ev2", type="live_evidence", params={
        "session_id": "live_ev", "artifact_id": segment.artifact_id,
        "digest": recorded_digest}), _ctx(tmp_path))
    assert pinned.status is CheckStatus.PASS

    # Tamper with the artifact and the same check must now refuse it.
    artifact.write_bytes(b"tampered")
    tampered = run_check(Check(id="ev3", type="live_evidence", params={
        "session_id": "live_ev", "artifact_id": segment.artifact_id,
        "digest": recorded_digest}), _ctx(tmp_path))
    assert tampered.status is CheckStatus.FAIL
    assert "does NOT match" in tampered.summary

    artifact.unlink()
    gone = run_check(Check(id="ev4", type="live_evidence", params={
        "session_id": "live_ev", "artifact_id": segment.artifact_id}),
        _ctx(tmp_path))
    assert gone.status is CheckStatus.FAIL


def test_no_browser_evidence_is_inconclusive_not_a_pass(tmp_path: Path) -> None:
    """An empty log is proof nobody looked, not proof nothing happened."""
    from watch_skill.live import db
    from watch_skill.live.types import LiveSession, LiveSourceKind, LiveSourceSpec

    db.insert_session(LiveSession(
        session_id="live_quiet",
        spec=LiveSourceSpec(kind=LiveSourceKind.FILE_REPLAY, target="x")))
    result = run_check(Check(id="console", type="live_console", params={
        "session_id": "live_quiet", "expect": "none"}), _ctx(tmp_path))
    assert result.status is CheckStatus.INCONCLUSIVE
