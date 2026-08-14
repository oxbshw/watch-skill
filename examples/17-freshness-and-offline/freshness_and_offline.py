"""Three guarantees, demonstrated end to end, with no network and no API calls.

    uv run --no-sync python examples/17-freshness-and-offline/freshness_and_offline.py

1. An overwritten local video produces a NEW revision rather than returning
   stale evidence, and the old analysis is kept rather than destroyed.
2. A fully offline watch with every cloud key populated makes zero outbound
   HTTP calls.
3. A critic with no usable evidence returns `inconclusive`, never a false pass.

Everything runs against clips this script generates with ffmpeg, in a
throwaway data dir. Nothing here touches your real index.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

WORK = Path(tempfile.mkdtemp(prefix="watch-skill-freshness-example-"))
os.environ["WATCHSKILL_DATA_DIR"] = str(WORK / "data")
# Hard offline for the whole script, with keys deliberately present: the point
# is that a configured key is not permission to use it.
os.environ["WATCHSKILL_OFFLINE"] = "1"
for name in ("ANTHROPIC", "OPENAI", "GEMINI", "GROQ", "OPENROUTER"):
    os.environ[f"WATCHSKILL_{name}_API_KEY"] = f"sk-example-{name.lower()}"

from watch_skill.index.store import (  # noqa: E402
    check_freshness,
    index_watch_result,
    source_revisions,
)
from watch_skill.watch import watch  # noqa: E402


def clip(path: Path, colour: str, seconds: float = 2.0) -> Path:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        sys.exit("ffmpeg is required for this example — run `watch-skill doctor`")
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [ffmpeg, "-y", "-f", "lavfi", "-i",
         f"color=c={colour}:s=320x240:d={seconds}:r=10",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)],
        check=True, capture_output=True,
    )
    return path


def rule(title: str) -> None:
    print(f"\n{'=' * 68}\n{title}\n{'=' * 68}")


def demo_overwritten_video() -> None:
    rule("1. Overwriting demo.mp4 creates a revision, not a stale answer")

    demo = clip(WORK / "demo.mp4", "red")
    first = index_watch_result(watch(str(demo), transcript_only=True))
    print(f"indexed the red clip      -> video_id {first}")
    print(f"freshness                 -> {check_freshness(str(demo))['state']}")

    shutil.copy2(clip(WORK / "replacement.mp4", "blue", seconds=3.0), demo)
    state = check_freshness(str(demo))
    print(f"\nsame path, different bytes-> {state['state']}  ({state['reason']})")

    from watch_skill.errors import StaleContentError
    from watch_skill.index.retrieval import ask_video

    try:
        ask_video(str(demo), "what is on screen?")
        print("!! answered from stale evidence — this is the bug")
    except StaleContentError as exc:
        print(f"asking by path            -> refused: {exc.code}")
        print(f"                             fix: {exc.fix}")

    second = index_watch_result(watch(str(demo), transcript_only=True))
    print(f"\nre-watched                -> video_id {second}")
    print(f"a new id?                 -> {second != first}")

    print("\nboth revisions are kept:")
    for entry in source_revisions(str(demo)):
        marker = "current" if entry["current"] else "superseded"
        print(f"  {entry['video_id']}  {marker:<11} {entry['revision_id']}")


def demo_offline() -> None:
    rule("2. Offline, with every cloud key set: zero outbound calls")

    import httpx

    calls: list[str] = []
    original = httpx.post

    def record(*args, **kwargs):  # noqa: ANN002, ANN003
        calls.append(str(kwargs.get("url") or (args[0] if args else "?")))
        return original(*args, **kwargs)

    httpx.post = record
    try:
        offline_clip = clip(WORK / "offline.mp4", "green")
        video_id = index_watch_result(
            watch(str(offline_clip), transcript_only=True), describe_scenes=True
        )
    finally:
        httpx.post = original

    from watch_skill.policy import execution_plan, get_policy

    print(f"keys configured           -> {len([k for k in os.environ if k.endswith('_API_KEY')])}")
    print(f"offline policy            -> {get_policy().offline}")
    print(f"indexed                   -> {video_id}")
    print(f"outbound POSTs            -> {len(calls)}  {calls or ''}")

    plan = execution_plan(phase="index.describe_scenes", provider="anthropic",
                          model="claude-haiku-4-5-20251001", frames=24)
    print(f"planned network actions   -> {plan['network_actions']}")

    from watch_skill.acquire import acquire
    from watch_skill.errors import AcquisitionError

    try:
        acquire("https://example.com/watch?v=abc")
    except AcquisitionError as exc:
        print(f"a remote URL offline      -> {exc.code}")


def demo_inconclusive() -> None:
    rule("3. A critic with nothing to look at says so")

    from watch_skill.loop.critic import describe_critique
    from watch_skill.perceive.types import PerceptionResult, VideoMetadata

    empty = PerceptionResult(
        source="capture.mp4",
        metadata=VideoMetadata(duration_seconds=8.0, width=1280, height=720,
                               fps=30.0, codec="h264", has_audio=False),
        frames=[],
    )
    verdict = describe_critique(empty, "the checkout total must be a real amount")
    print(f"verdict                   -> {verdict.verdict}")
    print(f"score                     -> {verdict.score}   (not 92)")
    print(f"assurance                 -> {verdict.assurance}")
    print(f"can it stop a loop?       -> {verdict.decisive}")
    for line in verdict.limitations:
        print(f"  not established: {line}")


def main() -> None:
    print(f"working in {WORK}")
    demo_overwritten_video()
    demo_offline()
    demo_inconclusive()
    print(f"\ndone. remove {WORK} when you are finished with it.")


if __name__ == "__main__":
    main()
