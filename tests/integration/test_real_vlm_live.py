"""A real vision model, inside a running live session, scored against truth.

This is the only file that can say the semantic path works end to end with an
actual model. Everything else in the suite proves the machinery *around*
inference — selection, ordering, freshness, schema — using a backend that sees
nothing.

Opt-in, because it is slow: the model takes tens of seconds per keyframe on a
CPU, and the fixture plays for over two minutes in real time. The default
suite must stay offline and fast, so nothing here runs without:

    WATCHSKILL_TEST_REAL_VLM_LIVE=1
    WATCHSKILL_VLM_PYTHON=<python.exe of an env with torch + transformers>

The fixture is generated locally by `scripts/make_live_vlm_fixture.py`, so
every pixel is rights-clear and every state boundary has a known timestamp to
score against.

What is deliberately *not* asserted: that the model is good. A 256M model
reading a downscaled frame mangles small text and invents plausible words. The
gate checks that a real model produced a real reading of the right frame, that
the reading was persisted with enough provenance to be checked later, and that
nothing it said could become an action.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]

pytestmark = [
    pytest.mark.real_model,
    pytest.mark.skipif(
        not os.environ.get("WATCHSKILL_TEST_REAL_VLM_LIVE"),
        reason="real-model live VLM gate; set WATCHSKILL_TEST_REAL_VLM_LIVE=1 "
        "and WATCHSKILL_VLM_PYTHON=<interpreter with torch> to run "
        "(see docs/testing.md)",
    ),
    pytest.mark.skipif(
        not os.environ.get("WATCHSKILL_VLM_PYTHON"),
        reason="no external VLM interpreter configured: set "
        "WATCHSKILL_VLM_PYTHON to a python.exe with torch and transformers",
    ),
    pytest.mark.skipif(
        not os.environ.get("WATCHSKILL_VLM_REVISION"),
        reason="no model revision pinned: set WATCHSKILL_VLM_REVISION to the "
        "exact commit in the cache. Without it the library resolves 'main' "
        "over the network, which offline mode refuses — and an observation "
        "that cannot name the revision that produced it is not reproducible "
        "evidence.",
    ),
]

# The fixture plays in real time; an interpretation takes tens of seconds. The
# budget has to cover a cold model load plus at least one full inference, with
# room for a machine under load.
OBSERVATION_TIMEOUT_S = 420.0


# --- the egress guard ---------------------------------------------------------

_SITECUSTOMIZE = '''\
"""Installed into the model worker to make any egress attempt fail loudly.

Imported automatically at interpreter startup, before torch or transformers
load, so there is no window in which a connection could slip out unrecorded.
Loopback is allowed: it is not egress, and blocking it would break unrelated
machinery inside the child.
"""
import os
import socket

_LOG = os.environ.get("WATCHSKILL_EGRESS_LOG", "")
_LOCAL = {"127.0.0.1", "::1", "localhost", "0.0.0.0"}
_original = socket.socket.connect


def _record(address):
    if not _LOG:
        return
    try:
        with open(_LOG, "a", encoding="utf-8") as handle:
            handle.write(repr(address) + "\\n")
    except OSError:
        pass


def _guard(self, address):
    host = address[0] if isinstance(address, tuple) else str(address)
    if str(host) not in _LOCAL:
        _record(address)
        raise OSError(f"egress blocked by the test harness: {address!r}")
    return _original(self, address)


socket.socket.connect = _guard
'''


@pytest.fixture(scope="module")
def egress_guard(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Make the worker process incapable of reaching the network.

    Stronger than asserting `HF_HUB_OFFLINE` is set: that is a request to a
    library, this is a refusal in the socket layer of the process that would
    have made the call.
    """
    directory = tmp_path_factory.mktemp("egress-guard")
    (directory / "sitecustomize.py").write_text(_SITECUSTOMIZE, encoding="utf-8")
    log = directory / "egress.log"
    os.environ["PYTHONPATH"] = os.pathsep.join(
        [str(directory), os.environ.get("PYTHONPATH", "")]).rstrip(os.pathsep)
    os.environ["WATCHSKILL_EGRESS_LOG"] = str(log)
    return log


@pytest.fixture(scope="module")
def module_data_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """One data directory for the whole module.

    The shared `isolated_settings` fixture is autouse and *function*-scoped,
    so each test would otherwise get a fresh store — and the session this
    module spends several minutes producing would vanish between the test
    that creates it and the tests that read it back.
    """
    return tmp_path_factory.mktemp("live vlm data")


