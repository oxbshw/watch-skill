"""The secret scanner, shown catching things.

A scanner that has only ever printed "clean" is indistinguishable from a
scanner whose patterns no longer compile against anything. That is not a
hypothetical failure mode for this file: every rule here is a regular
expression over bytes, and a rule that silently stops matching looks exactly
like a repository that has stopped leaking.

So each rule gets a positive control — a synthetic value it must find — and
each control is paired with an assertion that the finding is *redacted*, which
is the other half of the contract. A scanner that quotes what it found has
moved the secret into a test log, a terminal history and a CI transcript,
which is three more places than it was.

Every value below is fabricated. The AWS one is Amazon's own published example
key; the rest are structurally valid and belong to nobody.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))

import secret_scan  # noqa: E402, I001 - the sys.path line above has to run first


#: One synthetic value per rule, chosen to match its pattern and nothing real.
CONTROLS: dict[str, bytes] = {
    "anthropic key": b"sk-ant-api03-0000000000000000000000AA",
    "openai key": b"sk-0000000000000000000000000000000000",
    "github token": b"ghp_0000000000000000000000000000000000",
    "aws access key": b"AKIA0000000000000000",
    "google api key": b"AIza0000000000000000000000000000000000",
    "slack token": b"xoxb-0000000000-000000000000",
    "private key block": b"-----BEGIN RSA PRIVATE KEY-----",
    # Its own rule as well as `private key block`, which is deliberate: the
    # broader rule must keep catching it if the specific one is ever narrowed.
    "encrypted private key": b"-----BEGIN ENCRYPTED PRIVATE KEY-----",
    "hf token": b"hf_000000000000000000000000000000000",
    "npm token": b"npm_000000000000000000000000000000000000",
    "pypi token": b"pypi-AgEIcHlwaS5vcmc0000000000",
    "openrouter key": b"sk-or-v1-00000000000000000000000000000000",
    "bearer authorization header": b"Authorization: Bearer 0000000000000000",
    "maintainer home": rb"C:\Users\a-person",
    "posix home path": b"/home/a-person/",
    "maintainer drive": rb"G:\watch-workspace",
    "stale npm scope": b"@watchskill/",
}

#: Rules that only apply to what is published, checked in the packed pass.
PACKED_CONTROLS: dict[str, bytes] = {
    "npmrc auth line": b"//registry.npmjs.org/:_authToken=0000000000",
    "certificate block": b"-----BEGIN CERTIFICATE-----",
}


def rules_hit(data: bytes, *, packed: bool = False) -> set[str]:
    """The rule names one payload trips, under a filename nothing exempts."""
    return {name for _label, name, _detail in
            secret_scan.scan("tests/fixtures/synthetic-control.txt", data, packed=packed)}


class TestEveryRuleCanFail:
    @pytest.mark.parametrize("rule", sorted(CONTROLS))
    def test_rule_catches_its_control(self, rule: str) -> None:
        assert rule in rules_hit(CONTROLS[rule]), f"{rule} matched nothing"

    @pytest.mark.parametrize("rule", sorted(PACKED_CONTROLS))
    def test_packed_only_rule_catches_its_control(self, rule: str) -> None:
        assert rule in rules_hit(PACKED_CONTROLS[rule], packed=True)

    def test_a_packed_only_rule_is_quiet_on_the_working_tree(self) -> None:
        """Documentation may quote an `.npmrc` line; a tarball may not hold one."""
        for rule, value in PACKED_CONTROLS.items():
            assert rule not in rules_hit(value, packed=False)

    def test_every_pattern_has_a_control(self) -> None:
        """A rule nobody proved can fire is a rule nobody has tested."""
        declared = {name for name, _ in secret_scan.PATTERNS}
        covered = set(CONTROLS) | set(PACKED_CONTROLS)
        assert declared - covered == set(), "rules with no positive control"

    def test_an_encrypted_key_header_trips_both_rules_that_describe_it(self) -> None:
        """The specific rule and the general one, so narrowing either is visible."""
        hits = rules_hit(CONTROLS["encrypted private key"])
        assert {"encrypted private key", "private key block"} <= hits


class TestNothingIsEverPrinted:
    @pytest.mark.parametrize("rule", sorted(CONTROLS))
    def test_a_finding_never_reproduces_the_value(self, rule: str) -> None:
        value = CONTROLS[rule]
        findings = secret_scan.scan("tests/fixtures/synthetic-control.txt", value)
        rendered = " ".join(detail for _label, _name, detail in findings)
        # The whole value must not appear, and neither must a usable tail of it.
        assert value.decode() not in rendered
        assert value.decode()[-8:] not in rendered
        assert "redacted" in rendered

    def test_a_finding_still_says_enough_to_find_it(self) -> None:
        """Redaction is not silence: length and shape locate the match."""
        detail = secret_scan.scan("f.txt", CONTROLS["aws access key"])[0][2]
        assert "20 chars" in detail
        assert "AKIA" in detail


class TestExemptionsAreNarrow:
    def test_there_is_no_file_wide_allowlist(self) -> None:
        """A file allowed to hold a certificate header must not thereby be
        allowed to hold a live API key. `ALLOW_PATHS` permitted exactly that,
        and matched by substring, so any path containing one of its entries
        was exempt from every rule."""
        assert not hasattr(secret_scan, "ALLOW_PATHS"), (
            "file-wide exemptions are not allowed; use DELIBERATE[(file, rule)]"
        )

    def test_every_exemption_names_one_file_and_one_rule(self) -> None:
        known_rules = {name for name, _ in secret_scan.PATTERNS}
        for key, reason in secret_scan.DELIBERATE.items():
            path, rule = key
            assert rule in known_rules, f"{rule} is not a rule"
            assert "*" not in path and "?" not in path, f"{path} is a glob"
            assert (REPO / path).exists(), f"{path} no longer exists"
            assert reason.strip(), f"{path}/{rule} has no stated reason"

    def test_an_exemption_covers_only_the_rule_it_names(self) -> None:
        """The property the file-wide allowlist did not have."""
        exempt_file, exempt_rule = next(iter(secret_scan.DELIBERATE))
        other = next(r for r, _ in secret_scan.PATTERNS if r != exempt_rule
                     and r in CONTROLS)
        found = secret_scan.scan(exempt_file, CONTROLS[other])
        assert any(name == other for _l, name, _d in found), (
            f"{exempt_file} is exempt from {exempt_rule} and must still fail {other}"
        )


class TestTheRepositoryItself:
    @pytest.mark.timeout(600)
    def test_the_tracked_tree_is_clean(self) -> None:
        result = subprocess.run(
            [sys.executable, str(REPO / "scripts" / "secret_scan.py")],
            cwd=REPO, capture_output=True, text=True,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        assert "repository: clean" in result.stdout
