"""The model bootstrap: explicit, bounded, and willing to say no."""
from __future__ import annotations

import pytest

from watch_skill.models import bootstrap as bs


def test_nothing_downloads_on_import() -> None:
    """The property the whole design rests on.

    Installation, import, an ordinary watch and the test suite must never
    fetch weights. If they could, "offline" would be a claim nobody could
    verify.
    """
    assert not bs.is_available() or (bs.model_cache_dir() / "config.json").is_file()


def test_preflight_never_downloads(monkeypatch: pytest.MonkeyPatch) -> None:
    def explode(*_a, **_k):
        raise AssertionError("preflight attempted a download")

    monkeypatch.setattr("huggingface_hub.snapshot_download", explode, raising=False)
    bs.preflight()


def test_the_preflight_reports_this_machine_honestly() -> None:
    report = bs.preflight().to_dict()
    assert set(report["requirements"]) == {
        "min_free_disk_gib", "max_download_gib", "min_available_ram_gib"
    }
    assert report["model"] == bs.MODEL_ID
    assert report["license"] == "Apache-2.0"
    assert report["source"].startswith("https://huggingface.co/")
    if not report["ok"]:
        assert report["blockers"], "not ok, but no blocker named"


def test_insufficient_disk_refuses(monkeypatch: pytest.MonkeyPatch) -> None:
    """A half-downloaded model on a full disk is worse than no model."""
    monkeypatch.setattr(bs, "preflight", lambda: bs.Preflight(
        free_disk_bytes=1 * 1024**3, available_ram_bytes=16 * 1024**3,
        transformers_installed=True, torch_installed=True, already_present=False,
        blockers=["free disk 1.0 GiB is below the required 8 GiB"],
    ))
    with pytest.raises(bs.BootstrapRefused) as raised:
        bs.bootstrap()
    assert raised.value.code == "models.bootstrap_refused"
    assert "free disk" in str(raised.value)
    assert raised.value.fix


def test_an_oversized_download_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(bs, "preflight", lambda: bs.Preflight(
        free_disk_bytes=100 * 1024**3, available_ram_bytes=32 * 1024**3,
        transformers_installed=True, torch_installed=True, already_present=False,
    ))
    monkeypatch.setattr(bs, "estimate_download_bytes", lambda: 9 * 1024**3)
    with pytest.raises(bs.BootstrapRefused) as raised:
        bs.bootstrap()
    assert raised.value.code == "models.bootstrap_too_large"


def test_a_dry_run_downloads_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(bs, "preflight", lambda: bs.Preflight(
        free_disk_bytes=100 * 1024**3, available_ram_bytes=32 * 1024**3,
        transformers_installed=True, torch_installed=True, already_present=False,
    ))
    monkeypatch.setattr(bs, "estimate_download_bytes", lambda: 1 * 1024**3)

    def explode(*_a, **_k):
        raise AssertionError("a dry run downloaded something")

    monkeypatch.setattr("huggingface_hub.snapshot_download", explode, raising=False)
    assert bs.bootstrap(dry_run=True)["status"] == "dry_run"


def test_only_inference_files_are_requested() -> None:
    """Mirroring the repository would pull ONNX exports and demo assets."""
    assert "model.safetensors" in bs.REQUIRED_PATTERNS
    assert not any("*" == p for p in bs.REQUIRED_PATTERNS)
    assert not any(p.endswith(".onnx") for p in bs.REQUIRED_PATTERNS)


def test_the_cache_lives_in_the_project_data_dir() -> None:
    """So `watch-skill clean` can reclaim it and an operator can see it."""
    assert "models" in bs.model_cache_dir().parts
    assert bs.model_cache_dir().name == "vlm"


def test_the_revision_and_licence_are_recorded_constants() -> None:
    """A model result that cannot name its weights is not reproducible."""
    assert bs.MODEL_REVISION
    assert bs.MODEL_LICENSE
    assert bs.MODEL_ID.count("/") == 1


def test_unknown_ram_does_not_block(monkeypatch: pytest.MonkeyPatch) -> None:
    """Unknown is not the same as insufficient."""
    monkeypatch.setattr(bs, "available_ram_bytes", lambda: -1)
    report = bs.preflight()
    assert not any("RAM" in b for b in report.blockers)
    assert report.to_dict()["available_ram_gib"] is None
