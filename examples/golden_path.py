"""The golden path, live: proves the eyes actually see on THIS machine.

Runs the full product loop against real sources with a REAL vision model
(no mocks, no OCR-fallback critic):

  1. watch a YouTube URL, a TikTok URL, and a local file
     -> cheap-tier scene descriptions must land in the index
  2. ask_video -> retrieval answer whose cited frames actually exist
  3. THE LOOP on the broken checkout page with the real vision critic
     -> fail verdict -> fix -> pass verdict + before/after GIF
  4. Arabic: watch an Arabic video, ask an Arabic question, get Arabic hits

Requires a configured vision provider (any of: OpenRouter/Anthropic/OpenAI/
Gemini key, or a running Ollama with a vision model). Exits non-zero on the
first failed stage; prints a PASS table at the end.

Run:  uv run python "examples/golden_path.py" [--skip youtube,tiktok,...]
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "core"))

from agentvision.config import get_settings
from agentvision.errors import AgentVisionError, VisionError
from agentvision.index import ask_video, index_watch_result
from agentvision.index.db import connect
from agentvision.vision import get_vision
from agentvision.watch import watch

# Stable, short, public test sources.
YOUTUBE_URL = "https://www.youtube.com/watch?v=aqz-KE-bpKQ"  # Big Buck Bunny (CC-BY)
TIKTOK_URL = "https://www.tiktok.com/@scout2015/video/6718335390845095173"
ARABIC_URL = "https://www.youtube.com/watch?v=9ndH9Qo05F4"  # Arabic programming intro

RESULTS: list[tuple[str, str, float]] = []


def stage(name: str):
    """Decorator: time a stage, record PASS/FAIL, stop the run on failure."""
    def wrap(fn):
        def run(*args, **kwargs):
            t0 = time.time()
            print(f"\n=== {name} ===", flush=True)
            try:
                out = fn(*args, **kwargs)
            except Exception as exc:
                RESULTS.append((name, f"FAIL: {exc}", time.time() - t0))
                raise
            RESULTS.append((name, "PASS", time.time() - t0))
            return out
        return run
    return wrap


@stage("vision sanity (1 real call)")
def vision_sanity() -> None:
    frame_dir = Path(tempfile.mkdtemp(prefix="gp-vision-"))
    from PIL import Image

    p = frame_dir / "red.jpg"
    Image.new("RGB", (256, 144), color=(200, 20, 20)).save(p)
    model = get_vision("cheap")
    out = model.describe_frames([p])
    print(f"cheap tier ({model.client.provider}/{model.client.model}): {out[0]!r}")
    if not out[0]:
        raise VisionError("empty description from the cheap tier", code="vision.empty")


def _watch_and_index(source: str, label: str, **kwargs) -> str:
    result = watch(source, **kwargs)
    video_id = index_watch_result(result)
    conn = connect()
    try:
        described = conn.execute(
            "SELECT COUNT(*) AS n FROM scenes WHERE video_id = ? AND description IS NOT NULL",
            (video_id,),
        ).fetchone()["n"]
    finally:
        conn.close()
    frames = len(result.perception.frames) if result.perception else 0
    print(f"{label}: video_id={video_id} frames={frames} "
          f"transcript={result.transcript.source} scene_descriptions={described}")
    if described == 0:
        raise AgentVisionError(
            f"no scene descriptions written for {label} — cheap vision tier did not run",
            code="goldenpath.no_descriptions",
        )
    return video_id


@stage("watch: YouTube")
def watch_youtube() -> str:
    return _watch_and_index(YOUTUBE_URL, "youtube", max_frames=8, end_seconds=60.0)


@stage("watch: TikTok")
def watch_tiktok() -> str:
    return _watch_and_index(TIKTOK_URL, "tiktok", max_frames=6)


@stage("watch: local file")
def watch_local() -> str:
    # synthesize a clip so the stage is self-contained
    import subprocess

    from agentvision.health.binaries import require_binary

    clip = Path(tempfile.mkdtemp(prefix="gp-local-")) / "local clip.mp4"
    subprocess.run(
        [str(require_binary("ffmpeg")), "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", "testsrc2=s=480x270:d=8:r=30",
         "-f", "lavfi", "-i", "sine=f=440:d=8",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(clip)],
        check=True,
    )
    return _watch_and_index(str(clip), "local", max_frames=6)


@stage("ask_video with frame verification")
def ask_and_verify(video_id: str) -> None:
    answer = ask_video(video_id, "what is shown at the very beginning?")
    if not answer["hits"]:
        raise AgentVisionError("ask_video returned no hits", code="goldenpath.no_hits")
    for hit in answer["hits"][:3]:
        print(f"- [{hit['timestamp']}] ({hit['kind']}) {hit['text'][:80]}")
    missing = [f["frame_path"] for f in answer["frames"] if not Path(f["frame_path"]).is_file()]
    if missing:
        raise AgentVisionError(
            f"cited frames do not exist on disk: {missing}", code="goldenpath.bad_frames"
        )
    print(f"frames cited: {len(answer['frames'])} (all exist on disk)")


@stage("THE LOOP with the real vision critic")
def loop_real_critic() -> None:
    from agentvision.loop import loop_iterate, loop_start
    from agentvision.loop.reportfmt import format_loop_state

    demo = Path(__file__).parent / "loop_demo"
    page = Path(tempfile.mkdtemp(prefix="gp-loop-")) / "page.html"
    shutil.copy2(demo / "page_broken.html", page)
    criteria = (
        "The checkout page must show a real dollar total (a number like $29.00), "
        "never NaN, and the BUY NOW button label must be clearly readable."
    )
    state = loop_start(page.as_uri(), criteria, duration_seconds=5.0)  # REAL critic
    print(format_loop_state(state))
    if state.iterations[0]["critique"]["verdict"] != "fail":
        raise AgentVisionError(
            "real critic passed the broken page", code="goldenpath.critic_blind"
        )
    shutil.copy2(demo / "page_fixed.html", page)
    state = loop_iterate(state.loop_id)
    print(format_loop_state(state))
    if state.status != "passed":
        raise AgentVisionError(
            f"real critic did not pass the fixed page (status={state.status})",
            code="goldenpath.critic_strict",
        )
    gif = state.iterations[-1]["artifacts"]["gif"]
    print(f"proof gif: {gif}")
    dest = Path(__file__).resolve().parents[1] / "docs" / "assets" / "loop_before_after.gif"
    shutil.copy2(gif, dest)
    print(f"updated README hero: {dest}")


@stage("Arabic: watch + Arabic question")
def arabic_case() -> None:
    result = watch(ARABIC_URL, max_frames=8, end_seconds=90.0)
    video_id = index_watch_result(result)
    print(f"arabic video: id={video_id} transcript={result.transcript.source} "
          f"segments={len(result.transcript.segments)}")
    if not result.transcript:
        raise AgentVisionError("no Arabic transcript produced", code="goldenpath.no_transcript")
    sample = result.transcript.segments[0].text
    print(f"first segment: {sample!r}")
    answer = ask_video(video_id, "ما موضوع الفيديو؟")
    if not answer["hits"]:
        raise AgentVisionError("Arabic question got no hits", code="goldenpath.arabic_no_hits")
    print(f"arabic hits: {len(answer['hits'])}; top: {answer['hits'][0]['text'][:70]!r}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip", default="", help="comma list: youtube,tiktok,local,loop,arabic")
    args = parser.parse_args()
    skip = {s.strip() for s in args.skip.split(",") if s.strip()}

    settings = get_settings()
    print(f"cheap tier:  {settings.vision_cheap_provider}/{settings.vision_cheap_model}")
    print(f"strong tier: {settings.vision_strong_provider}/{settings.vision_strong_model}")

    failed = False
    try:
        vision_sanity()
        ask_target = None
        if "youtube" not in skip:
            ask_target = watch_youtube()
        if "tiktok" not in skip:
            watch_tiktok()
        if "local" not in skip:
            local_id = watch_local()
            ask_target = ask_target or local_id
        if ask_target:
            ask_and_verify(ask_target)
        if "loop" not in skip:
            loop_real_critic()
        if "arabic" not in skip:
            arabic_case()
    except Exception as exc:
        print(f"\nSTAGE FAILED: {exc}", file=sys.stderr)
        failed = True

    print("\n===== GOLDEN PATH SUMMARY =====")
    for name, status, seconds in RESULTS:
        print(f"{'PASS' if status == 'PASS' else 'FAIL':4}  {seconds:7.1f}s  {name}"
              + ("" if status == "PASS" else f"  <- {status[6:][:90]}"))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