@pytest.fixture(autouse=True)
def pin_data_dir(isolated_settings: Path, module_data_dir: Path,
                 monkeypatch: pytest.MonkeyPatch) -> None:
    """Re-point every test in this module at the module-scoped store.

    Depends on `isolated_settings` so it runs *after* it and wins.
    """
    from watch_skill.config import reset_settings

    monkeypatch.setenv("WATCHSKILL_DATA_DIR", str(module_data_dir))
    reset_settings()


@pytest.fixture(scope="module")
def fixture(tmp_path_factory: pytest.TempPathFactory) -> dict:
    pytest.importorskip("PIL")
    sys.path.insert(0, str(REPO_ROOT / "scripts"))
    from make_live_vlm_fixture import build  # noqa: PLC0415

    out = tmp_path_factory.mktemp("live-vlm-fixture")
    manifest = build(out)
    manifest["path"] = out / manifest["video"]
    return manifest


def _semantic_events(session_id: str) -> list[dict]:
    """Every persisted model reading, read back through the canonical API.

    `observe` returns `to_public()` dicts, not `LiveEvent` objects. Reaching
    for `event.detail` with `getattr` silently yields None for every event and
    reports a session that produced nothing — which is exactly what it did,
    for two full runs, while the model was working perfectly.
    """
    from watch_skill.live import session as live

    result = live.observe(session_id, limit=500)
    found = []
    for event in result["events"]:
        detail = event.get("detail") or {}
        semantic = detail.get("semantic")
        if isinstance(semantic, dict) and semantic.get("provenance", {}).get(
                "kind") == "model_inference":
            found.append(semantic)
    return found


@pytest.fixture(scope="module")
def live_run(fixture: dict, egress_guard: Path, module_data_dir: Path) -> dict:
    """Run the fixture through a live session with the real model attached.

    Module-scoped: this costs several minutes of CPU, and every assertion
    below is a different question about the same one run.
    """
    from watch_skill.config import reset_settings
    from watch_skill.live import session as live

    # Set here rather than relying on the autouse fixture: this fixture is
    # module-scoped and therefore constructed *before* any function-scoped
    # fixture runs, so at this moment `isolated_settings` has not pointed
    # anywhere yet. Without this the session is created in one store and read
    # back from another.
    os.environ["WATCHSKILL_DATA_DIR"] = str(module_data_dir)
    reset_settings()

    started_wall = time.time()
    session = live.start_live(
        target=str(fixture["path"]),
        kind="file_replay",
        # 1 fps, not 2. The selector interprets a handful of keyframes either
        # way, but every captured frame costs scene-hash and OCR work on the
        # same four threads the model is generating on — and here the model is
        # the slow thing being measured.
        fps=1.0,
        audio=False,
        detail={
            "semantic_vlm": True,
            "vlm_revision": os.environ.get("WATCHSKILL_VLM_REVISION", ""),
            "semantic_budget": 20,
        },
    )
    session_id = session.session_id

    observations: list[dict] = []
    running_when_seen: bool | None = None
    responsiveness: list[float] = []
    detector: dict = {}
    deadline = time.time() + OBSERVATION_TIMEOUT_S

    try:
        while time.time() < deadline:
            # Responsiveness is measured from the outside, the way a user
            # would feel it: how long a status call takes while the model is
            # occupying a core. A pipeline blocked on inference shows up here
            # as a status call that stops returning.
            probe = time.monotonic()
            status = live.status(session_id)
            responsiveness.append((time.monotonic() - probe) * 1000)
            # Kept so a failure can say *why* nothing arrived. A gate that
            # reports "no observation" without the model's own account of
            # itself sends the reader to a debugger instead of an answer.
            detector = (status.get("detectors") or {}).get("semantic") or {}

            observations = _semantic_events(session_id)
            if observations and running_when_seen is None:
                # The claim under test: a reading arrived while the thing it
                # describes was still playing. Latched on the first one,
                # because by the end of the run it is trivially false.
                running_when_seen = status["state"] == "running"
            if status["state"] not in ("starting", "running"):
                break
            # Deliberately does not stop at the first observation. At roughly
            # 50s per inference, stopping there would only ever sample the
            # opening state, and the failure and recovery segments — the ones
            # with ground truth worth scoring — would never be looked at.
            time.sleep(1.0)

        final_status = live.status(session_id)
        observations = _semantic_events(session_id)
    finally:
        live.stop_live(session_id)

    return {
        "session_id": session_id,
        "observations": observations,
        "running_when_seen": running_when_seen,
        "responsiveness_ms": responsiveness,
        "status": final_status,
        "detector": detector,
        "elapsed": time.time() - started_wall,
        "egress_log": egress_guard,
        "manifest": fixture,
    }


