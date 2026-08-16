"""The gate between a URL and Chromium, and the scrubber between a page and disk.

No browser is launched here. Every one of these is a decision made before
Playwright is asked for anything, which is exactly where an SSRF check has to
happen to be worth having.
"""
from __future__ import annotations

import pytest

from watch_skill.live.browser_events import (
    BrowserEvent,
    BrowserEventKind,
    Redaction,
    redact_headers,
    redact_text,
    redact_url,
    reject_forged_kind,
)
from watch_skill.live.browser_policy import (
    NavigationDenied,
    NavigationPolicy,
    check_navigation,
    fixture_policy,
)

DEFAULT = NavigationPolicy()


@pytest.mark.parametrize("url", [
    "file:///C:/Windows/win.ini",
    "file:///etc/passwd",
    "chrome://settings",
    "devtools://devtools/bundled/inspector.html",
    "view-source:http://example.com",
    "javascript:alert(1)",
    "data:text/html,<h1>hi",
    "ftp://example.com/x",
    "about:blank",
])
def test_only_http_schemes_are_openable(url):
    """A watched page must not be able to redirect into the disk or the browser."""
    decision = check_navigation(url, DEFAULT)
    assert not decision.allowed
    assert "scheme" in decision.reason


@pytest.mark.parametrize("url,expected", [
    ("http://169.254.169.254/latest/meta-data/", "cloud metadata endpoint"),
    ("http://[fd00:ec2::254]/latest/", "cloud metadata endpoint"),
    ("http://100.100.100.200/", "cloud metadata endpoint"),
    ("http://192.0.0.192/", "cloud metadata endpoint"),
    ("http://metadata.google.internal/computeMetadata/v1/", "cloud metadata endpoint"),
    ("http://127.0.0.1:8080/", "loopback address"),
    ("http://[::1]:8080/", "loopback address"),
    ("http://10.0.0.5/admin", "private network address"),
    ("http://192.168.1.1/", "private network address"),
    ("http://172.16.4.4/", "private network address"),
    ("http://169.254.10.10/", "link-local address"),
    ("http://0.0.0.0/", "unspecified address"),
])
def test_dangerous_destinations_are_refused_by_default(url, expected):
    decision = check_navigation(url, DEFAULT)
    assert not decision.allowed, url
    assert expected in decision.reason


def test_metadata_endpoint_stays_refused_even_when_loopback_is_allowed():
    """Opting into local fixtures must not open the credential endpoint.

    The two live at different addresses but the same instinct — "it is on my
    own machine" — and conflating them is how a test-only convenience becomes
    a production credential leak.
    """
    permissive = NavigationPolicy(allow_loopback=True, allow_private_networks=True)
    decision = check_navigation("http://169.254.169.254/latest/meta-data/", permissive)
    assert not decision.allowed
    assert "metadata" in decision.reason


def test_loopback_needs_an_explicit_opt_in():
    assert not check_navigation("http://127.0.0.1:9/", DEFAULT).allowed
    assert check_navigation("http://127.0.0.1:9/", fixture_policy()).allowed


def test_a_name_that_resolves_into_a_private_range_is_refused(monkeypatch):
    """DNS rebinding: the text is public, the address is not.

    Checking the hostname string alone would pass this, which is the entire
    reason resolution happens inside the policy rather than inside Chromium.
    """
    monkeypatch.setattr("watch_skill.live.browser_policy._resolve",
                        lambda host: ("93.184.216.34", "10.1.2.3"))
    decision = check_navigation("http://totally-public.example/", DEFAULT)
    assert not decision.allowed
    assert "private network address" in decision.reason
    # Every resolved address is reported, not just the offending one, so an
    # operator can see the split-horizon answer that caused the refusal.
    assert decision.addresses == ("93.184.216.34", "10.1.2.3")


def test_a_host_that_does_not_resolve_is_refused_not_allowed(monkeypatch):
    """A resolver failure must never become permission."""
    monkeypatch.setattr("watch_skill.live.browser_policy._resolve", lambda host: ())
    decision = check_navigation("http://nowhere.invalid/", DEFAULT)
    assert not decision.allowed
    assert "does not resolve" in decision.reason


