"""What a watched browser is allowed to open.

A browser driven by an agent is an SSRF primitive with a screenshot API
attached. The page it lands on decides what it fetches next, and "watch this
URL" is a request the agent may have taken from a webpage, an OCR read, or a
transcript — none of which are trusted. So navigation is decided *here*,
before Chromium is asked to do anything, and again on every document request
the page initiates.

The rules are deny-by-default in the directions that matter:

* Only ``http`` and ``https``. ``file://`` reads the disk, ``chrome://``
  reaches the browser's own internals, and neither is a thing a watched page
  should be able to reach by redirecting.
* No loopback, link-local, private, multicast, reserved, or unspecified
  addresses. The cloud metadata endpoints live at well-known link-local
  addresses and are the single highest-value SSRF target on a hosted machine.
* Resolution happens here, so a hostname that *resolves* into a blocked range
  is refused even though its text looks public. That is the whole DNS-rebinding
  class, and checking the string alone would miss all of it.

Local fixtures are the one exception, and they are opt-in per session
(``allow_loopback``). A test that needs ``127.0.0.1:PORT`` says so; nothing
reaches loopback because a default was convenient.
"""
from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from watch_skill.errors import WatchSkillError

ALLOWED_SCHEMES = frozenset({"http", "https"})

# Resolved separately from the private-range check because the message matters:
# an operator who sees "metadata endpoint" knows immediately that something
# tried to steal cloud credentials, where "link-local" reads as a config error.
METADATA_ADDRESSES = frozenset({
    "169.254.169.254",   # AWS / Azure / DigitalOcean / OpenStack IMDS
    "100.100.100.200",   # Alibaba Cloud
    "192.0.0.192",       # Oracle Cloud
    "fd00:ec2::254",     # AWS IMDSv2 over IPv6
})

METADATA_HOSTNAMES = frozenset({
    "metadata.google.internal",
    "metadata.goog",
    "instance-data",
})


class NavigationDenied(WatchSkillError):
    """A URL was refused before the browser was asked to open it."""

    default_code = "live.browser.navigation_denied"


@dataclass(frozen=True)
class NavigationPolicy:
    """The rules one browser session navigates under.

    Frozen, and snapshotted onto the session, so the policy a session ran
    under can be read back from the event log afterwards rather than inferred
    from whatever the settings happen to say now.
    """

    allow_loopback: bool = False
    """Permit 127.0.0.0/8 and ::1. Off by default; local fixture tests and an
    operator watching their own dev server turn it on explicitly."""

    allow_private_networks: bool = False
    """Permit RFC1918 and fc00::/7. Off by default: an agent that can reach
    the LAN can reach the router's admin page."""

    allowed_hosts: frozenset[str] = field(default_factory=frozenset)
    """When non-empty, an allowlist — nothing else may be opened at all,
    whatever its address. The strongest available setting."""

    blocked_hosts: frozenset[str] = field(default_factory=frozenset)
    resolve: bool = True
    """Resolve hostnames and check every resulting address. Turning this off
    leaves only the textual checks and is for environments with no resolver;
    it is not a way to reach a blocked address."""

    def to_dict(self) -> dict[str, object]:
        return {
            "allow_loopback": self.allow_loopback,
            "allow_private_networks": self.allow_private_networks,
            "allowed_hosts": sorted(self.allowed_hosts),
            "blocked_hosts": sorted(self.blocked_hosts),
            "resolve": self.resolve,
        }


@dataclass(frozen=True)
class NavigationDecision:
    allowed: bool
    url: str
    host: str
    reason: str
    addresses: tuple[str, ...] = ()

    def raise_if_denied(self) -> None:
        if self.allowed:
            return
        raise NavigationDenied(
            f"navigation to {self.host or self.url!r} is refused: {self.reason}",
            code="live.browser.navigation_denied",
            fix="watch a public http(s) URL, or start the session with an "
                "explicit local-fixture policy if this is your own server",
            details={"url": _safe_url(self.url), "host": self.host,
                     "reason": self.reason, "addresses": list(self.addresses)},
        )


