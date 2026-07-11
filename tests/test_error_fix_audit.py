"""Pillar 5 — the structured-errors audit.

Two guarantees, enforced forever:
1. EVERY WatchSkillError raised anywhere in src carries a fix= argument —
   an error without remediation is a dead end for an agent.
2. The ten error paths users actually hit return fix text that is
   executable advice: a command, a setting, or a concrete action — not a
   shrug.
"""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src" / "watch_skill"
ERROR_NAMES = {
    "WatchSkillError", "DependencyError", "AcquisitionError", "PerceptionError",
    "TranscriptionError", "IndexError_", "VisionError", "LoopError", "ConfigError",
}


def _fixless_raises() -> list[str]:
    offenders = []
    for py in sorted(SRC.rglob("*.py")):
        tree = ast.parse(py.read_text(encoding="utf-8-sig"))
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Raise) and isinstance(node.exc, ast.Call)):
                continue
            func = node.exc.func
            name = func.id if isinstance(func, ast.Name) else (
                func.attr if isinstance(func, ast.Attribute) else ""
            )
            if name in ERROR_NAMES and not any(k.arg == "fix" for k in node.exc.keywords):
                offenders.append(f"{py.relative_to(SRC)}:{node.lineno}")
    return offenders


def test_every_raise_site_carries_a_fix() -> None:
    offenders = _fixless_raises()
    assert not offenders, (
        "raise sites without fix= (every structured error must say what to do):\n"
        + "\n".join(offenders)
    )


# ---- the top error paths return executable advice ---------------------------

def _actionable(fix: str) -> bool:
    """A fix is executable advice when it names a command, a setting, or a
    concrete artifact — anything an agent can act on without guessing."""
    markers = ("`", "WATCHSKILL_", "watch-skill", "watch_", "ollama",
               "playwright", "winget", "pip install", "uv sync", "re-run",
               "re-acquire", "re-download", "--", "http", "check the",
               "pass ", "set ", "use ")
    return any(marker in fix for marker in markers)


def test_top_error_paths_fix_text_is_executable(tmp_path: Path) -> None:
    from watch_skill.errors import (
        AcquisitionError,
        IndexError_,
        PerceptionError,
        TranscriptionError,
        VisionError,
    )
    from watch_skill.index.retrieval import ask_video
    from watch_skill.library import library_synthesize
    from watch_skill.perceive import ocr_backends
    from watch_skill.vision.client import VisionClient

    collected: dict[str, str] = {}

    # 1-2: unknown video (the most common agent mistake), empty library
    with pytest.raises(IndexError_) as e1:
        ask_video("never-indexed", "anything")
    collected[e1.value.code] = e1.value.fix
    with pytest.raises(IndexError_) as e2:
        library_synthesize("anything")
    collected[e2.value.code] = e2.value.fix

    # 3: no API key for a cloud provider
    with pytest.raises(VisionError) as e3:
        VisionClient(provider="anthropic", model="claude-sonnet-5")._api_key()
    collected[e3.value.code] = e3.value.fix

    # 4: unknown vision provider
    with pytest.raises(VisionError) as e4:
        VisionClient(provider="nonsense", model="x").generate("p", [])
    collected[e4.value.code] = e4.value.fix

    # 5-6: tesseract missing / its language data missing
    import shutil as _shutil

    real_which = _shutil.which
    _shutil.which = lambda _: None
    real_is_file = Path.is_file
    Path.is_file = lambda self: False  # type: ignore[method-assign]
    try:
        with pytest.raises(PerceptionError) as e5:
            ocr_backends.ocr_frame_tesseract(Path("f.png"), "lo")
        collected[e5.value.code] = e5.value.fix
    finally:
        _shutil.which = real_which
        Path.is_file = real_is_file  # type: ignore[method-assign]

    real_binary = ocr_backends._tesseract_binary
    real_langs = ocr_backends.tesseract_langs
    ocr_backends._tesseract_binary = lambda: "tesseract"
    ocr_backends.tesseract_langs = lambda binary=None: {"eng"}
    try:
        with pytest.raises(PerceptionError) as e6:
            ocr_backends.ocr_frame_tesseract(Path("f.png"), "km")
        collected[e6.value.code] = e6.value.fix
    finally:
        ocr_backends._tesseract_binary = real_binary
        ocr_backends.tesseract_langs = real_langs

    # 7: local vision server down, no binary
    from watch_skill.vision import local_health

    real_alive = local_health.ollama_alive
    real_bin = local_health._ollama_binary
    local_health.ollama_alive = lambda base, timeout=3.0: False
    local_health._ollama_binary = lambda: None
    try:
        with pytest.raises(VisionError) as e7:
            local_health.ensure_ollama("http://127.0.0.1:1")
        collected[e7.value.code] = e7.value.fix
    finally:
        local_health.ollama_alive = real_alive
        local_health._ollama_binary = real_bin
        local_health.forget_liveness()

    # 8: cloud STT privacy default
    from watch_skill.transcribe import cloud as cloud_mod

    with pytest.raises(TranscriptionError) as e8:
        cloud_mod.transcribe_cloud(tmp_path / "audio.wav", tmp_path)
    collected[e8.value.code] = e8.value.fix

    # 9: batch expanded to nothing
    from watch_skill.batch import watch_batch

    with pytest.raises(AcquisitionError) as e9:
        watch_batch([])
    collected[e9.value.code] = e9.value.fix

    # 10: local file not found
    from watch_skill.acquire.resolver import _resolve_local

    with pytest.raises(AcquisitionError) as e10:
        _resolve_local(r"Z:\nope\not a file.mp4")
    collected[e10.value.code] = e10.value.fix

    assert len(collected) >= 10, f"expected 10 distinct paths, got {sorted(collected)}"
    vague = {code: fix for code, fix in collected.items()
             if not fix or not _actionable(fix)}
    assert not vague, f"fix text is not executable advice: {vague}"
