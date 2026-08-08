"""CLI output stays UTF-8 when stdout is a pipe.

A Windows tty goes through the console API and handles Unicode already; a
pipe or a redirect falls back to the system codepage. Reports carry em dashes
and, for non-English video, the content's own script, so on a cp1256/cp1252/
cp932 machine `watch-skill ... > report.md` wrote U+FFFD in place of the text
and every agent reading stdout got the same.

Run in a subprocess on purpose: pytest replaces sys.stdout with a capture
object, so the reconfiguration the CLI performs at import is only observable
from a real process with a real pipe.
"""
from __future__ import annotations

import subprocess
import sys

import pytest

# Codepages that cannot represent U+2014. cp1256 is Arabic Windows, cp1252
# Western, cp932 Japanese — all common, none able to encode an em dash.
NARROW_CODEPAGES = ["cp1256", "cp1252", "cp932"]

PROBE = (
    "import sys;"
    "import watch_skill.surfaces.cli.main;"  # the import performs the fix
    "sys.stdout.write('em:\\u2014 ar:\\u0627\\u0644\\u0639\\u0631\\u0628\\u064a\\u0629 ja:\\u65e5')"
)


@pytest.mark.parametrize("codepage", NARROW_CODEPAGES)
def test_stdout_is_utf8_through_a_pipe(codepage: str) -> None:
    """The CLI must not emit replacement characters into a redirect."""
    result = subprocess.run(
        [sys.executable, "-c", PROBE],
        capture_output=True,
        env={"PYTHONIOENCODING": codepage, "PYTHONPATH": "src", "PATH": ""},
        timeout=120,
    )
    assert result.returncode == 0, result.stderr.decode("utf-8", "replace")

    # Raw bytes, decoded as UTF-8 — the encoding the CLI promises.
    out = result.stdout.decode("utf-8", errors="strict")
    assert "—" in out, "em dash was mangled"
    assert "العربية" in out, "Arabic text was mangled"
    assert "�" not in out, "output contains replacement characters"


def test_importing_the_cli_does_not_crash_on_a_narrow_codepage() -> None:
    """Before the fix a strict narrow codepage raised UnicodeEncodeError."""
    result = subprocess.run(
        [sys.executable, "-c", PROBE],
        capture_output=True,
        env={"PYTHONIOENCODING": "cp1256:strict", "PYTHONPATH": "src", "PATH": ""},
        timeout=120,
    )
    assert result.returncode == 0, result.stderr.decode("utf-8", "replace")
