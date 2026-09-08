"""Fail when a test skipped for a reason nobody signed off on.

A skip reads as a pass. The suite was green while a whole module of
video-backend tests ran nowhere, because its fixtures are generated and CI
never generated them — and nothing said so, because `-q` prints one `s` and
moves on.

So CI now runs with `-rs`, and this reads the report it produces. Every skip
must match one of the reasons below. Anything else fails the job, which is the
only way a newly-skipped test becomes visible instead of becoming normal.

    uv run pytest -q -m "not network" -rs | tee report.txt
    uv run python scripts/check_skips.py report.txt

The allowed set is deliberately small, and each entry says what would have to
be true to remove it.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

# Reasons a skip is legitimate on a hermetic runner, matched as substrings of
# pytest's own reported reason.
ALLOWED: dict[str, str] = {
    # Platform gates. Each of these runs on the other half of the matrix, so
    # nothing here goes untested anywhere -- it is tested where it applies.
    "POSIX permission bits":
        "runs on the Linux and macOS cells",
    "Windows-only":
        "runs on the Windows cells",
    "requires Windows":
        "runs on the Windows cells",

    # Real-model gates that need weights, a server, or an accuracy this runner
    # cannot be held to. Opening the ASR one was tried and reverted: with the
    # weights cached and nothing else running, the recognition test still
    # produced no speech events on the reference machine, so enabling it would
    # trade a documented skip for a red build that says nothing about the
    # change under test. It stays gated, and `docs/testing.md` says how to run
    # it on a box that can.
    "real-model ASR gate":
        "run it locally with WATCHSKILL_TEST_REAL_ASR=1 - see docs/testing.md",
    "faster-whisper-tiny is not cached":
        "run it locally once with network access - see docs/testing.md",
    "real-model live VLM gate":
        "needs an interpreter with torch and a local VLM; run it on a box that has one",
    "real-model VLM gate":
        "needs a local Ollama vision model",
    "no vision model reachable":
        "needs a local Ollama vision model",
    "real-model rendered gate":
        "needs an interpreter with torch and a local VLM",
    "real local-ASR recognition":
        "same weights and the same gate as the ASR suite above",

    # A resource gate that states its own threshold. It is a refusal to thrash
    # a small runner, not a way of not running.
    "governed browsers and needs about":
        "the runner did not have the free memory the scenario states it needs",
}


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        sys.stderr.write("usage: check_skips.py <pytest -rs report>\n")
        return 2

    report = Path(argv[1]).read_text(encoding="utf-8", errors="replace")
    skipped = re.findall(r"^SKIPPED \[\d+\] (.+)$", report, flags=re.MULTILINE)

    unexpected: list[str] = []
    for line in skipped:
        if not any(reason in line for reason in ALLOWED):
            unexpected.append(line.strip())

    counted: dict[str, int] = {}
    for line in skipped:
        for reason in ALLOWED:
            if reason in line:
                counted[reason] = counted.get(reason, 0) + 1
                break

    print(f"skips reported: {len(skipped)}")
    for reason, count in sorted(counted.items()):
        print(f"  {count:>3}  {reason} -- {ALLOWED[reason]}")

    if unexpected:
        print()
        print(f"{len(unexpected)} skip(s) nobody accounted for:")
        for line in unexpected:
            print(f"  {line}")
        print()
        print("A skip reads as a pass. Either make the test run on this runner,")
        print("or add the reason to ALLOWED in scripts/check_skips.py with a")
        print("sentence saying where it does run.")
        return 1

    print("\nevery skip is one of the accounted-for gates")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