def _safe_url(url: str) -> str:
    """A URL with its query and fragment dropped.

    Denied URLs end up in logs and event payloads. Query strings are where
    tokens live, so the part that identifies the target is kept and the part
    that tends to carry secrets is not.
    """
    try:
        parts = urlsplit(url)
    except ValueError:
        return "<unparseable>"
    return f"{parts.scheme}://{parts.netloc}{parts.path}" if parts.scheme else url[:120]


def _classify(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> str | None:
    """Why this address is refused, or None if it is fine.

    Ordered most-specific first so the message names the real reason.
    """
    if str(address) in METADATA_ADDRESSES:
        return "cloud metadata endpoint"
    if address.is_unspecified:
        return "unspecified address"
    if address.is_loopback:
        return "loopback address"
    if address.is_link_local:
        return "link-local address"
    if address.is_multicast:
        return "multicast address"
    if address.is_private:
        return "private network address"
    if address.is_reserved:
        return "reserved address"
    return None


def _resolve(host: str) -> tuple[str, ...]:
    """Every address a hostname currently resolves to.

    All of them are checked, not just the first: a name that returns one
    public and one private address would otherwise pass and then connect to
    whichever the browser picked.
    """
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except (socket.gaierror, UnicodeError, OSError):
        return ()
    return tuple(sorted({info[4][0].split("%")[0] for info in infos}))


def check_navigation(url: str, policy: NavigationPolicy) -> NavigationDecision:
    """Whether this URL may be opened, and why not when it may not."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return NavigationDecision(False, url, "", "the URL cannot be parsed")

    scheme = (parts.scheme or "").lower()
    if scheme not in ALLOWED_SCHEMES:
        return NavigationDecision(
            False, url, parts.hostname or "",
            f"scheme {scheme or '(none)'!r} is not permitted; "
            f"only {', '.join(sorted(ALLOWED_SCHEMES))} are",
        )

    host = (parts.hostname or "").lower().rstrip(".")
    if not host:
        return NavigationDecision(False, url, "", "the URL has no host")

    if host in policy.blocked_hosts:
        return NavigationDecision(False, url, host, "host is explicitly blocked")
    if policy.allowed_hosts and host not in policy.allowed_hosts:
        return NavigationDecision(
            False, url, host, "host is not in this session's allowlist",
        )
    if host in METADATA_HOSTNAMES:
        return NavigationDecision(False, url, host, "cloud metadata endpoint")

    # A literal address needs no resolver, and must not get one: resolving
    # "127.0.0.1" is pointless and a resolver failure must not become a pass.
    literal = _as_address(host)
    addresses: tuple[str, ...]
    if literal is not None:
        addresses = (str(literal),)
    elif policy.resolve:
        addresses = _resolve(host)
        if not addresses:
            return NavigationDecision(
                False, url, host, "the host does not resolve",
            )
    else:
        addresses = ()

    for text in addresses:
        address = _as_address(text)
        if address is None:
            return NavigationDecision(False, url, host,
                                      f"unparseable resolved address {text!r}",
                                      addresses)
        reason = _classify(address)
        if reason is None:
            continue
        if reason == "loopback address" and policy.allow_loopback:
            continue
        if reason == "private network address" and policy.allow_private_networks:
            continue
        return NavigationDecision(False, url, host,
                                  f"{reason} ({text})", addresses)

    return NavigationDecision(True, url, host, "permitted by navigation policy",
                              addresses)


def _as_address(text: str):  # noqa: ANN201 - union of two ipaddress types
    try:
        return ipaddress.ip_address(text.strip("[]"))
    except ValueError:
        return None


def fixture_policy() -> NavigationPolicy:
    """The policy a local fixture runs under: loopback, and nothing else.

    Deliberately not "allow everything for tests". A fixture test that could
    silently reach the internet would hide exactly the egress regression the
    offline gate exists to catch.
    """
    return NavigationPolicy(
        allow_loopback=True,
        allow_private_networks=False,
        allowed_hosts=frozenset({"127.0.0.1", "localhost", "[::1]", "::1"}),
        resolve=True,
    )


__all__ = [
    "ALLOWED_SCHEMES",
    "METADATA_ADDRESSES",
    "METADATA_HOSTNAMES",
    "NavigationDecision",
    "NavigationDenied",
    "NavigationPolicy",
    "check_navigation",
    "fixture_policy",
]
