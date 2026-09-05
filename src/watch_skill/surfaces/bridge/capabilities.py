"""What this Core can actually do, established by asking it.

The handshake's capability list is the one place the Host learns what to
offer, so the way it is produced decides whether a green screen means
anything. Two ways of producing it were rejected:

*A static list.* Every capability the product declares, reported as present.
That is what a descriptor file gives you, and it is how a UI comes to show a
button that fails — the code exists, so the capability was reported, so the
button was drawn.

*A probe per capability at handshake time.* Honest, and unusable: running OCR
and a transcription ladder to answer "are you there" turns a connect into a
minute of work on every reconnect.

What this module does instead is ask the parts of Core that already know.
:func:`watch_skill.health.doctor.run_doctor` has established what binaries and
models are present; :func:`watch_skill.live.capability_matrix` has established
what this machine can capture. Both are cheap, both are already the answer
Core gives its own CLI, and neither is a guess. What they cannot establish —
that a real request succeeded here — is reported as ``implemented``, never as
``machine_tested``, because those are different facts and only one of them is
a promise.
"""
from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from watch_skill.surfaces.bridge.wire import CapabilityTruth

_log = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


#: Every capability the Bridge exposes, and the doctor checks it rests on.
#:
#: A capability with no checks is one whose code path needs nothing external:
#: it is ``implemented`` as soon as Core is running, and saying so is accurate.
_CAPABILITY_CHECKS: dict[str, tuple[str, ...]] = {
    "watch.video.index": ("ffmpeg", "disk"),
    "watch.video.query": ("index",),
    "watch.library.search": ("index",),
    "watch.memory.recall": ("index",),
    # Browser evidence is retained by the Bridge authority itself.  It does
    # not depend on the Library index, and claiming that it did made a healthy
    # browser citation look unavailable on a fresh profile with an empty index.
    "watch.evidence.resolve": (),
    "watch.verification.run": (),
    "watch.live.session": ("ffmpeg",),
    "watch.browser.observe": (),
    "watch.browser.operate": (),
}

#: Capabilities whose truth comes from the live capture matrix instead.
_CAPTURE_BACKED = frozenset({"watch.live.session"})
_BROWSER_CAPTURE_BACKED = frozenset({"watch.browser.observe", "watch.browser.operate"})

#: Capabilities the contract declares that this Bridge cannot perform, with
#: the reason and the fix.
#:
#: These are reported ``unavailable`` no matter how healthy the machine is,
#: because the gap is in Core's Bridge surface rather than in the environment.
#: Reporting them from their doctor checks instead would be the exact defect
#: this whole file exists to prevent: the dependency is present, so the
#: capability looks ready, so the Host draws a control that cannot work.
_NOT_BRIDGED: dict[str, tuple[str, str]] = {}


def _doctor_index(report: Any) -> dict[str, tuple[str, str]]:
    """Doctor checks as ``{name: (status, message)}``, tolerant of shape drift.

    Tolerant because a handshake that raises because doctor grew a field is a
    Core that cannot be connected to at all — a strictly worse failure than
    one capability reporting ``not_tested``.
    """
    index: dict[str, tuple[str, str]] = {}
    for check in getattr(report, "checks", []):
        name = getattr(check, "name", None)
        if not isinstance(name, str):
            continue
        index[name] = (
            str(getattr(check, "status", "warn")),
            str(getattr(check, "message", "")),
        )
    return index


def _match(index: dict[str, tuple[str, str]], needle: str) -> tuple[str, str] | None:
    """Find a doctor check by substring, because check names are prose-ish."""
    for name, value in index.items():
        if needle in name.lower():
            return value
    return None


def _from_doctor(
    capability_id: str,
    checks: tuple[str, ...],
    index: dict[str, tuple[str, str]],
    core_version: str,
) -> CapabilityTruth:
    detected: dict[str, str] = {}
    missing: list[str] = []
    fixes: list[str] = []

    for requirement in checks:
        found = _match(index, requirement)
        if found is None:
            missing.append(requirement)
            fixes.append(f"Run `watch-skill doctor` to check {requirement}.")
            continue
        status, message = found
        detected[requirement] = status
        if status == "fail":
            missing.append(requirement)
            fixes.append(f"{requirement}: {message}")

    if missing:
        return CapabilityTruth(
            capability_id=capability_id,
            provider="watch-skill",
            provider_version=core_version,
            status="unavailable",
            requirements=list(checks),
            detected=detected,
            missing=missing,
            fixes=fixes,
            last_checked_at=_now(),
        )
    # Every dependency this capability names is present, and that is a probe:
    # a real request has still not been made, so the status stops short of
    # `machine_tested` on purpose.
    return CapabilityTruth(
        capability_id=capability_id,
        provider="watch-skill",
        provider_version=core_version,
        status="probed" if checks else "implemented",
        requirements=list(checks),
        detected=detected,
        missing=[],
        fixes=[],
        last_checked_at=_now(),
    )


