"""How many browsers this machine is allowed to be running at once.

A Chromium instance costs a few hundred megabytes and spawns a process tree.
Nothing in the live pipeline previously counted them, so the ceiling was
whatever the OS would tolerate — and on a machine already holding model
weights and ffmpeg buffers, that ceiling is reached as a ``MemoryError`` in
whatever unrelated code happens to allocate next. A test suite that dies in
the cost meter because a browser suite is running elsewhere has not found a
bug in the cost meter.

So browsers are leased. A lease is granted only if the machine can currently
afford one; otherwise the caller is told **no**, immediately and with a
reason, which is a far better outcome than an out-of-memory kill:

* a refusal names what is running and why the request was denied;
* an OOM names nothing, lands somewhere unrelated, and loses the session.

The registry is process-local by design. Cross-process coordination would need
a lock file and a liveness protocol, and getting that subtly wrong produces
deadlocks that are worse than the problem — so the limit is per process, and
the diagnostics say so rather than implying a machine-wide guarantee.
"""
from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass, field
from typing import Any

from watch_skill.errors import WatchSkillError

DEFAULT_MAX_BROWSERS = 2
"""Two. One is the common case — a live session — and the second is the
verifier opening its own browser to check that session's postcondition, which
is precisely the pair that must not deadlock against each other."""

MIN_AVAILABLE_MB = 700.0
"""Refuse a new browser below this much free memory. Chromium's own resident
set for a simple page runs 250-400 MB, and leaving no headroom means the
*next* allocation anywhere in the process is the one that fails."""


class BrowserUnavailable(WatchSkillError):
    """A browser was refused because the machine cannot currently afford one."""

    default_code = "live.browser.resource_limit"


@dataclass
class Lease:
    """One granted permission to run a browser, and who holds it."""

    lease_id: str
    owner: str
    granted_at: float = field(default_factory=time.time)
    released: bool = False

    @property
    def age_seconds(self) -> float:
        return time.time() - self.granted_at


