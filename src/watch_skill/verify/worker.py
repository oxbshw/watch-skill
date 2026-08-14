"""The verifier child process. Reads a job on stdin, writes results on stdout.

Run as ``python -m watch_skill.verify.worker``. Kept tiny and importing almost
nothing on purpose: this is the process that executes contract checks, and the
less it carries the smaller the blast radius when one of them misbehaves.
"""
from __future__ import annotations

import json
import sys


def main() -> int:
    raw = sys.stdin.read()
    try:
        job = json.loads(raw)
    except json.JSONDecodeError as exc:
        json.dump({"error": f"malformed job: {exc}"}, sys.stdout)
        return 2

    from watch_skill.verify.checks import CheckContext, run_check
    from watch_skill.verify.contract import Check

    ctx = CheckContext.model_validate(job["context"])
    results = [
        run_check(Check.model_validate(payload), ctx).model_dump(mode="json")
        for payload in job["checks"]
    ]
    # A bare marker so the parent can tell "the worker finished and these are
    # the results" from "the worker died and this is whatever it had printed".
    json.dump({"ok": True, "results": results}, sys.stdout)
    sys.stdout.flush()
    return 0


if __name__ == "__main__":  # pragma: no cover - exercised as a subprocess
    raise SystemExit(main())
