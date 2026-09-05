"""Remove the `bridge` command from an *installed* Watch Core.

The counterfactual the Bridge integration rests on is "an engine that does not
have this surface", and the only faithful way to produce one is to take a real
install and delete the command from it. A fixture that prints the same error
would prove that the fixture prints the same error.

    python scripts/disable_bridge_command.py <venv-root>

Refuses rather than guesses: a venv where the command is already absent, or
where the CLI cannot be found, is a provisioning mistake and saying so beats
producing something that merely looks disabled.
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

COMMAND = re.compile(r"@app\.command\(\)\ndef bridge\(.*?\n\n\n", re.S)


def has_bridge(exe: Path) -> bool:
    """Whether an installed Core offers the `bridge` command.

    Asked here rather than with a shell pipeline. The engine renders its help
    through Rich, and reading that back through `grep` turned out to depend on
    the console encoding a pipe negotiates: the word was plainly in the output
    and the pipeline did not find it, on every platform at least once.
    Decoding the bytes explicitly, and tolerating what will not decode, removes
    the guesswork.
    """
    result = subprocess.run(
        [str(exe), "--help"], capture_output=True, timeout=300, check=False
    )
    text = (result.stdout + b"\n" + result.stderr).decode("utf-8", "replace")
    if "bridge" in text:
        return True
    # A UTF-16 console leaves a NUL between every character; strip them and
    # look again before concluding the command is absent.
    return "bridge" in text.replace("\x00", "")


def verify(mode: str, exe: Path) -> int:
    """Assert the provisioning is what the caller intended, and say what it saw."""
    present = has_bridge(exe)
    if mode == "--verify-has-bridge" and not present:
        print(f"{exe} has no bridge command; the packed suite would skip", file=sys.stderr)
        return 1
    if mode == "--verify-lacks-bridge" and present:
        print(f"{exe} still has the bridge command; the counterfactual is vacuous",
              file=sys.stderr)
        return 1
    verb = "has" if present else "does not have"
    print(f"verified: {exe} {verb} the bridge command")
    return 0


def main() -> int:
    if len(sys.argv) == 3 and sys.argv[1].startswith("--verify-"):
        return verify(sys.argv[1], Path(sys.argv[2]))
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    root = Path(sys.argv[1])
    if not root.is_dir():
        print(f"not a directory: {root}", file=sys.stderr)
        return 1

    try:
        main_py = next(root.rglob("watch_skill/surfaces/cli/main.py"))
    except StopIteration:
        print(f"no installed Watch Core CLI under {root}", file=sys.stderr)
        return 1

    text = main_py.read_text(encoding="utf-8")
    match = COMMAND.search(text)
    if match is None:
        print(f"the bridge command is not in {main_py}", file=sys.stderr)
        return 1

    # Unlink before writing, to break the hardlink.
    #
    # `uv pip install` populates a venv with hardlinks into its own cache, so
    # two venvs installed from the same wheel share inodes. Writing in place
    # therefore edited *both* — and the cache with them. On CI that removed the
    # bridge command from the install this counterfactual is measured against,
    # and the packed suite skipped itself with "no bridge command" while
    # reporting success. Replacing the file gives this venv its own copy.
    stripped = text[: match.start()] + text[match.end() :]
    main_py.unlink()
    main_py.write_text(stripped, encoding="utf-8")
    # Bytecode outlives the source edit and would keep serving the command.
    for stale in root.rglob("main.cpython*.pyc"):
        stale.unlink()
    print(f"removed the bridge command from {main_py}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
