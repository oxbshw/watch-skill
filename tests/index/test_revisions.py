"""Content revisioning: the same path pointing at different bytes.

Every test here fails against the pre-v9 code, where a video's identity was
``sha256(source_string)`` and overwriting a file silently reused yesterday's
frames, OCR and cached answers.
"""
from __future__ import annotations

import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from watch_skill.identity import (
    Fingerprint,
    Freshness,
    RevalidationPolicy,
    alias_id,
    digest_file,
    freshness_for,
    legacy_video_id_for,
    local_fingerprint,
    normalize_alias,
    video_id_for_digest,
)
from watch_skill.index.db import connect
from watch_skill.index.revisions import (
    bind_alias,
    claim_video_row,
    record_revision,
    register_video_alias,
    resolve_alias,
    resolve_video_id,
    revisions_for_alias,
)
from watch_skill.index.store import (
    check_freshness,
    get_video,
    index_watch_result,
    source_revisions,
)
from watch_skill.watch import watch


def _clip(path: Path, colour: str, seconds: float = 2.0) -> Path:
    """A tiny solid-colour clip — distinct bytes, no network, no fixtures."""
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        pytest.skip("ffmpeg not available")
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [ffmpeg, "-y", "-f", "lavfi", "-i",
         f"color=c={colour}:s=320x240:d={seconds}:r=10",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)],
        check=True, capture_output=True,
    )
    return path


# --- identity primitives ----------------------------------------------------


def test_alias_normalization_collapses_volatile_url_parts() -> None:
    base = "https://example.com/watch?v=abc"
    assert normalize_alias(base + "&t=42") == normalize_alias(base)
    assert normalize_alias(base + "#frag") == normalize_alias(base)
    assert normalize_alias(base) != normalize_alias("https://example.com/watch?v=xyz")


def test_alias_id_is_stable_and_source_specific() -> None:
    assert alias_id("https://x.com/v") == alias_id("https://x.com/v ")
    assert alias_id("https://x.com/v") != alias_id("https://x.com/w")


def test_video_id_follows_content_not_the_string() -> None:
    assert video_id_for_digest("a" * 64) != video_id_for_digest("b" * 64)
    assert video_id_for_digest("a" * 64) == video_id_for_digest("a" * 64)
    assert len(video_id_for_digest("a" * 64)) == 16


def test_freshness_never_certifies_on_an_empty_fingerprint() -> None:
    """A fingerprint that knows nothing must not certify a match."""
    empty = Fingerprint(kind="remote", data={})
    assert freshness_for(
        observed=empty, stored=empty,
        policy=RevalidationPolicy.REVALIDATE, checked_at=None,
    ) is Freshness.UNKNOWN


def test_freshness_unknown_when_the_source_cannot_be_checked() -> None:
    assert freshness_for(
        observed=None, stored=Fingerprint(kind="local", data={"size": 1}),
        policy=RevalidationPolicy.REVALIDATE, checked_at=None,
    ) is Freshness.UNKNOWN


def test_forced_refresh_overrides_a_matching_fingerprint(tmp_path: Path) -> None:
    print_ = Fingerprint(kind="local", data={"size": 10, "mtime_ns": 1})
    assert freshness_for(
        observed=print_, stored=print_,
        policy=RevalidationPolicy.REFRESH, checked_at=None,
    ) is Freshness.REFRESH_REQUIRED


# --- the headline defect ----------------------------------------------------


def test_overwritten_file_gets_a_new_revision_not_the_old_answer(tmp_path: Path) -> None:
    """demo.mp4 replaced by different content must not return the old index."""
    demo = _clip(tmp_path / "demo.mp4", "red")
    first = index_watch_result(watch(str(demo), transcript_only=True))

    replacement = _clip(tmp_path / "other.mp4", "blue", seconds=3.0)
    shutil.copy2(replacement, demo)

    assert check_freshness(str(demo))["state"] == Freshness.STALE.value

    second = index_watch_result(watch(str(demo), transcript_only=True))
    assert second != first, "changed content reused the old video row"
    assert check_freshness(str(demo))["state"] == Freshness.FRESH.value
    assert check_freshness(str(demo))["video_id"] == second

    # the old analysis is superseded, not destroyed
    revisions = source_revisions(str(demo))
    assert len(revisions) == 2
    assert {r["video_id"] for r in revisions} == {first, second}
    assert get_video(first) is not None


