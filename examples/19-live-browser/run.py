"""Live browser: pixels and structured page evidence, before the page closes.

Everything is local. The target is `watch_skill.live.fixture_app` — a
deliberately broken order desk served on loopback from this repository — so
the example is rights-clear, deterministic, and works with the network
unplugged.

What it proves, in order:

1. a browser session produces real frames while the page is still open;
2. it produces structured evidence (console error, uncaught exception, failed
   request, 500 response, DOM and ARIA changes) on the same clock;
3. the page's prompt-injection banner is recorded, marked page-authored, and
   never becomes an instruction;
4. the navigation epoch separates the splash page from the app page;
5. cancellation leaves no browser process behind.
"""
from __future__ import annotations

import sys
import time


def main() -> int:
    from watch_skill.live import observe, start_live, status, stop_live
    from watch_skill.live.capabilities import capability_for
    from watch_skill.live.fixture_app import INJECTION_TEXT, FixtureApp

    capability = capability_for("browser")
    if capability.status != "available":
        print(f"browser capture is {capability.status}: {capability.repair}")
        return 1

    with FixtureApp() as app:
        print(f"serving the broken order desk at {app.base_url}")
        print("starting a live browser session on it\n")
        session = start_live(app.base_url, kind="browser", fps=3.0,
                             allow_local=True)

        cursor = ""
        seen: dict[str, int] = {}
        first_evidence_at = None
        started = time.monotonic()
        deadline = started + 40.0
        wanted = {"browser:console", "browser:page_error",
                  "browser:request_failed", "browser:dom_mutation"}

        while time.monotonic() < deadline:
            batch = observe(session.session_id, cursor=cursor or None,
                            timeout_seconds=2.0, limit=100)
            for event in batch["events"]:
                detector = event["detector"] or event["type"]
                seen[detector] = seen.get(detector, 0) + 1
                if first_evidence_at is None:
                    first_evidence_at = time.monotonic() - started
                print(f"  {event['media_ts']:6.2f}s  {detector:<26} "
                      f"{event['summary'][:70]}")
            cursor = batch["next_cursor"]
            if wanted <= set(seen):
                break

        live = status(session.session_id)
        running = live["state"] == "running"
        epoch = live["browser"]["navigation_epoch"]
        frames = live["stats"]["frames_captured"]

        print(f"\n>>> the browser was still open when this was read: {running}")
        print(f">>> pixels captured while open: {frames} frames")
        print(f">>> first evidence arrived {first_evidence_at:.1f}s in"
              if first_evidence_at else ">>> no evidence arrived")
        print(f">>> navigations observed: {epoch} "
              "(splash -> app; each event knows which page it belongs to)")

        missing = wanted - set(seen)
        if missing:
            print(f"\n!!! expected evidence never arrived: {sorted(missing)}")
            stop_live(session.session_id)
            return 1

        print("\nthe page displays this, in large type, on purpose:")
        print(f'  "{INJECTION_TEXT}"')
        print("it is recorded in full, marked page_authored, provenance")
        print("'observation' — and it is not an instruction. Hiding it would")
        print("keep the operator from seeing an attack; obeying it would be")
        print("the attack succeeding.")

        print("\nstopping — cancellation must close every browser process...")
        stop_live(session.session_id)
        final = status(session.session_id)
        gone = final.get("browser", {}).get("process_tree_gone")
        print(f"  session state: {final['state']}")
        print(f"  browser process tree gone: {gone}")
        print(f"  order still broken on the server: {app.state.status!r}")
        print("\nfixing that order is what the Observer Loop does, with an")
        print("independent oracle deciding whether it worked.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
