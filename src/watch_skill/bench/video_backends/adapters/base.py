"""The benchmark-only adapter seam.

This is not a plugin framework and must not become one. It is the smallest
surface that lets one scorer grade more than one transport, and it lives
under `bench/` precisely so nothing in the product can start depending on it.
Watch Skill has no external video backend today; whether it should is the
question the benchmark answers, and answering it must not require shipping
the architecture first.

A production ``VideoBackend`` — if the evaluation ever justifies one — will
be a different type in a different place, designed against what was measured
rather than against what one vendor happened to expose.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from watch_skill.bench.video_backends.types import BackendDescription, Outcome


@runtime_checkable
class VideoBackendAdapter(Protocol):
    """What the benchmark needs from a backend, and nothing more."""

    name: str

    def describe(self) -> BackendDescription:
        """Identify what is actually being exercised, for the report header."""
        ...

    def submit(
        self,
        video: Path,
        *,
        output_dir: Path,
        timestamps: list[float] | None = None,
        **options: Any,
    ) -> Outcome:
        """Hand the backend a source. May return before work has finished."""
        ...

    def poll(self, handle: str) -> Outcome:
        """Ask what became of a submitted job."""
        ...

    def fetch_frames(self, handle: str, *, output_dir: Path) -> Outcome:
        """Retrieve frame evidence for a finished job."""
        ...

    def fetch_transcript(self, handle: str, *, output_dir: Path) -> Outcome:
        """Retrieve transcript evidence for a finished job."""
        ...
