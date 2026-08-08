"""Word-level timestamps: the moment, not the paragraph it was in.

A segment can run ten seconds. Answering "when was that said" from segment
bounds is only ever accurate to the segment, which is the wrong unit for a
citation that someone will scrub to.
"""
from __future__ import annotations

import json

import pytest

from watch_skill.transcribe.types import Segment, Transcript, Word

SPOKEN = Segment(
    0.0,
    6.0,
    "the deploy finished at nine fifteen",
    words=[
        Word(0.0, 0.4, "the"),
        Word(0.4, 1.2, "deploy"),
        Word(1.2, 2.0, "finished"),
        Word(2.0, 2.3, "at"),
        Word(2.3, 3.1, "nine"),
        Word(3.1, 4.0, "fifteen"),
    ],
)


def test_word_at_names_what_was_being_said() -> None:
    assert SPOKEN.word_at(2.5).text == "nine"
    assert SPOKEN.word_at(0.2).text == "the"
    assert SPOKEN.word_at(5.5) is None, "silence after the last word is not a word"


def test_find_word_ignores_case_and_punctuation() -> None:
    """A user quotes what they heard, not what the tokenizer produced."""
    assert SPOKEN.find_word("Deploy!").start == 0.4
    assert SPOKEN.find_word("FINISHED").start == 1.2
    assert SPOKEN.find_word("rollback") is None
    assert SPOKEN.find_word("") is None
    assert SPOKEN.find_word("!!!") is None


def test_offset_moves_words_with_their_segment() -> None:
    """Windowed audio is transcribed on its own timeline.

    Shifting the segment but not its words would leave the words pointing at
    the window while the segment points at the source — a citation that is
    silently wrong rather than absent.
    """
    shifted = Transcript([SPOKEN], source="whisper-local (tiny)").offset(100.0)
    seg = shifted.segments[0]
    assert seg.start == 100.0
    assert [w.start for w in seg.words] == [100.0, 100.4, 101.2, 102.0, 102.3, 103.1]
    assert seg.word_at(102.5).text == "nine"


def test_a_segment_without_words_still_works() -> None:
    """Captions and cloud STT carry no alignment; nothing may assume they do."""
    plain = Segment(0.0, 3.0, "no alignment here")
    assert plain.words == []
    assert plain.word_at(1.0) is None
    assert plain.find_word("alignment") is None
    assert "words" not in plain.to_dict()


def test_words_serialize_only_when_present() -> None:
    assert SPOKEN.to_dict()["words"][1] == {"start": 0.4, "end": 1.2, "text": "deploy"}
    assert "words" not in Segment(0.0, 1.0, "x").to_dict()


def test_the_index_round_trips_words(tmp_path, monkeypatch) -> None:
    from watch_skill import config
    from watch_skill.index.db import connect, migrate

    monkeypatch.setenv("WATCHSKILL_DATA_DIR", str(tmp_path / "data"))
    config.reset_settings()

    conn = connect()
    assert migrate(conn) >= 8, "the words_json migration did not apply"
    conn.execute(
        "INSERT INTO videos (id, source, title, duration_seconds, transcript_source, frames_dir)"
        " VALUES ('v1','s','t',6.0,'x','d')"
    )
    conn.execute(
        "INSERT INTO segments (video_id, start, end, text, words_json) VALUES (?,?,?,?,?)",
        ("v1", SPOKEN.start, SPOKEN.end, SPOKEN.text,
         json.dumps([w.to_dict() for w in SPOKEN.words])),
    )
    conn.commit()

    stored = conn.execute("SELECT words_json FROM segments WHERE video_id='v1'").fetchone()
    words = json.loads(stored["words_json"])
    conn.close()
    assert len(words) == 6
    assert words[1]["text"] == "deploy"


def test_get_moment_names_the_word_at_the_instant(tmp_path, monkeypatch) -> None:
    """The payoff: ask about 2.5s and be told which word that was."""
    from watch_skill import config
    from watch_skill.index.db import connect, migrate
    from watch_skill.index.retrieval import get_moment

    monkeypatch.setenv("WATCHSKILL_DATA_DIR", str(tmp_path / "data"))
    config.reset_settings()

    conn = connect()
    migrate(conn)
    conn.execute(
        "INSERT INTO videos (id, source, title, duration_seconds, transcript_source, frames_dir)"
        " VALUES ('vid0000000000001','s','t',6.0,'x','d')"
    )
    conn.execute(
        "INSERT INTO segments (video_id, start, end, text, words_json) VALUES (?,?,?,?,?)",
        ("vid0000000000001", SPOKEN.start, SPOKEN.end, SPOKEN.text,
         json.dumps([w.to_dict() for w in SPOKEN.words])),
    )
    conn.commit()
    conn.close()

    moment = get_moment("vid0000000000001", timestamp=2.5, window=2.0)
    segment = moment.segments[0]
    assert segment["word_at_timestamp"]["text"] == "nine"
    assert len(segment["words"]) == 6
    assert "words_json" not in segment, "the raw JSON column must not leak to callers"


def test_a_moment_without_words_omits_the_field(tmp_path, monkeypatch) -> None:
    from watch_skill import config
    from watch_skill.index.db import connect, migrate
    from watch_skill.index.retrieval import get_moment

    monkeypatch.setenv("WATCHSKILL_DATA_DIR", str(tmp_path / "data"))
    config.reset_settings()

    conn = connect()
    migrate(conn)
    conn.execute(
        "INSERT INTO videos (id, source, title, duration_seconds, transcript_source, frames_dir)"
        " VALUES ('vid0000000000002','s','t',6.0,'x','d')"
    )
    conn.execute(
        "INSERT INTO segments (video_id, start, end, text) VALUES (?,?,?,?)",
        ("vid0000000000002", 0.0, 6.0, "captions carry no alignment"),
    )
    conn.commit()
    conn.close()

    segment = get_moment("vid0000000000002", timestamp=2.5, window=2.0).segments[0]
    assert "words" not in segment
    assert "word_at_timestamp" not in segment


@pytest.mark.parametrize("size", ["tiny", "base"])
def test_local_transcribe_accepts_the_flag(size: str) -> None:
    """Signature guard: the flag must reach faster-whisper, not be dropped."""
    import inspect

    from watch_skill.transcribe.local import transcribe_local

    params = inspect.signature(transcribe_local).parameters
    assert "word_timestamps" in params
    assert params["word_timestamps"].default is False, "must stay opt-in"
