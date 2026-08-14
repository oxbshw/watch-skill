"""The REST twins of the live and job surfaces.

AGENTS.md: "a behaviour that exists in one surface and not the others is a
bug". These endpoints wrap the same functions the CLI and MCP tools call, so
what is worth testing here is the wiring and the error shape — that a bad
session id becomes a structured HTTP error rather than a stack trace, and
that a cursor round-trips through query parameters.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from watch_skill.jobs import store
from watch_skill.surfaces.api.app import create_app


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


# --- capture capabilities ----------------------------------------------------


def test_capture_capabilities_reports_a_versioned_matrix(client: TestClient) -> None:
    response = client.get("/v1/capture-capabilities")
    assert response.status_code == 200
    payload = response.json()
    assert payload["schema_version"] == 1
    assert payload["capabilities"]
    for capability in payload["capabilities"]:
        assert capability["status"] in (
            "available", "unavailable", "degraded", "untested"
        )
        if capability["status"] == "available":
            assert capability["verified"] != "not_tested"


# --- jobs --------------------------------------------------------------------


def test_jobs_list_and_status_round_trip(client: TestClient) -> None:
    job = store.submit("watch", {"source": "x.mp4"})
    listing = client.get("/v1/jobs").json()
    assert any(row["job_id"] == job.job_id for row in listing["jobs"])

    detail = client.get(f"/v1/jobs/{job.job_id}").json()
    assert detail["state"] == "queued"
    assert detail["schema_version"] == 1

    with_events = client.get(f"/v1/jobs/{job.job_id}", params={"events": True}).json()
    assert with_events["events"][0]["kind"] == "submitted"


def test_cancelling_a_job_over_rest(client: TestClient) -> None:
    job = store.submit("watch", {"source": "x.mp4"})
    response = client.post(f"/v1/jobs/{job.job_id}/cancel")
    assert response.status_code == 200
    assert response.json()["state"] == "cancelled"


def test_an_unknown_job_is_a_structured_error(client: TestClient) -> None:
    response = client.get("/v1/jobs/job_nope")
    assert response.status_code >= 400
    body = response.json()
    detail = body.get("detail", body)
    assert detail.get("error") == "jobs.not_found"
    assert detail.get("fix")


# --- live --------------------------------------------------------------------


def test_an_unknown_live_session_is_a_structured_error(client: TestClient) -> None:
    response = client.get("/v1/live/live_nope")
    assert response.status_code >= 400
    body = response.json()
    detail = body.get("detail", body)
    assert detail.get("error") == "live.session_not_found"
    assert detail.get("fix")


def test_listing_live_sessions_is_empty_not_an_error(client: TestClient) -> None:
    assert client.get("/v1/live").json() == {"sessions": []}


def test_starting_an_unsupported_live_source_fails_honestly(
    client: TestClient,
) -> None:
    """Better a clear refusal than a session that never emits anything."""
    response = client.post("/v1/live", json={"target": "device:0", "kind": "camera"})
    assert response.status_code >= 400
    body = response.json()
    detail = body.get("detail", body)
    assert detail.get("error") in (
        "live.source_unsupported", "live.capture_unavailable"
    )
    assert detail.get("fix")


def test_starting_a_missing_file_fails_before_a_session_exists(
    client: TestClient,
) -> None:
    response = client.post("/v1/live", json={"target": "no-such.mp4"})
    assert response.status_code >= 400
    assert client.get("/v1/live").json() == {"sessions": []}


def test_live_events_reject_a_cursor_from_another_session(
    client: TestClient,
) -> None:
    """A silent reset would flood the caller with events already seen."""
    from watch_skill.live import db
    from watch_skill.live.types import LiveSession, LiveSourceKind, LiveSourceSpec

    session = LiveSession(
        session_id="live_resttest",
        spec=LiveSourceSpec(kind=LiveSourceKind.FILE_REPLAY, target="x.mp4"),
    )
    db.insert_session(session)

    ok = client.get("/v1/live/live_resttest/events").json()
    assert ok["events"] == []
    assert ok["next_cursor"] == "live_resttest:0"

    bad = client.get("/v1/live/live_resttest/events",
                     params={"cursor": "live_other:3"})
    assert bad.status_code >= 400
    body = bad.json()
    detail = body.get("detail", body)
    assert detail.get("error") == "live.cursor_session_mismatch"


def test_asking_a_session_with_no_events_says_so(client: TestClient) -> None:
    from watch_skill.live import db
    from watch_skill.live.types import LiveSession, LiveSourceKind, LiveSourceSpec

    db.insert_session(LiveSession(
        session_id="live_asktest",
        spec=LiveSourceSpec(kind=LiveSourceKind.FILE_REPLAY, target="x.mp4"),
    ))
    payload = client.post("/v1/live/live_asktest/ask",
                          json={"question": "what is happening?"}).json()
    assert payload["confidence"] == 0.0
    assert payload["evidence"] == []
    assert "Nothing has been observed" in payload["answer"]
