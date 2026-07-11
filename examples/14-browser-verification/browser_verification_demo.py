"""The flagship pack, live: an agent-driven checkout flow with a bug no
screenshot can catch.

The page updates its total when checkout is clicked — and for about half
a second mid-update the total reads "$NaN" before the re-render fixes
it. A screenshot taken at the end shows a correct total; the RECORDING
shows the flaw. THE LOOP drives the flow (Playwright, same script every
iteration), watches the recording, fails iteration 0 on the transient
NaN, and — after the fix is applied to the page — passes iteration 1 and
renders the before/after proof.

watch-skill is not the browser agent here; it is the independent eye
that verifies one.

Run:  uv run --no-sync python examples/14-browser-verification/browser_verification_demo.py
"""
from __future__ import annotations

import http.server
import shutil
import sys
import tempfile
import threading
from pathlib import Path

sys.stdout.reconfigure(errors="replace")
WORK = Path(tempfile.mkdtemp(prefix="watch-skill browser demo "))
HERE = Path(__file__).resolve().parent

CRITERIA = (
    "after checkout is clicked, the order total always shows a real dollar "
    "amount (like $29.00) and never shows nan"
)
SCRIPT = [
    {"action": "click", "selector": "#checkout"},
    {"action": "wait", "seconds": 2.5},
]


def serve(directory: Path) -> tuple[http.server.ThreadingHTTPServer, str]:
    handler = lambda *a, **kw: http.server.SimpleHTTPRequestHandler(  # noqa: E731
        *a, directory=str(directory), **kw
    )
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/checkout.html"


def main() -> int:
    from watch_skill.loop import loop_iterate, loop_start

    shutil.copy2(HERE / "checkout_buggy.html", WORK / "checkout.html")
    server, url = serve(WORK)
    print(f"serving the BUGGY checkout at {url}")

    state = loop_start(url, CRITERIA, script=SCRIPT, duration_seconds=6.0)
    crit0 = state.iterations[-1]["critique"]
    print(f"\niteration 0: {crit0['verdict']} (score {crit0['score']})")
    for issue in crit0["issues"][:3]:
        print(f"  [{issue['timestamp']:.2f}s] {issue['severity']}: {issue['description'][:90]}")
    caught = crit0["verdict"] != "pass" and any(
        "nan" in issue["description"].lower() for issue in crit0["issues"]
    )
    print(f"  transient NaN caught by the recording: {caught}")

    print("\napplying the fix (the browser agent's job — here, one file swap)")
    shutil.copy2(HERE / "checkout_fixed.html", WORK / "checkout.html")

    state = loop_iterate(state.loop_id)
    latest = state.iterations[-1]
    crit1 = latest["critique"]
    print(f"iteration 1: {crit1['verdict']} (score {crit1['score']})")

    artifacts = latest.get("artifacts") or {}
    for kind, path in artifacts.items():
        print(f"  proof ({kind}): {path} ({Path(path).stat().st_size // 1024} KB)")

    server.shutdown()
    checks = [
        ("iteration 0 fails on the flow bug", crit0["verdict"] != "pass"),
        ("the NaN was named in the issues", caught),
        ("iteration 1 passes after the fix", crit1["verdict"] == "pass"),
        ("before/after proof rendered", bool(artifacts)),
    ]
    ok = True
    print()
    for label, passed in checks:
        print(f"  {'PASS' if passed else 'FAIL'}  {label}")
        ok = ok and passed
    print("\nBROWSER VERIFICATION DEMO:", "PASSED" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
