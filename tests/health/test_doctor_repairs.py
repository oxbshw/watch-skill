"""Pillar 5 — doctor --fix repairs every failure class this project has
actually hit: corrupt cached answers, truncated model files, vanished
frames dirs, dead local vision server. Each repair is simulated in the
isolated data dir and asserted, not narrated.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from watch_skill.config import get_settings
from watch_skill.health import doctor as doctor_mod
from watch_skill.health.doctor import (
    check_index_integrity,
    check_local_vision,
    check_memory_headroom,
    check_model_files,
)
from watch_skill.index.db import connect


def _seed_video(video_id: str = "vid1", frames_dir: str | None = None) -> None:
    conn = connect()
    try:
        with conn:
            conn.execute(
                "INSERT INTO videos (id, source, title, duration_seconds, frames_dir) "
                "VALUES (?, ?, ?, ?, ?)",
                (video_id, f"src-{video_id}", video_id, 10.0, frames_dir),
            )
    finally:
        conn.close()


# ---- corrupt cached answers --------------------------------------------------

def test_corrupt_answer_rows_are_quarantined() -> None:
    _seed_video()
    conn = connect()
    try:
        with conn:
            conn.execute(
                "INSERT INTO answers (video_id, question, question_norm, answer_json) "
                "VALUES ('vid1', 'q', 'q', '{not json at all')",
            )
            conn.execute(
                "INSERT INTO answers (video_id, question, question_norm, answer_json) "
                "VALUES ('vid1', 'q2', 'q2', '{\"ok\": true}')",
            )
    finally:
        conn.close()
    result = check_index_integrity(fix=True)
    assert result.status == "ok"
    assert "quarantined 1" in result.message
    conn = connect()
    try:
        remaining = conn.execute("SELECT COUNT(*) AS n FROM answers").fetchone()["n"]
    finally:
        conn.close()
    assert remaining == 1, "the healthy row must survive the quarantine"


def test_corrupt_rows_reported_not_touched_without_fix() -> None:
    _seed_video()
    conn = connect()
    try:
        with conn:
            conn.execute(
                "INSERT INTO answers (video_id, question, question_norm, answer_json) "
                "VALUES ('vid1', 'q', 'q', 'broken')",
            )
    finally:
        conn.close()
    result = check_index_integrity(fix=False)
    assert result.status == "warn"
    conn = connect()
    try:
        assert conn.execute("SELECT COUNT(*) AS n FROM answers").fetchone()["n"] == 1
    finally:
        conn.close()


# ---- vanished frames dir -------------------------------------------------------

def test_missing_frames_dir_yields_reindex_hint(tmp_path: Path) -> None:
    _seed_video("vid_gone", frames_dir=str(tmp_path / "never created"))
    result = check_index_integrity(fix=True)
    assert result.status == "warn"
    assert "re-run" in result.message and "watch_video" in result.message


# ---- truncated model files -----------------------------------------------------

def test_truncated_onnx_files_deleted_on_fix() -> None:
    models = get_settings().data_dir / "models" / "ocr"
    models.mkdir(parents=True)
    stub = models / "arabic_PP-OCRv4_rec_infer.onnx"
    stub.write_bytes(b"x")  # a killed download
    healthy = models / "healthy.onnx"
    healthy.write_bytes(b"y" * 4096)
    result = check_model_files(fix=True)
    assert result.fix_applied == "delete-truncated"
    assert not stub.exists()
    assert healthy.exists()


def test_truncated_onnx_reported_without_fix() -> None:
    models = get_settings().data_dir / "models"
    models.mkdir(parents=True)
    (models / "dead.onnx").write_bytes(b"")
    result = check_model_files(fix=False)
    assert result.status == "warn"
    assert (models / "dead.onnx").exists()


# ---- dead local vision ---------------------------------------------------------

def test_dead_ollama_restarted_by_fix(monkeypatch: pytest.MonkeyPatch) -> None:
    from watch_skill.vision import local_health

    monkeypatch.setattr(local_health, "_ollama_binary", lambda: "ollama")
    states = iter([False, True])
    monkeypatch.setattr(local_health, "ollama_alive", lambda base, timeout=3.0: next(states))
    launched = {"n": 0}
    monkeypatch.setattr(
        local_health, "restart_ollama_detached",
        lambda: launched.__setitem__("n", launched["n"] + 1) or True,
    )
    result = check_local_vision(fix=True)
    assert result.fix_applied == "restart-detached"
    assert launched["n"] == 1


def test_ollama_absent_is_ok_not_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    from watch_skill.vision import local_health

    monkeypatch.setattr(local_health, "_ollama_binary", lambda: None)
    result = check_local_vision(fix=True)
    assert result.status == "ok"
    assert "optional" in result.message


# ---- memory headroom -----------------------------------------------------------

def test_memory_check_recommends_a_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(doctor_mod, "_memory_status", lambda: (8.0, 2.5, 3.0))
    result = check_memory_headroom()
    assert result.status == "ok"
    assert "moondream" in result.message


def test_tight_commit_headroom_warns(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(doctor_mod, "_memory_status", lambda: (8.0, 1.2, 0.4))
    result = check_memory_headroom()
    assert result.status == "warn"
    assert "too tight" in result.message
