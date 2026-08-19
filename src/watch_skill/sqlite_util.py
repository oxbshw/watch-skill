"""Schema migration that two processes can run at the same instant.

The obvious implementation reads the current schema version and then applies
whatever is newer. Under Python's ``sqlite3`` that read happens *outside* the
write lock — the driver only opens a transaction on the first DML statement —
so two connections both see version 0, both start migration 1, and the loser
dies with ``table entities already exists``.

It is easy to miss because a test suite that opens one connection at a time
never sees it, and a first run always works. It surfaces the first time two
threads or two processes touch a fresh database together, which in practice
means the first time a user runs two commands at once.

The fix is to take the write lock *before* reading the version, which needs
explicit transaction control, which in turn means stepping outside the
driver's automatic handling for the duration.
"""
from __future__ import annotations

import sqlite3
import time
from collections.abc import Iterator
from contextlib import contextmanager

WAL_SWITCH_TIMEOUT_S = 10.0
"""How long to keep trying to move a database into WAL mode.

Generous, because losing this race is harmless and retrying is cheap; bounded,
because a database that can never switch must not hang a command forever."""


def enable_wal(conn: sqlite3.Connection,
               timeout: float = WAL_SWITCH_TIMEOUT_S) -> str:
    """Put a database into WAL mode without dying on a concurrent switch.

    ``PRAGMA journal_mode = WAL`` is the one statement here that **does not
    honour ``busy_timeout``**. Measured, not assumed: with a 30-second timeout
    set and another connection holding a write transaction, the pragma failed
    in 0.000s with ``database is locked``, while an ordinary
    ``BEGIN IMMEDIATE`` on the same connection correctly blocked for 33s
    before giving up.

    That matters because the switch needs a brief exclusive lock, and every
    connection used to attempt it on every connect. On an established database
    the mode is already ``wal`` and the attempt is free — but on a *fresh* one,
    which is what every isolated test and every new install starts with, the
    mode genuinely has to change, and eight threads connecting at once meant
    eight racers for a lock no timeout protected. One of them died instantly
    with ``database is locked``, intermittently, and only under concurrency.

    Two things make this safe. The mode is a property of the **database file**,
    not of the connection, so whichever caller wins sets it for everyone.
    And it is persistent, so the race only exists on the first connection to a
    new file. This therefore reads first, only attempts the switch when it is
    actually needed, and treats losing the race as "someone else is doing it"
    rather than as an error.

    Returns the journal mode now in force.
    """
    deadline = time.monotonic() + max(0.0, timeout)
    delay = 0.01
    while True:
        mode = _journal_mode(conn)
        if mode == "wal":
            return mode
        try:
            switched = conn.execute("PRAGMA journal_mode = WAL").fetchone()
            if switched and str(switched[0]).lower() == "wal":
                return "wal"
        except sqlite3.OperationalError:
            # Locked by a concurrent switch or writer. Not an error: the next
            # loop re-reads, and another connection may already have done it.
            pass
        if _journal_mode(conn) == "wal":
            return "wal"
        if time.monotonic() >= deadline:
            # Still not WAL. The database is usable in its current mode, with
            # less write concurrency, and saying so beats failing the command.
            return _journal_mode(conn)
        time.sleep(delay)
        delay = min(delay * 2, 0.25)


def _journal_mode(conn: sqlite3.Connection) -> str:
    """The mode in force, or "" when even the read is locked out."""
    try:
        row = conn.execute("PRAGMA journal_mode").fetchone()
    except sqlite3.OperationalError:
        return ""
    return str(row[0]).lower() if row else ""


@contextmanager
def immediate(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """A transaction that takes the write lock before doing anything.

    Use this for any transaction that *reads and then writes*. Python's
    ``sqlite3`` only opens a transaction on the first DML statement, so a
    leading SELECT starts a read transaction and the following INSERT has to
    upgrade the lock. SQLite refuses that upgrade with ``database is locked``
    the moment another connection has written since the read began — and it
    does **not** honour ``busy_timeout`` there, because the upgrade can never
    succeed: the snapshot the read saw is already stale. Retrying would not
    help; starting as a writer does.

    The symptom is a read-then-write that works perfectly until two callers
    do it at once, which is exactly when it matters.
    """
    previous = conn.isolation_level
    conn.isolation_level = None
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")
    finally:
        conn.isolation_level = previous


def split_statements(script: str) -> list[str]:
    """Split a migration script into complete SQL statements.

    ``executescript`` cannot be used inside a transaction — it issues an
    implicit COMMIT first, which would drop exactly the lock this module went
    to the trouble of acquiring. So the script is split and the statements are
    executed one at a time. ``sqlite3.complete_statement`` does the splitting
    rather than a naive ``split(";")``, so a semicolon inside a string literal
    or a trigger body does not tear a statement in half.
    """
    statements: list[str] = []
    buffer = ""
    for line in script.splitlines(keepends=True):
        buffer += line
        if sqlite3.complete_statement(buffer):
            text = buffer.strip()
            if text and not _only_comments(text):
                statements.append(text)
            buffer = ""
    tail = buffer.strip()
    if tail and not _only_comments(tail):
        statements.append(tail)
    return statements


def _only_comments(text: str) -> bool:
    for line in text.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("--"):
            return False
    return True


def apply_migrations(conn: sqlite3.Connection, migrations: list[str]) -> int:
    """Bring a database up to date. Safe to run concurrently.

    Returns the schema version now in force. A connection that loses the race
    finds the work already done and returns without applying anything, which
    is the correct outcome — not an error to be retried.
    """
    conn.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
    previous = conn.isolation_level
    # Autocommit, so BEGIN/COMMIT below are ours rather than the driver's.
    conn.isolation_level = None
    try:
        while True:
            conn.execute("BEGIN IMMEDIATE")
            try:
                row = conn.execute(
                    "SELECT MAX(version) AS v FROM schema_version").fetchone()
                current = int(row[0]) if row and row[0] is not None else 0
                if current >= len(migrations):
                    conn.execute("COMMIT")
                    return current
                version = current + 1
                for statement in split_statements(migrations[version - 1]):
                    conn.execute(statement)
                conn.execute(
                    "INSERT INTO schema_version (version) VALUES (?)", (version,))
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
    finally:
        conn.isolation_level = previous


def current_version(conn: sqlite3.Connection) -> int:
    conn.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
    row = conn.execute("SELECT MAX(version) AS v FROM schema_version").fetchone()
    return int(row[0]) if row and row[0] is not None else 0


__all__ = ["apply_migrations", "current_version", "enable_wal",
           "immediate", "split_statements"]