def _from_capture(capability_id: str, matrix: dict[str, Any] | None, core_version: str) -> CapabilityTruth:
    if matrix is None:
        return CapabilityTruth(
            capability_id=capability_id,
            provider="watch-skill",
            provider_version=core_version,
            status="not_tested",
            requirements=["a working capture backend"],
            detected={},
            missing=["capture-matrix"],
            fixes=["Run `watch-skill capture-capabilities` to see why."],
            last_checked_at=_now(),
        )
    available = list(matrix.get("available") or [])
    degraded = list(matrix.get("degraded") or [])
    detected = {
        "available": ",".join(available) or "none",
        "degraded": ",".join(degraded) or "none",
    }
    if available:
        status = "probed"
        missing: list[str] = []
        fixes: list[str] = []
    elif degraded:
        status = "probed"
        missing = []
        fixes = ["Some capture kinds are degraded; `watch-skill capture-capabilities` says which."]
    else:
        status = "unavailable"
        missing = ["capture"]
        fixes = ["No capture kind is available on this machine; see `watch-skill capture-capabilities`."]
    return CapabilityTruth(
        capability_id=capability_id,
        provider="watch-skill",
        provider_version=core_version,
        status=status,  # type: ignore[arg-type]
        requirements=["a capture backend this platform supports"],
        detected=detected,
        missing=missing,
        fixes=fixes,
        last_checked_at=_now(),
    )


def _from_browser_capture(
    capability_id: str, matrix: dict[str, Any] | None, core_version: str
) -> CapabilityTruth:
    """Report the Playwright/Chromium path, never an unrelated JS runtime."""
    rows = [] if matrix is None else list(matrix.get("capabilities") or [])
    browser = next(
        (row for row in rows if isinstance(row, dict) and row.get("kind") == "browser"),
        None,
    )
    if browser is None:
        return CapabilityTruth(
            capability_id=capability_id,
            provider="watch-skill",
            provider_version=core_version,
            status="not_tested",
            requirements=["Playwright with a Chromium runtime"],
            detected={},
            missing=["browser capture probe"],
            fixes=["Run `watch-skill capture-capabilities` to probe the browser runtime."],
            last_checked_at=_now(),
        )
    status = str(browser.get("status") or "unavailable")
    if status == "available":
        truth = "probed"
        missing: list[str] = []
        fixes: list[str] = []
    elif status == "degraded":
        truth = "probed"
        missing = []
        fixes = [str(browser.get("repair") or "Inspect browser capture diagnostics.")]
    else:
        truth = "unavailable"
        missing = [str(browser.get("missing_system_api") or "Playwright Chromium")]
        fixes = [str(browser.get("repair") or "Install `watch-skill[loop]` and Chromium.")]
    return CapabilityTruth(
        capability_id=capability_id,
        provider="watch-skill",
        provider_version=core_version,
        status=truth,  # type: ignore[arg-type]
        requirements=["Playwright with a Chromium runtime"],
        detected={"browser": status, "backend": str(browser.get("backend") or "")},
        missing=missing,
        fixes=fixes,
        last_checked_at=_now(),
    )


def capability_report(core_version: str) -> list[CapabilityTruth]:
    """Establish every capability's truth from the running Core.

    Failures inside a probe are contained rather than raised: the handshake is
    the one call that must always succeed, because a Host that cannot connect
    cannot render the reason it could not.

    Args:
        core_version: reported as each capability's provider version, so the
            Host can attribute a capability to the engine that offered it.

    Returns:
        One entry per declared capability, in a stable order.
    """
    index: dict[str, tuple[str, str]] = {}
    try:
        from watch_skill.health.doctor import run_doctor

        # `fix=False` on purpose: a handshake must observe the machine, never
        # change it. Auto-remediation during connect would mean a Host restart
        # silently installs things.
        index = _doctor_index(run_doctor(fix=False))
    except Exception as exc:  # noqa: BLE001 - a probe must not break connect
        _log.warning("doctor probe failed during handshake: %s", type(exc).__name__)

    matrix: dict[str, Any] | None = None
    try:
        from watch_skill.live import capability_matrix

        matrix = capability_matrix()
    except Exception as exc:  # noqa: BLE001 - as above
        _log.warning("capture probe failed during handshake: %s", type(exc).__name__)

    report: list[CapabilityTruth] = []
    for capability_id, checks in sorted(_CAPABILITY_CHECKS.items()):
        if capability_id in _NOT_BRIDGED:
            reason, fix = _NOT_BRIDGED[capability_id]
            report.append(
                CapabilityTruth(
                    capability_id=capability_id,
                    provider="watch-skill",
                    provider_version=core_version,
                    status="unavailable",
                    requirements=["a Bridge surface for this capability"],
                    detected={},
                    missing=[reason],
                    fixes=[fix],
                    last_checked_at=_now(),
                )
            )
        elif capability_id in _BROWSER_CAPTURE_BACKED:
            report.append(_from_browser_capture(capability_id, matrix, core_version))
        elif capability_id in _CAPTURE_BACKED:
            report.append(_from_capture(capability_id, matrix, core_version))
        else:
            report.append(_from_doctor(capability_id, checks, index, core_version))
    return report


__all__ = ["capability_report"]