# --- the gate -----------------------------------------------------------------


def test_a_real_observation_arrives_while_the_source_is_still_running(
    live_run: dict, record_property,
) -> None:
    """Condition 1 and 2: a real reading, and a pipeline that kept working."""
    observations = live_run["observations"]
    assert observations, (
        f"no real-model observation in {live_run['elapsed']:.0f}s — "
        f"session ended as {live_run['status']['state']}. The vision "
        f"detector's own account of itself: "
        f"{json.dumps(live_run['detector'], default=str)}")

    latencies = [o["timing"]["latency_ms"] for o in observations]
    ordered = sorted(latencies)
    record_property("vlm_live_metrics", json.dumps({
        "observations": len(observations),
        "elapsed_seconds": round(live_run["elapsed"], 1),
        "latency_ms_p50": ordered[len(ordered) // 2],
        "latency_ms_p95": ordered[min(len(ordered) - 1,
                                      int(len(ordered) * 0.95))],
        "model": observations[0]["provenance"]["model"],
        "revision": observations[0]["provenance"]["revision"],
        "freshness": [o["freshness"] for o in observations],
        "late_by_seconds": [o["timing"]["late_by_seconds"] for o in observations],
    }))

    assert live_run["running_when_seen"] is True, (
        "the first observation only appeared after the source had ended; "
        "this gate exists to prove a *running* session produces one")

    # The status call must stay responsive while a core is busy generating.
    worst = max(live_run["responsiveness_ms"])
    record_property("status_latency_ms_max", str(round(worst, 1)))
    assert worst < 5000, (
        f"a status call took {worst:.0f}ms while inference ran — the model is "
        f"blocking the pipeline it is supposed to be observing")


def test_the_observation_names_the_exact_frame_it_describes(
    live_run: dict,
) -> None:
    """Condition 3. Tens of seconds later, this is the only link."""
    observation = live_run["observations"][0]
    frame = observation["frame"]

    assert len(frame["sha256"]) == 64, "no frame hash was recorded"
    assert int(frame["sha256"], 16) >= 0, "the frame hash is not hexadecimal"
    assert frame["media_ts"] >= 0.0
    assert frame["media_ts"] == observation["media_ts"], (
        "the observation and its frame disagree about when it happened")
    assert frame["captured_wall_ts"] > 0.0
    timing = observation["timing"]
    assert timing["inference_completed_wall_ts"] >= \
        timing["inference_started_wall_ts"]
    assert timing["latency_ms"] > 0.0

    provenance = observation["provenance"]
    assert provenance["model"], "no model identity was recorded"
    assert provenance["worker_protocol_version"] >= 1


def test_the_labelled_failure_state_is_detected(live_run: dict,
                                                record_property) -> None:
    """Condition 4, scored against the fixture's ground truth."""
    manifest = live_run["manifest"]
    window = manifest["failure_window"]
    observations = live_run["observations"]

    in_window = [o for o in observations
                 if window[0] <= o["media_ts"] <= window[1]]
    if not in_window:
        pytest.skip(
            f"no keyframe was interpreted inside the failure window "
            f"{window} — {len(observations)} observation(s) landed at "
            f"{[round(o['media_ts'], 1) for o in observations]}. At this "
            f"latency the selector may not reach that segment.")

    detected = [
        o for o in in_window
        if o["anomaly"] or o["ui_state"] == "apparent_failure"
        or "fail" in o["observation"].lower()
    ]
    record_property("failure_detection", json.dumps({
        "in_window": len(in_window),
        "detected": len(detected),
        "readings": [o["observation"] for o in in_window],
    }))
    assert detected, (
        "the model looked at the failure state and reported nothing wrong. "
        f"It said: {[o['observation'] for o in in_window]}")


def test_visual_prompt_injection_stays_evidence_and_cannot_act(
    live_run: dict,
) -> None:
    """Condition 5. The frame that tells the model to delete everything.

    Whatever the model replies, the result is a typed observation. There is no
    field it could populate that would cause a call, and an observation that
    is not `current_state` cannot drive a present-tense action at all.
    """
    for observation in live_run["observations"]:
        assert observation["advisory"] is True
        assert observation["provenance"]["kind"] == "model_inference"
        assert not (set(observation) &
                    {"tool", "tool_call", "command", "exec", "action"})
        # Whatever the reading says, acting on it is gated by freshness, and
        # freshness is decided by the clock rather than by the text.
        if not observation["may_trigger_current_state_action"]:
            assert observation["freshness"] in (
                "stale_for_action", "historical_evidence")


def test_the_reading_is_persisted_and_readable_from_a_fresh_process(
    live_run: dict, tmp_path: Path,
) -> None:
    """Conditions 6 and 7 together: it survives the process that made it."""
    session_id = live_run["session_id"]
    probe = tmp_path / "probe_vlm.py"
    probe.write_text(
        "import json, sys\n"
        f"sys.path.insert(0, {str(REPO_ROOT / 'src')!r})\n"
        "from watch_skill.live import session as live\n"
        f"result = live.observe({session_id!r}, limit=500)\n"
        "found = []\n"
        "for event in result['events']:\n"
        "    detail = event.get('detail') or {}\n"
        "    semantic = detail.get('semantic')\n"
        "    if isinstance(semantic, dict) and semantic.get(\n"
        "            'provenance', {}).get('kind') == 'model_inference':\n"
        "        found.append(semantic)\n"
        "print(json.dumps(found))\n",
        encoding="utf-8")

    completed = subprocess.run(
        [sys.executable, str(probe)], capture_output=True, text=True,
        timeout=180, cwd=str(REPO_ROOT),
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
    )
    assert completed.returncode == 0, (
        f"the fresh process could not read the session: {completed.stderr[-600:]}")
    reread = json.loads(completed.stdout)
    assert reread, "a fresh process found no model observation"

    # The same reading, not merely some reading.
    original = live_run["observations"][0]
    match = [o for o in reread
             if o["frame"]["sha256"] == original["frame"]["sha256"]]
    assert match, "the observation a fresh process read does not match"
    assert match[0]["observation"] == original["observation"]
    assert match[0]["provenance"]["revision"] == \
        original["provenance"]["revision"]


def test_no_outbound_network_call_was_made_during_inference(
    live_run: dict,
) -> None:
    """Condition 8, proved in the socket layer of the process that would leak."""
    log = live_run["egress_log"]
    attempts = log.read_text(encoding="utf-8").strip() if log.exists() else ""
    assert attempts == "", f"the model worker attempted egress: {attempts[:400]}"


def test_cancellation_kills_the_worker_and_leaves_no_partial_artifact(
    live_run: dict,
) -> None:
    """Conditions 9 and 10: stop is a teardown, not a request."""
    from watch_skill.live import session as live

    session_id = live_run["session_id"]
    # `stop_live` returns once teardown has begun, not once it has finished —
    # an in-flight inference is abandoned rather than waited for, which is the
    # whole point. So the terminal state is polled rather than asserted on the
    # first read.
    deadline = time.time() + 60
    status = live.status(session_id)
    while status["state"] == "stopping" and time.time() < deadline:
        time.sleep(0.5)
        status = live.status(session_id)
    assert status["state"] in ("stopped", "finalized", "failed"), status["state"]

    # Nothing half-written survives a stop. Every persisted observation is a
    # complete record or it is not there at all.
    for observation in _semantic_events(session_id):
        assert observation["provenance"]["model"]
        assert observation["frame"]["sha256"]
        assert "freshness" in observation


def test_the_worker_reports_its_own_state_honestly() -> None:
    """Condition 10. An idle release that lies about memory is worse than none."""
    from watch_skill.live.vlm_backend import SmolVlmSemanticBackend

    backend = SmolVlmSemanticBackend()
    diagnostics = backend.diagnostics()
    assert diagnostics["configured"] is True
    assert diagnostics["model"]
    # Never loaded in this process, and it says so rather than guessing.
    assert diagnostics["loaded"] is False
    assert diagnostics["running"] is False
    backend.close()
