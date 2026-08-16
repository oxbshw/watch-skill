"""Whether this machine can establish a real verification boundary.

``isolated_local`` — a sanitized child process — is the strongest level Watch
Skill can reach without new authority, and it is genuinely useful: the checks
cannot read the parent's keys, corrupt its state, or outrun their deadline.

It is not independence. A child process runs as the same user as the agent
that did the work, which means that agent can still write the target, the
evidence, and the receipt store between runs. Describing that as "external"
would be the single most misleading thing this codebase could say, because
every downstream reader would take it to mean the acting side was locked out.

``external_read_only`` requires an actual boundary: a container with a
read-only mount, or a distinct OS identity. This module's whole job is to
determine, honestly, whether one is available — and to refuse the label when
it is not, rather than approximating it.
"""
from __future__ import annotations

import os
import platform
import shutil
import subprocess
from dataclasses import dataclass
from typing import Any

from watch_skill.verify.contract import ASSURANCE_SEMANTICS, Assurance

PROBE_TIMEOUT = 20.0


@dataclass(frozen=True)
class IsolationCapability:
    """What boundary is available here, and why nothing stronger is."""

    level: Assurance
    mechanism: str
    available: bool
    reason: str
    remedy: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "level": self.level.value,
            "mechanism": self.mechanism,
            "available": self.available,
            "reason": self.reason,
            "remedy": self.remedy,
        }


def _container_runtime() -> tuple[str, str] | None:
    """A usable container runtime, or None.

    Presence on PATH is not enough — a Docker CLI with no reachable daemon is
    the common case on a developer machine, and reporting it as an available
    boundary would mean every contract requiring one failed at run time
    instead of at the honest refusal here.
    """
    for name in ("docker", "podman"):
        binary = shutil.which(name)
        if binary is None:
            continue
        try:
            result = subprocess.run(
                [binary, "info", "--format", "{{.ServerVersion}}"],
                capture_output=True, text=True, timeout=PROBE_TIMEOUT)
        except (OSError, subprocess.SubprocessError):
            continue
        if result.returncode == 0:
            return name, (result.stdout or "").strip() or "unknown"
    return None


def external_isolation() -> IsolationCapability:
    """Probe for a real external boundary. Honest about not finding one."""
    runtime = _container_runtime()
    if runtime is not None:
        name, version = runtime
        return IsolationCapability(
            level=Assurance.EXTERNAL_READ_ONLY,
            mechanism=f"{name} {version} with a read-only mount",
            available=True,
            reason=f"{name} is installed and its daemon is reachable",
        )

    system = platform.system()
    if system == "Windows":
        remedy = ("install Docker Desktop and start it, or run the verifier "
                  "on a machine that has a container runtime")
        reason = ("no container runtime is reachable, and creating a separate "
                  "Windows identity needs administrator authority this "
                  "process does not have and will not request")
    else:
        remedy = ("install docker or podman, or run the verifier as a "
                  "dedicated read-only user")
        reason = ("no container runtime is reachable, and no dedicated "
                  f"verifier identity is configured (running as uid "
                  f"{getattr(os, 'getuid', lambda: 'unknown')()})")

    return IsolationCapability(
        level=Assurance.ISOLATED_LOCAL,
        mechanism="sanitized child process",
        available=False,
        reason=reason,
        remedy=remedy,
    )


def best_available(isolated: bool = True) -> Assurance:
    """The strongest level this machine can actually establish right now.

    Never optimistic. A caller that wants more than this gets a refusal
    naming the missing mechanism, which is a better outcome than a verdict
    labelled with a level nothing enforced.
    """
    if not isolated:
        return Assurance.DETERMINISTIC_LOCAL
    capability = external_isolation()
    return (Assurance.EXTERNAL_READ_ONLY if capability.available
            else Assurance.ISOLATED_LOCAL)


def describe() -> dict[str, Any]:
    """The assurance ladder and where this machine sits on it."""
    capability = external_isolation()
    return {
        "schema_version": 1,
        "best_available": best_available().value,
        "external": capability.to_dict(),
        "levels": [
            {"level": level.value, **ASSURANCE_SEMANTICS[level]}
            for level in Assurance
        ],
    }


__all__ = [
    "IsolationCapability",
    "PROBE_TIMEOUT",
    "best_available",
    "describe",
    "external_isolation",
]