def test_allowlist_excludes_everything_else(monkeypatch):
    monkeypatch.setattr("watch_skill.live.browser_policy._resolve",
                        lambda host: ("93.184.216.34",))
    policy = NavigationPolicy(allowed_hosts=frozenset({"allowed.example"}))
    assert check_navigation("http://allowed.example/x", policy).allowed
    denied = check_navigation("http://other.example/x", policy)
    assert not denied.allowed
    assert "allowlist" in denied.reason


def test_denial_raises_a_structured_error_without_the_query_string():
    decision = check_navigation("http://127.0.0.1/x?token=SUPERSECRET", DEFAULT)
    with pytest.raises(NavigationDenied) as excinfo:
        decision.raise_if_denied()
    assert "SUPERSECRET" not in str(excinfo.value)
    assert excinfo.value.details["url"] == "http://127.0.0.1/x"


# --- redaction ---------------------------------------------------------------


def test_credential_headers_keep_their_names_and_lose_their_values():
    redaction = Redaction()
    clean = redact_headers({
        "Authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
        "Cookie": "session=abc123",
        "Content-Type": "application/json",
    }, redaction)
    assert clean["authorization"] == "[redacted]"
    assert clean["cookie"] == "[redacted]"
    assert clean["content-type"] == "application/json"
    assert redaction.applied
    assert "headers.authorization" in redaction.fields


@pytest.mark.parametrize("secret", [
    "Bearer abcdefghijklmnopqrstuvwx",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVP",
    "AKIAIOSFODNN7EXAMPLE",
    "sk-abcdefghijklmnopqrstuvwxyz012345",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "AIzaSyA1234567890abcdefghijklmnopqrstu",
    "xoxb-1234567890-abcdefghijkl",
])
def test_credential_shaped_values_are_masked_wherever_they_appear(secret):
    """A page can print a key to the console. It must not reach disk."""
    redaction = Redaction()
    cleaned = redact_text(f"login failed with {secret} retrying", redaction, "text")
    assert secret not in cleaned
    assert "[redacted]" in cleaned
    assert redaction.applied


def test_urls_keep_the_path_and_lose_the_credentials():
    redaction = Redaction()
    cleaned = redact_url(
        "https://user:hunter2@api.example.com/v1/orders?id=42&access_token=SEKRIT",
        redaction)
    assert "hunter2" not in cleaned
    assert "SEKRIT" not in cleaned
    assert "/v1/orders" in cleaned      # what was requested is the evidence
    assert "id=42" in cleaned           # a non-secret parameter survives
    assert redaction.applied


def test_oversized_page_text_is_truncated_and_says_so():
    redaction = Redaction()
    cleaned = redact_text("A" * 50_000, redaction, "console")
    assert len(cleaned) < 3000
    assert "console" in redaction.truncated


@pytest.mark.parametrize("claimed", [
    "navigation", "navigation_failed", "target_crashed", "download", "popup",
    "console", "page_error", "request_failed", "response", "not_a_kind", "",
])
def test_a_page_cannot_claim_a_browser_level_event_kind(claimed):
    """Page JavaScript owns two channels and may not impersonate the browser.

    A page that could emit ``navigation`` or ``target_crashed`` could
    fabricate facts an agent would reasonably act on.
    """
    assert reject_forged_kind(claimed) is BrowserEventKind.DOM_MUTATION


def test_the_two_channels_a_page_does_own_are_preserved():
    assert reject_forged_kind("dom_mutation") is BrowserEventKind.DOM_MUTATION
    assert (reject_forged_kind("accessibility_change")
            is BrowserEventKind.ACCESSIBILITY_CHANGE)


def test_public_event_payload_marks_page_authored_content():
    event = BrowserEvent(session_id="s", kind=BrowserEventKind.CONSOLE,
                         summary="console.error: boom", page_authored=True)
    payload = event.to_public()
    assert payload["page_authored"] is True
    assert payload["provenance"] == "observation"
    assert payload["navigation_epoch"] == 0