def test_unchanged_file_reuses_its_revision(tmp_path: Path) -> None:
    demo = _clip(tmp_path / "same.mp4", "green")
    first = index_watch_result(watch(str(demo), transcript_only=True))
    second = index_watch_result(watch(str(demo), transcript_only=True))
    assert first == second
    assert len(source_revisions(str(demo))) == 1
    assert check_freshness(str(demo))["state"] == Freshness.FRESH.value


def test_same_content_through_two_aliases_is_one_revision(tmp_path: Path) -> None:
    original = _clip(tmp_path / "a.mp4", "red")
    copy = tmp_path / "b.mp4"
    shutil.copy2(original, copy)
    assert digest_file(original) == digest_file(copy)

    first = index_watch_result(watch(str(original), transcript_only=True))
    second = index_watch_result(watch(str(copy), transcript_only=True))
    assert first == second, "identical bytes produced two video rows"


def test_cached_answers_do_not_leak_across_revisions(tmp_path: Path) -> None:
    from watch_skill.answer import cache as answer_cache
    from watch_skill.answer.types import Answer

    demo = _clip(tmp_path / "demo.mp4", "red")
    first = index_watch_result(watch(str(demo), transcript_only=True))
    answer_cache.put(
        Answer(video_id=first, question="what colour is it?", text="red",
               confidence=0.9, verified=True, honest_floor=False)
    )
    assert answer_cache.lookup(first, "what colour is it?") is not None

    shutil.copy2(_clip(tmp_path / "other.mp4", "blue", seconds=3.0), demo)
    second = index_watch_result(watch(str(demo), transcript_only=True))
    assert answer_cache.lookup(second, "what colour is it?") is None


def test_concurrent_indexing_of_one_revision_is_idempotent(tmp_path: Path) -> None:
    demo = _clip(tmp_path / "race.mp4", "red")
    results = watch(str(demo), transcript_only=True)

    with ThreadPoolExecutor(max_workers=4) as pool:
        ids = list(pool.map(lambda _: index_watch_result(results), range(4)))
    assert len(set(ids)) == 1, f"concurrent indexing forked the row: {set(ids)}"
    assert len(source_revisions(str(demo))) == 1


def test_ask_refuses_to_answer_from_a_stale_source(tmp_path: Path) -> None:
    from watch_skill.errors import StaleContentError
    from watch_skill.index.retrieval import ask_video

    demo = _clip(tmp_path / "demo.mp4", "red")
    indexed = index_watch_result(watch(str(demo), transcript_only=True))
    assert ask_video(str(demo), "what is on screen?")["freshness"]["state"] == "fresh"

    shutil.copy2(_clip(tmp_path / "other.mp4", "blue", seconds=3.0), demo)

    with pytest.raises(StaleContentError) as raised:
        ask_video(str(demo), "what is on screen?")
    assert raised.value.code == "index.stale"
    assert raised.value.fix

    # the historical revision is still readable BY ID, and says so
    by_id = ask_video(indexed, "what is on screen?")
    assert by_id["freshness"]["state"] == "fresh"
    assert ask_video(str(demo), "q", allow_stale=True)["video"]["id"] == indexed


def test_answer_question_carries_the_freshness_it_established(tmp_path: Path) -> None:
    from watch_skill.answer.engine import answer_question

    demo = _clip(tmp_path / "demo.mp4", "red")
    index_watch_result(watch(str(demo), transcript_only=True))
    answer = answer_question(str(demo), "what is on screen?", include_frames=False)
    assert answer.freshness == Freshness.FRESH.value


def test_moment_refuses_a_stale_source(tmp_path: Path) -> None:
    from watch_skill.errors import StaleContentError
    from watch_skill.index.retrieval import get_moment

    demo = _clip(tmp_path / "demo.mp4", "red")
    index_watch_result(watch(str(demo), transcript_only=True))
    shutil.copy2(_clip(tmp_path / "other.mp4", "blue", seconds=3.0), demo)
    with pytest.raises(StaleContentError):
        get_moment(str(demo), 1.0)


# --- legacy compatibility ---------------------------------------------------


def test_legacy_v1_ids_still_resolve(tmp_path: Path) -> None:
    """A v1 row keeps its id, and the new content id maps onto it."""
    demo = _clip(tmp_path / "legacy.mp4", "red")
    conn = connect()
    try:
        legacy = legacy_video_id_for(str(demo))
        with conn:
            conn.execute(
                "INSERT INTO videos (id, source, duration_seconds) VALUES (?, ?, 1.0)",
                (legacy, str(demo)),
            )
        assert resolve_video_id(conn, legacy) == legacy
    finally:
        conn.close()

    adopted = index_watch_result(watch(str(demo), transcript_only=True))
    assert adopted == legacy, "adopting a v1 row must not change the id agents hold"

    conn = connect()
    try:
        # the content-derived id now points at the adopted row
        content_id = video_id_for_digest(digest_file(demo))
        assert resolve_video_id(conn, content_id) == legacy
    finally:
        conn.close()
    assert get_video(legacy) is not None


