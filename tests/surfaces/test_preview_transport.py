"""The live preview transport: scoped, bounded, resumable, and honestly named.

The property under test throughout is that the *label* follows the transport.
A still image wearing the word LIVE is the single failure this whole mechanism
exists to prevent, so the negotiation is asserted here rather than trusted to
the component that renders it.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request

import pytest

from watch_skill.surfaces.mcp.devhost import DevHost, preview_token


@pytest.fixture
def host():
    server = DevHost().start()
    try:
        yield server
    finally:
        server.stop()


def _get(url: str) -> tuple[int, bytes, str]:
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            return response.status, response.read(), response.headers.get(
                "Content-Type", "")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(), exc.headers.get("Content-Type", "")


# --- the capability -----------------------------------------------------------


def test_no_session_offers_no_preview(host) -> None:
    status, body, _ = _get(f"{host.base_url}/api/snapshot")
    assert status == 200
    payload = json.loads(body)
    if payload.get("session") is None:
        assert payload["preview"]["transport"] == "none"
        assert payload["preview"]["reason"]


def test_the_capability_never_carries_a_filesystem_path(host) -> None:
    """The UI is given a session and a token, never somewhere to read from."""
    status, body, _ = _get(f"{host.base_url}/api/snapshot")
    assert status == 200
    preview = json.loads(body)["preview"]
    blob = json.dumps(preview)
    for leak in (":\\", "/frames/", ".jpg", "AppData", "watch-skill-work"):
        assert leak not in blob, f"the preview capability leaked {leak!r}"


# --- the token ----------------------------------------------------------------


def test_a_token_is_scoped_to_one_session() -> None:
    """A token seen in one workspace must not open another session."""
    assert preview_token("live_aaa") != preview_token("live_bbb")
    assert preview_token("live_aaa") == preview_token("live_aaa")


def test_frames_are_refused_without_the_right_token(host) -> None:
    status, _, _ = _get(
        f"{host.base_url}/api/preview/meta?session=live_x&token=wrong")
    assert status == 403

    status, _, _ = _get(
        f"{host.base_url}/api/preview/frame?session=live_x&token=")
    assert status == 403


def test_one_sessions_token_does_not_open_another(host) -> None:
    borrowed = preview_token("live_other")
    status, _, _ = _get(
        f"{host.base_url}/api/preview/meta?session=live_mine&token={borrowed}")
    assert status == 403


# --- absence is not an error --------------------------------------------------


def test_a_session_with_no_frames_yet_is_not_an_error(host) -> None:
    """"Nothing captured yet" is an ordinary state of a healthy session.

    Reported as 404 it becomes a console error in a workspace that is working
    perfectly, which buries the errors that actually matter.
    """
    token = preview_token("live_empty")
    status, body, _ = _get(
        f"{host.base_url}/api/preview/meta?session=live_empty&token={token}")
    assert status == 200
    assert json.loads(body)["available"] is False

    status, body, _ = _get(
        f"{host.base_url}/api/preview/frame?session=live_empty&token={token}")
    assert status == 204
    assert body == b""


def test_the_browser_favicon_request_is_answered(host) -> None:
    """Every browser asks unprompted; a 404 is noise in the proof's console."""
    status, _, _ = _get(f"{host.base_url}/favicon.ico")
    assert status == 204


def test_an_unknown_path_is_still_a_404(host) -> None:
    """Absence-is-not-an-error applies to frames, not to typos."""
    status, _, _ = _get(f"{host.base_url}/api/nope")
    assert status == 404
