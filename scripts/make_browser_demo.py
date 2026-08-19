"""Record the browser runtime doing the thing that makes it worth having.

Not a successful click. A click that goes wrong, gets diagnosed, gets
recovered, and is then re-verified — followed by a save that the page reports
as successful and the runtime rejects because the request behind it failed.

That second half is the point. Any agent can be told a click worked. This
records one that checks.

Frames are screenshots taken inline; ffmpeg runs afterwards, once the browser
and the site have stopped, so nothing competes with capture while the scenario
is happening.

    python scripts/make_browser_demo.py --out build/browser-demo
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path,
                        default=REPO / "build" / "browser-demo")
    parser.add_argument("--fps", type=float, default=2.0)
    args = parser.parse_args()
    out = args.out.resolve()

    from watch_skill.health.binaries import require_binary
    from watch_skill.live.browser import BrowserOptions, BrowserSource
    from watch_skill.live.browser_policy import NavigationPolicy
    from watch_skill.operate import (
        Action,
        ActionKind,
        BrowserRuntime,
        Expectation,
        SideEffect,
        Target,
    )
    from watch_skill.operate.fixture_site import FixtureSite

    frames_dir = out / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    for stale in frames_dir.glob("*.png"):
        stale.unlink()

    manifest: dict = {"beats": [], "receipts": []}
    shots = {"n": 0}

    with FixtureSite() as site:
        options = BrowserOptions(
            url=f"{site.base_url}/", fps=2.0, adopt_popups=True,
            policy=NavigationPolicy(allow_loopback=True,
                                    allowed_hosts=frozenset({"127.0.0.1"})))
        source = BrowserSource(options, out / "capture", session_id="demo_op")
        source.start()
        runtime = BrowserRuntime(source)

        def shoot() -> None:
            path = frames_dir / f"f{shots['n'] + 1:05d}.png"
            try:
                source.call(lambda page: page.screenshot(path=str(path)),
                            timeout=15.0)
            except Exception:  # noqa: BLE001 - a dropped frame is fine
                return
            shots["n"] += 1

        def hold(seconds: float) -> None:
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                shoot()
                time.sleep(max(0.0, min(1.0 / args.fps,
                                        deadline - time.monotonic())))

        def beat(label: str) -> None:
            manifest["beats"].append({"label": label, "frame": shots["n"],
                                      "at": time.time()})
            print(f"  {label}", flush=True)

        def record(receipt) -> None:  # noqa: ANN001 - ActionReceipt
            manifest["receipts"].append(receipt.to_public())
            print(f"    -> {receipt.kind.value}: {receipt.verdict.value}"
                  + (f" ({receipt.failure.value})" if receipt.failure else "")
                  + (f" attempt {receipt.attempt}" if receipt.attempt > 1 else ""),
                  flush=True)

        try:
            # --- part one: something goes wrong, and is recovered -----------
            beat("open a page whose modal intercepts the click")
            record(runtime.act(Action(
                kind=ActionKind.NAVIGATE, url=f"{site.base_url}/overlay",
                intent="open the article page",
                expect=Expectation(text_present="Article"))))
            hold(3)

            beat("click 'Read more' — a subscribe modal is in the way")
            receipt = runtime.act(Action(
                kind=ActionKind.CLICK, intent="open the article",
                target=Target(role="button", name="Read more"),
                side_effect=SideEffect.REVERSIBLE, timeout_seconds=5.0,
                expect=Expectation(text_present="Article opened",
                                   max_wait_seconds=3.0)))
            record(receipt)
            manifest["recovery"] = {
                "attempts": receipt.attempt,
                "recovered_from": (receipt.recovered_from.value
                                   if receipt.recovered_from else None),
                "trail": [e for e in receipt.evidence if "recovery[" in e],
                "final_verdict": receipt.verdict.value,
            }
            beat(f"recovered: dismissed the overlay, retried, "
                 f"verified on attempt {receipt.attempt}")
            hold(4)

            # --- part two: the page lies, and is caught ---------------------
            beat("open a settings page that always reports success")
            record(runtime.act(Action(
                kind=ActionKind.NAVIGATE, url=f"{site.base_url}/false-success",
                intent="open settings",
                expect=Expectation(text_present="Settings"))))
            hold(3)

            beat("click Save — the page will paint 'Saved'")
            liar = runtime.act(Action(
                kind=ActionKind.CLICK, intent="save the display name",
                target=Target(role="button", name="Save"),
                side_effect=SideEffect.REVERSIBLE,
                expect=Expectation(text_present="Saved", network_ok=True,
                                   max_wait_seconds=4.0)))
            record(liar)
            manifest["false_success_rejected"] = {
                "page_said": "Saved",
                "verdict": liar.verdict.value,
                "reason": liar.reason,
                "network": [f"{r.method} {r.url} -> {r.status}"
                            for r in liar.effects.network if r.status >= 400],
                "server_save_attempts": site.state.save_attempts,
            }
            beat("REJECTED: the page said Saved, PATCH /api/save returned 500")
            hold(6)
        finally:
            runtime.close()
            source.stop()

    manifest["frames_captured"] = shots["n"]

    ffmpeg = str(require_binary("ffmpeg"))
    mp4 = out / "watch-skill-browser-demo.mp4"
    subprocess.run(
        [ffmpeg, "-y", "-loglevel", "error", "-framerate", str(args.fps),
         "-i", str(frames_dir / "f%05d.png"),
         "-vf", "scale=1152:-2", "-c:v", "libx264", "-pix_fmt", "yuv420p",
         "-crf", "30", "-movflags", "+faststart", str(mp4)],
        check=True, timeout=900)
    manifest["mp4"] = str(mp4)
    manifest["mp4_bytes"] = mp4.stat().st_size

    (out / "manifest.json").write_text(
        json.dumps(manifest, indent=2, default=str), encoding="utf-8")
    print()
    print(json.dumps({k: v for k, v in manifest.items() if k != "receipts"},
                     indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
