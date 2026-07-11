"""Pillar 4 — OCR backend registry, gap routing, tesseract TSV parsing.

Offline: no engine downloads, no binaries. The routing table and the TSV
parser are pure logic; the live mixed-script and Lao-fallback proofs run
in benchmarks/perception (they need real models/binaries).
"""
from __future__ import annotations

import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from watch_skill.errors import PerceptionError
from watch_skill.perceive import ocr_backends
from watch_skill.perceive.ocr_backends import (
    OCR_BACKENDS,
    RAPIDOCR_GAP,
    ocr_frame_tesseract,
    resolve_backend,
)

# ---- registry + routing -----------------------------------------------------

def test_registry_grades_backends_honestly() -> None:
    assert OCR_BACKENDS["rapidocr"].auto_routable
    assert OCR_BACKENDS["tesseract"].auto_routable
    assert not OCR_BACKENDS["surya"].auto_routable, "surya is opt-in only"


@pytest.mark.parametrize("lang", ["lo", "km", "my", "bo"])
def test_auto_routes_gap_scripts_to_tesseract(lang: str) -> None:
    assert resolve_backend(lang) == "tesseract"


@pytest.mark.parametrize("lang", ["en", "ar", "zh", "th", "ru", None])
def test_auto_keeps_rapidocr_for_everything_it_reads(lang: str | None) -> None:
    assert resolve_backend(lang) == "rapidocr"


def test_explicit_setting_overrides_auto(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WATCHSKILL_OCR_BACKEND", "rapidocr")
    from watch_skill.config import reset_settings

    reset_settings()
    try:
        assert resolve_backend("lo") == "rapidocr", "explicit setting wins over the gap route"
    finally:
        monkeypatch.delenv("WATCHSKILL_OCR_BACKEND")
        reset_settings()


# ---- structured errors ------------------------------------------------------

def test_missing_binary_is_a_structured_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("shutil.which", lambda _: None)
    monkeypatch.setattr(Path, "is_file", lambda self: False)
    with pytest.raises(PerceptionError) as excinfo:
        ocr_frame_tesseract(Path("frame.png"), "lo")
    assert excinfo.value.code == "perceive.tesseract_missing"
    assert "winget install" in excinfo.value.fix


def test_missing_language_data_is_a_structured_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ocr_backends, "_tesseract_binary", lambda: "tesseract")
    monkeypatch.setattr(ocr_backends, "tesseract_langs", lambda binary=None: {"eng"})
    with pytest.raises(PerceptionError) as excinfo:
        ocr_frame_tesseract(Path("frame.png"), "km")
    assert excinfo.value.code == "perceive.tesseract_lang_missing"
    assert "khm.traineddata" in excinfo.value.fix


def test_surya_missing_is_a_structured_error() -> None:
    pytest.importorskip("PIL")
    try:
        import surya  # noqa: F401

        pytest.skip("surya installed — the error path does not apply")
    except ImportError:
        pass
    with pytest.raises(PerceptionError) as excinfo:
        ocr_backends.ocr_frame_surya(Path("frame.png"))
    assert excinfo.value.code == "perceive.surya_missing"


# ---- tesseract TSV parsing --------------------------------------------------

_TSV = (
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n"
    "5\t1\t1\t1\t1\t1\t10\t20\t50\t18\t91.5\tສະບາຍດີ\n"
    "5\t1\t1\t1\t1\t2\t65\t20\t40\t18\t88.0\tໂລກ\n"
    "5\t1\t1\t1\t2\t1\t10\t45\t80\t18\t30.0\tnoise\n"
)


def _fake_run(tsv: str):
    def run(cmd, **kwargs):
        if "--list-langs" in cmd:
            return SimpleNamespace(returncode=0, stdout="List of available languages:\nlao\neng\n", stderr="")
        return SimpleNamespace(returncode=0, stdout=tsv, stderr="")

    return run


def test_tsv_words_merge_into_line_blocks(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ocr_backends, "_tesseract_binary", lambda: "tesseract")
    monkeypatch.setattr(subprocess, "run", _fake_run(_TSV))
    blocks = ocr_frame_tesseract(Path("frame.png"), "lo", min_confidence=0.5)
    assert len(blocks) == 1, "low-confidence line filtered, one real line kept"
    assert blocks[0].text == "ສະບາຍດີ ໂລກ"
    assert blocks[0].confidence == pytest.approx(0.8975, abs=1e-3)
    x1, y1, x2, y2 = blocks[0].bbox
    assert (x1, y1, x2, y2) == (10.0, 20.0, 105.0, 38.0)


def test_gap_table_matches_iso_to_traineddata() -> None:
    assert RAPIDOCR_GAP == {"lo": "lao", "km": "khm", "my": "mya", "bo": "bod"}
