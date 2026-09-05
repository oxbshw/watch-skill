"""Two of the fourteen check types were unreachable, and nothing said so.

`http_request` and `browser_dom` both call `_assert_public_origin`, which
refuses any origin the run was not allowlisted for. The failure text says *add
the host to the contract's allowed_origins* — and the contract had no such
field, the model forbids extra keys, and `watch-skill verify run` never passed
an allowlist to `verify_run`. So from the command line the list was always
empty, every network check raised `PermissionError`, and the advice named
somewhere that did not exist.

The guard's own docstring calls a loopback dev server "a legitimate and common
case". It was the case that could not be expressed.

The allowlist belongs to the *contract* rather than to a flag, and these tests
hold that distinction: the digest covers it, so a contract cannot be widened
after it was agreed to, and an evidence bundle records what the run was
permitted to reach.
"""
from __future__ import annotations

import json
import socket
import subprocess
import sys
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from watch_skill.verify import draft_contract
from watch_skill.verify.contract import VerificationContract

ROOT = Path(__file__).resolve().parents[2]

PAGE = b"<!doctype html><title>t</title><div id='m'>ORCA-VERIFY-FIXTURE</div>"


@pytest.fixture()
def served(tmp_path: Path):
    """A loopback page this test wrote, on a port the OS picked."""
    (tmp_path / "index.html").write_bytes(PAGE)
    handler = partial(SimpleHTTPRequestHandler, directory=str(tmp_path))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                break
        except OSError:
            time.sleep(0.05)
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.shutdown()
        server.server_close()


# The console script by its entry point rather than by name on PATH: a test
# must exercise the same code `watch-skill verify run` does without depending
# on whether this environment installed the wrapper.
_ENTRY = "from watch_skill.surfaces.cli.main import app; app()"


def _run_cli(contract: dict, working_dir: Path) -> dict:
    path = working_dir / "contract.json"
    path.write_text(json.dumps(contract), encoding="utf-8")
    result = subprocess.run(
        [sys.executable, "-c", _ENTRY, "verify", "run", str(path),
         "--dir", str(working_dir)],
        capture_output=True, text=True, timeout=300, cwd=str(ROOT),
        encoding="utf-8", errors="replace",
    )
    try:
        bundle = json.loads(result.stdout)
    except json.JSONDecodeError:
        raise AssertionError(
            f"the CLI printed no JSON (exit {result.returncode}):\n"
            f"stdout: {result.stdout[-800:]}\nstderr: {result.stderr[-800:]}") from None
    bundle["_returncode"] = result.returncode
    return bundle


def test_the_field_exists_and_the_digest_covers_it() -> None:
    """Widening a frozen contract's reach must break its integrity check."""
    contract = draft_contract(
        "reachability", [{"id": "c", "type": "file_exists", "params": {"path": "."}}],
        allowed_origins=["http://127.0.0.1:9"],
    ).freeze()
    contract.verify_integrity()

    widened = contract.model_copy(
        update={"allowed_origins": ["http://127.0.0.1:9", "https://example.invalid"]})
    with pytest.raises(Exception) as raised:
        widened.verify_integrity()
    assert "modified after freezing" in str(raised.value)


def test_a_revision_keeps_the_reach_its_predecessor_was_granted() -> None:
    original = draft_contract(
        "reach", [{"id": "c", "type": "file_exists", "params": {"path": "."}}],
        allowed_origins=["http://127.0.0.1:9"],
    )
    revised = original.revise([{"id": "c2", "type": "file_exists", "params": {"path": "."}}]
                              and original.checks)
    assert revised.allowed_origins == ["http://127.0.0.1:9"]


def test_an_allowlisted_loopback_origin_is_reachable_from_the_cli(
    served: str, tmp_path: Path,
) -> None:
    """The case the guard's docstring calls legitimate, run end to end."""
    bundle = _run_cli({
        "contract_id": "origins-allowed",
        "title": "the page serves what it serves",
        "allowed_origins": [served],
        "checks": [
            {"id": "page", "type": "http_request",
             "params": {"url": f"{served}/", "status": 200,
                        "body_contains": "ORCA-VERIFY-FIXTURE"}},
        ],
    }, tmp_path)
    assert bundle.get("verdict") == "pass", bundle
    assert [c["status"] for c in bundle["checks"]] == ["pass"]


def test_an_origin_the_contract_did_not_name_is_refused(
    served: str, tmp_path: Path,
) -> None:
    """The allowlist is a bound, not a formality."""
    bundle = _run_cli({
        "contract_id": "origins-absent",
        "title": "the same page, unnamed",
        "checks": [
            {"id": "page", "type": "http_request",
             "params": {"url": f"{served}/", "status": 200}},
        ],
    }, tmp_path)
    # `inconclusive`, and deliberately not `fail`. The product distinguishes
    # "checked, and it is false" from "could not be checked", and a refused
    # origin is the second: nothing was learned about the page. Asserting
    # `fail` here was this test's own mistake, and it would have been a bad one
    # to enshrine -- it is exactly the collapse this codebase exists to avoid.
    assert bundle.get("verdict") == "inconclusive", bundle
    assert bundle["_returncode"] != 0, "an unverified required check is not a pass"
    reasons = " ".join(bundle.get("limitations") or []) + " " + " ".join(
        check.get("summary") or "" for check in bundle.get("checks", []))
    assert "allowed_origins" in reasons, bundle
    # And the run says so where a reader will see it, rather than only in a code.
    assert any("page" in limitation for limitation in bundle.get("limitations") or []), bundle


def test_naming_one_origin_does_not_open_another(served: str, tmp_path: Path) -> None:
    # The allowlist is per-origin, and a contract that reached a *different*
    # loopback port than the one it named would make the field decorative.
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        elsewhere = sock.getsockname()[1]
    bundle = _run_cli({
        "contract_id": "origins-other-port",
        "title": "a port that was not agreed to",
        "allowed_origins": [served],
        "checks": [
            {"id": "page", "type": "http_request",
             "params": {"url": f"http://127.0.0.1:{elsewhere}/", "status": 200}},
        ],
    }, tmp_path)
    assert bundle.get("verdict") == "inconclusive", bundle
    assert bundle["_returncode"] != 0
    reasons = " ".join(bundle.get("limitations") or [])
    assert str(elsewhere) in reasons and str(served.rsplit(":", 1)[1]) in reasons, bundle


def test_the_contract_model_still_forbids_unknown_keys() -> None:
    # `extra: forbid` is what made the missing field a hard failure rather than
    # a silently ignored one, and that is worth keeping.
    with pytest.raises(Exception):
        VerificationContract.model_validate({
            "contract_id": "x", "checks": [], "allowed_orgins": ["typo"],
        })
