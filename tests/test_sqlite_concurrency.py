"""The lock that no timeout protected.

`PRAGMA journal_mode = WAL` is the one statement in this codebase that does
not honour `busy_timeout`. Every database module used to run it on every
connect, so on a *fresh* database -- which every isolated test and every new
install starts with -- concurrent connections raced for an exclusive lock that
no timeout covered, and one of them died instantly with `database is locked`.

It was intermittent, appeared only under concurrency, and survived a 30-second
busy timeout, which is exactly why it read as random CI noise for a season.
"""
from __future__ import annotations

import sqlite3
import threading

import pytest

from watch_skill.sqlite_util import enable_wal


@pytest.fixture
def locked_database(tmp_path):
    """A database whose write lock is held by somebody else."""
    path = tmp_path / "held.db"
    holder = sqlite3.connect(str(path), timeout=30.0)
    holder.execute("CREATE TABLE t (x INTEGER)")
    holder.commit()
    holder.execute("BEGIN IMMEDIATE")
    holder.execute("INSERT INTO t VALUES (1)")
    try:
        yield path, holder
    finally:
        try:
            holder.rollback()
        except sqlite3.Error:
            pass
        holder.close()


def test_the_raw_pragma_ignores_busy_timeout(locked_database) -> None:
    """The defect itself, pinned so nobody reintroduces the direct call.

    This is the measurement the fix rests on: a 30-second busy timeout is set
    and the pragma still fails immediately.
    """
    path, _holder = locked_database
    other = sqlite3.connect(str(path), timeout=30.0)
    other.execute("PRAGMA busy_timeout = 30000")
    try:
        with pytest.raises(sqlite3.OperationalError, match="locked"):
            other.execute("PRAGMA journal_mode = WAL")
    finally:
        other.close()


def test_enable_wal_survives_a_concurrent_switch(locked_database) -> None:
    """The fix: losing the race is somebody else's turn, not an error."""
    path, holder = locked_database
    other = sqlite3.connect(str(path), timeout=30.0)
    try:
        # Must not raise, even though the exclusive lock is unavailable.
        mode = enable_wal(other, timeout=0.5)
        assert mode in ("delete", ""), mode

        # Once the holder lets go, the switch happens.
        holder.rollback()
        assert enable_wal(other, timeout=5.0) == "wal"
    finally:
        other.close()


def test_enable_wal_is_free_once_the_database_is_already_wal(tmp_path) -> None:
    """The common case must not take an exclusive lock at all.

    If it did, every connect on a busy database would contend for one.
    """
    path = tmp_path / "already.db"
    first = sqlite3.connect(str(path), timeout=30.0)
    assert enable_wal(first) == "wal"

    # A second connection, while the first holds a write transaction. This
    # would deadlock or fail if the already-WAL path still tried to switch.
    first.execute("BEGIN IMMEDIATE")
    first.execute("CREATE TABLE t (x INTEGER)")
    second = sqlite3.connect(str(path), timeout=30.0)
    try:
        assert enable_wal(second, timeout=0.5) == "wal"
    finally:
        first.rollback()
        first.close()
        second.close()


def test_eight_threads_opening_a_fresh_database_do_not_collide() -> None:
    """The original symptom, reproduced at the layer that caused it.

    A fresh database plus concurrent connects is the exact shape that failed:
    the mode genuinely has to change, so every connection wants the exclusive
    lock at the same instant.
    """
    import tempfile
    from pathlib import Path

    path = Path(tempfile.mkdtemp(prefix="ws wal race ")) / "race.db"
    errors: list[str] = []
    modes: list[str] = []
    barrier = threading.Barrier(8)

    def worker() -> None:
        conn = sqlite3.connect(str(path), timeout=30.0)
        try:
            barrier.wait(timeout=30)  # start together, maximising the race
            modes.append(enable_wal(conn))
        except Exception as exc:  # noqa: BLE001 - asserted below
            errors.append(f"{type(exc).__name__}: {exc}")
        finally:
            conn.close()

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)

    assert not errors, errors[:3]
    assert modes and all(mode == "wal" for mode in modes), modes
