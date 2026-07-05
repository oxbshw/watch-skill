"""REST API surface: auth, error mapping, OpenAPI, and a full watch+ask flow."""
from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("fastapi", reason="api extra not installed")
pytest.importorskip("scenedetect", reason="perceive extra not installed")

from fastapi.testclient import TestClient  # noqa: E402

from watch_skill.config import reset_settings  # noqa: E402
from watch_skill.surfaces.api import create_app  # noqa: E402


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    # keyless, modelless test environment: no whisper download, no OCR pass
    monkeypatch.setenv("WATCHSKILL_LOCAL_WHISPER_ENABLED", "false")
    monkeypatch.setenv("WATCHSKILL_OCR_ENABLED", "false")
    reset_settings()
    return TestClient(create_app())


def test_health_is_open(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_openapi_spec_covers_every_operation(client: TestClient) -> None:
    spec = client.get("/openapi.json").json()
    paths = spec["paths"]
    for expected in (
        "/v1/watch", "/v1/ask", "/v1/videos/{video}/moment", "/v1/search",
        "/v1/videos", "/v1/capture", "/v1/loops", "/v1/loops/{loop_id}/iterate",
        "/v1/loops/{loop_id}", "/v1/doctor",
    ):
        assert expected in paths, f"missing {expected} in OpenAPI spec"


def test_bearer_auth_enforced(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WATCHSKILL_API_BEARER_TOKEN", "s3cret")
    reset_settings()
    client = TestClient(create_app())
    assert client.get("/v1/videos").status_code == 401
    wrong = client.get("/v1/videos", headers={"Authorization": "Bearer nope"})
    assert wrong.status_code == 401
    assert wrong.json()["detail"]["error"] == "auth.invalid_token"
    right = client.get("/v1/videos", headers={"Authorization": "Bearer s3cret"})
    assert right.status_code == 200


def test_unknown_video_maps_to_404(client: TestClient) -> None:
    response = client.post("/v1/ask", json={"video": "no-such-id", "question": "?"})
    assert response.status_code == 404
    body = response.json()["detail"]
    assert body["error"].startswith("index.")
    assert body["fix"]


def test_unknown_loop_maps_to_404(client: TestClient) -> None:
    response = client.get("/v1/loops/nope")
    assert response.status_code == 404
    assert response.json()["detail"]["error"] == "loop.not_found"


def test_watch_then_ask_roundtrip(client: TestClient, sample_video: Path) -> None:
    watched = client.post(
        "/v1/watch",
        json={"source": str(sample_video), "budget": 8, "inline_frames": 1},
    )
    assert watched.status_code == 200, watched.text
    body = watched.json()
    video_id = body["video_id"]
    assert body["frames"], "watch must return frame descriptors"
    assert body["frames"][0].get("base64"), "first frame should be inlined"
    assert "# watch-skill: video report" in body["report"]

    listed = client.get("/v1/videos").json()
    assert any(v["id"] == video_id for v in listed)

    asked = client.post("/v1/ask", json={"video": video_id, "question": "what appears?"})
    assert asked.status_code == 200

    moment = client.get(
        f"/v1/videos/{video_id}/moment", params={"timestamp": "0:04", "window": 4}
    )
    assert moment.status_code == 200
    assert moment.json()["frames"]


def test_public_bind_without_token_refused() -> None:
    from watch_skill.errors import ConfigError
    from watch_skill.surfaces.api import serve

    with pytest.raises(ConfigError) as excinfo:
        serve(host="0.0.0.0", port=0)
    assert excinfo.value.code == "config.public_bind_no_token"