def available_memory_mb() -> float | None:
    """Free physical memory, or None when it cannot be measured.

    None is returned honestly rather than guessed at. A pressure check that
    silently assumes plenty of memory when it cannot measure any is worse than
    no check, because it reports a safety property it never verified.
    """
    if hasattr(os, "sysconf"):  # POSIX
        try:
            pages = os.sysconf("SC_AVPHYS_PAGES")
            size = os.sysconf("SC_PAGE_SIZE")
            if pages > 0 and size > 0:
                return (pages * size) / (1024 * 1024)
        except (ValueError, OSError, AttributeError):
            pass
    try:  # Windows
        import ctypes  # noqa: PLC0415
        from ctypes import wintypes  # noqa: PLC0415

        class _MemoryStatusEx(ctypes.Structure):
            _fields_ = [
                ("dwLength", wintypes.DWORD),
                ("dwMemoryLoad", wintypes.DWORD),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        status = _MemoryStatusEx()
        status.dwLength = ctypes.sizeof(_MemoryStatusEx)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return status.ullAvailPhys / (1024 * 1024)
    except Exception:  # noqa: BLE001 - an unmeasurable machine says so
        return None
    return None


class BrowserPool:
    """The process's browser budget, and everything currently spending it."""

    def __init__(self, max_browsers: int | None = None,
                 min_available_mb: float | None = None) -> None:
        self._lock = threading.Lock()
        self._leases: dict[str, Lease] = {}
        self._counter = 0
        self._max = max_browsers
        self._min_mb = min_available_mb
        self.refusals = 0

    @property
    def max_browsers(self) -> int:
        if self._max is not None:
            return self._max
        raw = os.environ.get("WATCHSKILL_MAX_BROWSERS", "")
        try:
            return max(1, int(raw))
        except ValueError:
            return DEFAULT_MAX_BROWSERS

    @property
    def min_available_mb(self) -> float:
        if self._min_mb is not None:
            return self._min_mb
        raw = os.environ.get("WATCHSKILL_MIN_BROWSER_MEMORY_MB", "")
        try:
            return max(0.0, float(raw))
        except ValueError:
            return MIN_AVAILABLE_MB

    def acquire(self, owner: str, *, timeout: float = 60.0) -> Lease:
        """Wait for a slot, then check pressure. Refuse rather than OOM.

        The wait is for a *slot*, which another session will eventually give
        back. Memory pressure is checked after winning the slot and is not
        waited on: if the machine is short of memory right now, queueing more
        browsers behind that fact makes it worse, not better.
        """
        deadline = time.monotonic() + max(0.0, timeout)
        while True:
            with self._lock:
                if len(self._leases) < self.max_browsers:
                    self._reject_if_starved(owner)
                    self._counter += 1
                    lease = Lease(lease_id=f"lease_{self._counter}", owner=owner)
                    self._leases[lease.lease_id] = lease
                    return lease
                active = self._describe_locked()
            if time.monotonic() >= deadline:
                with self._lock:
                    self.refusals += 1
                raise BrowserUnavailable(
                    f"{len(active)} browser(s) are already running and the "
                    f"limit for this process is {self.max_browsers}",
                    code="live.browser.too_many",
                    fix="stop another live session first, or raise "
                        "WATCHSKILL_MAX_BROWSERS if this machine has the "
                        "memory for more",
                    details={"active": active, "limit": self.max_browsers,
                             "waited_seconds": round(timeout, 1)},
                )
            time.sleep(0.1)

    def _reject_if_starved(self, owner: str) -> None:
        """Refuse when memory is measurably short. Called holding the lock."""
        floor = self.min_available_mb
        if floor <= 0:
            return
        free = available_memory_mb()
        if free is None or free >= floor:
            return
        self.refusals += 1
        raise BrowserUnavailable(
            f"only {free:.0f} MB of memory is free and a browser needs at "
            f"least {floor:.0f} MB of headroom",
            code="live.browser.memory_pressure",
            fix="close something, or lower WATCHSKILL_MIN_BROWSER_MEMORY_MB "
                "if you accept the risk of the OS killing the process",
            details={"available_mb": round(free, 1), "required_mb": floor,
                     "owner": owner, "active": self._describe_locked()},
        )

    def release(self, lease: Lease | None) -> None:
        """Give a slot back. Safe to call twice, and on a lease that failed."""
        if lease is None or lease.released:
            return
        with self._lock:
            lease.released = True
            self._leases.pop(lease.lease_id, None)

    def _describe_locked(self) -> list[dict[str, Any]]:
        return [{"lease_id": lease.lease_id, "owner": lease.owner,
                 "age_seconds": round(lease.age_seconds, 1)}
                for lease in self._leases.values()]

    def diagnostics(self) -> dict[str, Any]:
        """What is running, what the limits are, and how much room is left."""
        with self._lock:
            active = self._describe_locked()
            refusals = self.refusals
        return {
            "schema_version": 1,
            "active": active,
            "active_count": len(active),
            "limit": self.max_browsers,
            "refusals": refusals,
            "available_memory_mb": (
                round(available_memory_mb(), 1)
                if available_memory_mb() is not None else None),
            "min_available_mb": self.min_available_mb,
            # Said plainly: this is a per-process budget, and two Python
            # processes each get their own. Implying otherwise would be a
            # safety claim nothing here enforces.
            "scope": "process",
        }

    def release_all(self) -> int:
        """Drop every lease. For teardown, where a leak must not persist."""
        with self._lock:
            count = len(self._leases)
            for lease in self._leases.values():
                lease.released = True
            self._leases.clear()
            return count


_pool = BrowserPool()


def get_pool() -> BrowserPool:
    return _pool


def acquire(owner: str, *, timeout: float = 60.0) -> Lease:
    return _pool.acquire(owner, timeout=timeout)


def release(lease: Lease | None) -> None:
    _pool.release(lease)


def diagnostics() -> dict[str, Any]:
    return _pool.diagnostics()


__all__ = [
    "DEFAULT_MAX_BROWSERS",
    "MIN_AVAILABLE_MB",
    "BrowserPool",
    "BrowserUnavailable",
    "Lease",
    "acquire",
    "available_memory_mb",
    "diagnostics",
    "get_pool",
    "release",
]
