"""Generate `schemas/bridge/manifest.json` from the Bridge wire models.

The manifest is the one artifact both halves of the product read: Watch Core
reports its digests in the handshake, and `@deepwatch/dsh-contracts` holds the
same values as constants so the Host can detect drift at connect time. Keeping
it generated rather than hand-maintained is the whole point — a recorded
digest is a claim about the models that nothing checks, and it keeps matching
after the models have moved.

Usage::

    python scripts/gen_bridge_schemas.py            # write the manifest
    python scripts/gen_bridge_schemas.py --check    # fail if it is stale

``--check`` is what CI runs. A model change that is not regenerated fails the
build instead of shipping a manifest that describes the previous release.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "src"))

from watch_skill.surfaces.bridge.schemas import manifest  # noqa: E402

MANIFEST_PATH = REPO_ROOT / "schemas" / "bridge" / "manifest.json"


def render() -> str:
    """The manifest as it should appear on disk, newline-terminated."""
    return json.dumps(manifest(), indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Exit non-zero if the manifest on disk is not what the models produce.",
    )
    args = parser.parse_args()

    expected = render()
    if args.check:
        if not MANIFEST_PATH.exists():
            print(f"missing: {MANIFEST_PATH.relative_to(REPO_ROOT)}", file=sys.stderr)
            print("run: python scripts/gen_bridge_schemas.py", file=sys.stderr)
            return 1
        actual = MANIFEST_PATH.read_text(encoding="utf-8")
        if actual != expected:
            print(
                f"stale: {MANIFEST_PATH.relative_to(REPO_ROOT)} does not match the "
                "Bridge wire models",
                file=sys.stderr,
            )
            print("run: python scripts/gen_bridge_schemas.py", file=sys.stderr)
            return 1
        print(f"fresh: {MANIFEST_PATH.relative_to(REPO_ROOT)}")
        return 0

    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(expected, encoding="utf-8")
    digests = manifest()["families"]
    print(f"wrote {MANIFEST_PATH.relative_to(REPO_ROOT)}")
    for family, entry in digests.items():
        print(f"  {family:<13} {entry['digest']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
