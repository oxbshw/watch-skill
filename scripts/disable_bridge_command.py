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
import sys
from pathlib import Path

COMMAND = re.compile(r"@app\.command\(\)\ndef bridge\(.*?\n\n\n", re.S)


def main() -> int:
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

    main_py.write_text(text[: match.start()] + text[match.end() :], encoding="utf-8")
    # Bytecode outlives the source edit and would keep serving the command.
    for stale in root.rglob("main.cpython*.pyc"):
        stale.unlink()
    print(f"removed the bridge command from {main_py}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