def test_migration_backfills_legacy_rows_without_faking_a_digest() -> None:
    conn = connect()
    try:
        with conn:
            conn.execute(
                "INSERT INTO videos (id, source, duration_seconds) "
                "VALUES ('deadbeefdeadbeef', 'x.mp4', 1.0)"
            )
        rows = conn.execute("SELECT digest_source FROM revisions").fetchall()
        assert all(row["digest_source"] != "content" for row in rows)
    finally:
        conn.close()


def test_video_aliases_survive_a_superseding_revision(tmp_path: Path) -> None:
    conn = connect()
    try:
        with conn:
            conn.execute(
                "INSERT INTO videos (id, source, duration_seconds) "
                "VALUES ('1111111111111111', 'old.mp4', 1.0)"
            )
            register_video_alias(conn, "2222222222222222", "1111111111111111")
        assert resolve_video_id(conn, "2222222222222222") == "1111111111111111"
        assert resolve_video_id(conn, "3333333333333333") is None
    finally:
        conn.close()


# --- alias/revision bookkeeping --------------------------------------------


def test_bind_alias_keeps_the_assets_history(tmp_path: Path) -> None:
    from watch_skill.identity import make_revision

    conn = connect()
    try:
        with conn:
            first = record_revision(conn, make_revision(content_digest="a" * 64))
            bind_alias(conn, "clip.mp4", first)
            second = record_revision(conn, make_revision(content_digest="b" * 64))
            bind_alias(conn, "clip.mp4", second)
        history = revisions_for_alias(conn, "clip.mp4")
        assert len(history) == 2
        assert [entry["current"] for entry in history].count(True) == 1
        assert {entry["revision_id"] for entry in history} == {
            first.revision_id, second.revision_id
        }
    finally:
        conn.close()


def test_record_revision_is_idempotent_on_digest() -> None:
    from watch_skill.identity import make_revision

    conn = connect()
    try:
        with conn:
            one = record_revision(conn, make_revision(content_digest="c" * 64))
            two = record_revision(conn, make_revision(content_digest="c" * 64))
        assert one.revision_id == two.revision_id
        assert conn.execute("SELECT COUNT(*) AS n FROM revisions").fetchone()["n"] == 1
    finally:
        conn.close()


def test_resolve_alias_reports_unknown_for_an_unindexed_source() -> None:
    conn = connect()
    try:
        resolution = resolve_alias(conn, "never-seen.mp4")
        assert resolution.freshness is Freshness.UNKNOWN
        assert resolution.usable is False
    finally:
        conn.close()


def test_claim_video_row_supersedes_the_previous_row(tmp_path: Path) -> None:
    from watch_skill.identity import make_revision

    conn = connect()
    try:
        with conn:
            first = record_revision(conn, make_revision(content_digest="d" * 64))
            bind_alias(conn, "v.mp4", first)
            first_id, _ = claim_video_row(conn, "v.mp4", first)
            conn.execute(
                "INSERT INTO videos (id, source, duration_seconds, asset_id, revision_id, "
                "content_digest) VALUES (?, 'v.mp4', 1.0, ?, ?, ?)",
                (first_id, first.asset_id, first.revision_id, first.content_digest),
            )
            second = record_revision(conn, make_revision(content_digest="e" * 64))
            bind_alias(conn, "v.mp4", second)
            second_id, _ = claim_video_row(conn, "v.mp4", second)
        assert second_id != first_id
        row = conn.execute(
            "SELECT superseded_at FROM videos WHERE id = ?", (first_id,)
        ).fetchone()
        assert row["superseded_at"] is not None
    finally:
        conn.close()


# --- fingerprints -----------------------------------------------------------


def test_local_fingerprint_changes_when_the_file_does(tmp_path: Path) -> None:
    path = tmp_path / "f.bin"
    path.write_bytes(b"one")
    before = local_fingerprint(path)
    path.write_bytes(b"a much longer payload")
    after = local_fingerprint(path)
    assert not after.matches(before)
    assert before.significant
