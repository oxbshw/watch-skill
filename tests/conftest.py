"""Shared fixtures: every test runs against an isolated data dir WITH SPACES
in its path (both this repo and the reference live in space-containing
directories — treating that as a permanent test case)."""
from __future__ import annotations

from pathlib import Path

import pytest

from watch_skill.config import reset_settings

_AMBIENT_KEYS = (
    "WATCHSKILL_ANTHROPIC_API_KEY",
    "WATCHSKILL_OPENAI_API_KEY",
    "WATCHSKILL_GEMINI_API_KEY",
    "WATCHSKILL_GROQ_API_KEY",
    "WATCHSKILL_OPENROUTER_API_KEY",
    "WATCHSKILL_BIN_DIR",
    "WATCHSKILL_DATA_DIR",
)


@pytest.fixture(autouse=True)
def isolated_settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point Watch Skill at a throwaway data dir (with spaces) for every test."""
    for var in _AMBIENT_KEYS:
        monkeypatch.delenv(var, raising=False)
    data_dir = tmp_path / "agent vision data"
    monkeypatch.setenv("WATCHSKILL_DATA_DIR", str(data_dir))
    # Tests must NEVER reach a live vision backend, and must not inherit a
    # developer's .env vision tuning: `watch-skill setup-vision` writes the
    # chosen model + batch size + num_ctx into the repo .env, which pydantic
    # reads from CWD and would otherwise leak into tests (a moondream .env set
    # WATCHSKILL_VISION_BATCH_SIZE=1 and broke the numbered-describe test).
    # env vars win over .env, so pin every vision knob back to its default.
    monkeypatch.setenv("WATCHSKILL_VISION_CHEAP_PROVIDER", "anthropic")
    monkeypatch.setenv("WATCHSKILL_VISION_STRONG_PROVIDER", "anthropic")
    monkeypatch.setenv("WATCHSKILL_VISION_CHEAP_MODEL", "claude-haiku-4-5-20251001")
    monkeypatch.setenv("WATCHSKILL_VISION_STRONG_MODEL", "claude-sonnet-5")
    monkeypatch.setenv("WATCHSKILL_VISION_BATCH_SIZE", "8")
    monkeypatch.setenv("WATCHSKILL_OLLAMA_NUM_CTX", "2048")
    monkeypatch.setenv("WATCHSKILL_OLLAMA_BASE_URL", "http://127.0.0.1:11434")
    reset_settings()
    _reset_process_globals()
    yield data_dir
    reset_settings()
    _reset_process_globals()


def require_verification_browser(count: int = 2,
                                 scenario_mb: float = 900.0) -> None:
    """Skip, with arithmetic, when this machine cannot hold the browsers.

    Any scenario that drives the Observer Loop over a live browser source
    holds two governed browsers at once: the live source for the whole run,
    and the verifier during `advance()`. The governor charges each
    `session_cost_mb` and insists `min_available_mb` survives, so near that
    line the *second* acquisition is decided by whatever else the machine is
    doing.

    That produced what looked like a flaky UI test for a season. It was never
    a UI problem: the same refusal failed `tests/observer/test_observer_loop`
    in the same run, and the product said so plainly — "the verifier was
    unavailable 2 times in a row: 962 MB is free; this session needs about
    570 MB and 700 MB must remain for everything else". The governor was
    right; the precondition was simply never checked.

    Checked here, before anything starts. A skip that names the shortfall can
    be acted on; an assertion that fires mid-scenario for want of a few
    megabytes cannot.
    """
    import pytest  # noqa: PLC0415

    from watch_skill.live.browser_pool import (  # noqa: PLC0415
        available_memory_mb,
        get_pool,
    )

    # Drop caches that are safe to drop *before* measuring, so the decision is
    # made against the memory this scenario can really have.
    #
    # These are not released after every test on purpose. RapidOCR takes tens
    # of seconds to build, and clearing it per test made a live session rebuild
    # it mid-run -- which starved the real-VLM gate badly enough that eight
    # selected keyframes produced zero completed inferences in 150 seconds.
    # The engines are shared deliberately; what they must not do is silently
    # consume the headroom a browser is about to be admitted against.
    try:
        from watch_skill.index.embeddings import release_models  # noqa: PLC0415
        from watch_skill.perceive.ocr import release_engines  # noqa: PLC0415

        release_engines()
        release_models()
    except Exception:  # noqa: BLE001 - best effort, never fatal
        pass

    pool = get_pool()
    free = available_memory_mb()
    if free is None:
        return  # the unmeasured path has its own, stricter ceiling
    resident = pool._worker_cost_locked()

    # The governor's own requirement, at the moment the *last* verifier is
    # acquired -- which is near the end of the run, not the start.
    at_acquisition = pool.session_cost_mb + pool.min_available_mb + resident

    # What the scenario has already eaten by then, supplied by the caller
    # because the two scenarios that need this do not cost the same thing.
    #
    # Measured after the OCR, embedding and runner leaks were fixed: a live
    # browser source with OCR at steady state costs 196 MB and peaks at 477 MB,
    # and all of it comes back at teardown. The Observer loop scenario runs
    # that plus a verifier browser and passes with 900 MB allowed. The rendered
    # UI proof additionally runs a Playwright driver browser and the dev host,
    # and was measured consuming ~1233 MB before its second verification.
    #
    # A single shared constant of 1340 MB used to cover both. It was measured
    # on the UI scenario while those leaks were still inflating it, and applying
    # it to the Observer scenario skipped a test this machine can run
    # comfortably. One number could not be right for both.
    scenario_peak_mb = scenario_mb if count > 1 else 0.0

    needed = at_acquisition + scenario_peak_mb
    if free < needed:
        pytest.skip(
            f"this scenario holds {count} governed browsers and needs about "
            f"{needed:.0f} MB free at the start "
            f"({scenario_peak_mb:.0f} MB the run itself consumes before the "
            f"last verifier is acquired, {pool.session_cost_mb:.0f} MB for "
            f"that browser, {pool.min_available_mb:.0f} MB reserve, "
            f"{resident:.0f} MB resident in loaded models); "
            f"{free:.0f} MB is free. Close other applications or raise "
            f"WATCHSKILL_MIN_BROWSER_MEMORY_MB. "
            f"This is a resource skip, not a pass.")


def _reset_process_globals() -> None:
    """Drop model and browser state that outlives a single test.

    Model residency is deliberately process-global — that is what makes
    loading single-flight across every caller — so without this a model one
    test loads is still resident for every test after it.

    That is not a tidiness point. The browser governor charges admission for
    resident models: with an empty registry a session needs 1150 MB free, and
    with the 500 MB ASR model still loaded it needs 1650 MB. On a machine
    sitting at ~1630 MB free, those two arithmetic results differ, and the
    second one refuses the Observer's verification browser. That is the whole
    mechanism behind an "intermittent" UI failure that only ever appeared when
    a real-ASR test had run earlier in the same process — the governor was
    right, the test process was dirty.

    Leases are released for the same reason: a leaked lease is a slot the next
    test cannot have.
    """
    try:
        from watch_skill.models.lifecycle import (  # noqa: PLC0415
            lifecycle_reset_for_tests,
        )

        lifecycle_reset_for_tests()
    except Exception:  # noqa: BLE001 - cleanup must never fail a test
        pass
    try:
        from watch_skill.live.browser_pool import get_pool  # noqa: PLC0415

        get_pool().release_all()
    except Exception:  # noqa: BLE001
        pass
    try:
        # Live runners own browsers and ffmpeg processes. A runner that
        # outlives its test keeps both, and the next test inherits a machine
        # with less of everything.
        from watch_skill.live.session import stop_all  # noqa: PLC0415

        stop_all()
    except Exception:  # noqa: BLE001
        pass


@pytest.fixture(scope="session")
def sample_video(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """A synthesized 12 s clip with 3 distinct scenes and a 440 Hz tone.

    Generated by ffmpeg lavfi — no copyrighted media in the repo, no network.
    Lives in a directory with spaces (permanent path-handling test case).
    """
    import shutil
    import subprocess

    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        pytest.skip("ffmpeg not available")
    out_dir = tmp_path_factory.mktemp("sample media dir")
    dest = out_dir / "sample clip.mp4"
    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=c=red:s=320x240:d=4:r=30",
        "-f", "lavfi", "-i", "smptebars=s=320x240:d=4:r=30",
        "-f", "lavfi", "-i", "testsrc2=s=320x240:d=4:r=30",
        "-f", "lavfi", "-i", "sine=f=440:d=12",
        "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1[v]",
        "-map", "[v]", "-map", "3:a",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
        str(dest),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        pytest.skip(f"could not synthesize sample clip: {result.stderr[-300:]}")
    return dest
