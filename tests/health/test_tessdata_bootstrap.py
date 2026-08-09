"""Tesseract language files fetch themselves; the binary is still yours.

The perception benchmark reads Lao at 0% with RapidOCR and tesseract is the
documented fallback, but the pipeline used to stop there and tell the reader
to go and download a `.traineddata` by hand — the only dependency in the
project handled that way.

The split is deliberate. Language files are data and can be fetched on any
platform, and they are the half that is usually missing: `apt install
tesseract-ocr` ships English and leaves Lao, Khmer, and Myanmar in separate
packages. The binary itself needs a package manager off Windows, so that
stays a warning with the exact command rather than a silent failure.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from watch_skill.errors import DependencyError
from watch_skill.health import binaries


@pytest.fixture()
def data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    from watch_skill import config

    monkeypatch.setenv("WATCHSKILL_DATA_DIR", str(tmp_path / "data"))
    config.reset_settings()
    return tmp_path


def test_a_language_file_lands_in_the_managed_dir(data_dir, monkeypatch) -> None:
    def fake_download(url: str, dest: Path, timeout: float = 600.0) -> Path:
        assert url.endswith("lao.traineddata"), url
        dest.write_bytes(b"fake model data")
        return dest

    monkeypatch.setattr(binaries, "_download_file", fake_download)
    path = binaries.bootstrap_traineddata("lao")
    assert path.is_file()
    assert path.name == "lao.traineddata"
    assert path.parent == binaries.tessdata_dir()


def test_an_existing_file_is_not_downloaded_again(data_dir, monkeypatch) -> None:
    """Re-reading a Lao video must not re-fetch a 6 MB model."""
    calls = {"n": 0}

    def fake_download(url: str, dest: Path, timeout: float = 600.0) -> Path:
        calls["n"] += 1
        dest.write_bytes(b"fake model data")
        return dest

    monkeypatch.setattr(binaries, "_download_file", fake_download)
    binaries.bootstrap_traineddata("khm")
    binaries.bootstrap_traineddata("khm")
    assert calls["n"] == 1


def test_an_empty_download_is_an_error_not_a_broken_model(data_dir, monkeypatch) -> None:
    """A zero-byte traineddata would make tesseract fail obscurely later."""
    def fake_download(url: str, dest: Path, timeout: float = 600.0) -> Path:
        dest.write_bytes(b"")
        return dest

    monkeypatch.setattr(binaries, "_download_file", fake_download)
    with pytest.raises(DependencyError) as exc:
        binaries.bootstrap_traineddata("lao")
    assert exc.value.code == "health.bootstrap_failed"
    assert not (binaries.tessdata_dir() / "lao.traineddata").exists(), "empty file left behind"


def test_doctor_warns_rather_than_fails_without_tesseract(data_dir, monkeypatch) -> None:
    """These scripts are a minority of videos; everything else still works."""
    from watch_skill.health.doctor import check_ocr_gap_scripts
    from watch_skill.perceive import ocr_backends

    def no_binary() -> str:
        raise RuntimeError("not installed")

    monkeypatch.setattr(ocr_backends, "_tesseract_binary", no_binary)
    result = check_ocr_gap_scripts(fix=False)
    assert result.status == "warn"
    assert "lo" in result.message  # names the scripts that go silent
    assert "install" in result.message.lower()  # and how to fix it


def test_doctor_reports_ok_when_tesseract_is_present(data_dir, monkeypatch) -> None:
    from watch_skill.health.doctor import check_ocr_gap_scripts
    from watch_skill.perceive import ocr_backends

    monkeypatch.setattr(ocr_backends, "_tesseract_binary", lambda: "/usr/bin/tesseract")
    result = check_ocr_gap_scripts(fix=False)
    assert result.status == "ok"
    assert "fetch on demand" in result.message


def test_the_gap_list_is_what_the_benchmark_measured() -> None:
    """The 0% row in benchmarks/perception is these scripts, not a guess."""
    from watch_skill.perceive.ocr_backends import RAPIDOCR_GAP

    assert {"lo", "km", "my"} <= set(RAPIDOCR_GAP)
    for code, traineddata in RAPIDOCR_GAP.items():
        assert traineddata.isalpha() and len(traineddata) >= 3, (code, traineddata)
