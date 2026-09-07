"""The release surface, on the two faces Node cannot reach.

`workspace/scripts/verify-release-surface.mjs` scans the documents, package
descriptions and npm tarballs. It cannot run the Python CLI and it does not
build a wheel. Those two are where the same class of defect hides in this half:
help text that names a flag which was renamed, and a source distribution that
carries a page nobody meant to publish.

Both halves read `release-surface-rules.json`, so a rule cannot be relaxed on
one side and left standing on the other. The table is the contract; this file
is one of its two enforcers.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
CONFIG = json.loads((REPO / "release-surface-rules.json").read_text(encoding="utf-8"))

RULES = [
    (rule["id"], re.compile(rule["pattern"]), rule["why"]) for rule in CONFIG["rules"]
]
#: Exemptions, keyed by (file, rule).
#:
#: ``None`` excuses the whole file. A tuple of compiled patterns excuses only
#: the occurrences whose preceding text matches — one match at a time, never a
#: whole line, so a legitimate identifier and a stale reference can share a line
#: and only the first is excused.
EXEMPT: dict[tuple[str, str], tuple[re.Pattern[str], ...] | None] = {}
for _entry in CONFIG["exemptions"]:
    _key = (_entry["file"], _entry["rule"])
    if "precededBy" not in _entry:
        EXEMPT[_key] = None
    elif EXEMPT.get(_key, ()) is not None:
        EXEMPT[_key] = tuple(EXEMPT.get(_key) or ()) + (re.compile(_entry["precededBy"]),)


#: Text that is fine in source and not fine in something a user is handed.
#:
#: `phantom-repository` and `stale-npm-scope` are checked against the *detectors*
#: that exist for them, so they are exempt where the detector lives. Everything
#: else applies everywhere on this surface.
DETECTOR_FILES = {"scripts/secret_scan.py", "scripts/validate_agent_docs.py"}


def findings_in(label: str, text: str, key: str | None = None) -> list[str]:
    found = []
    for rule_id, pattern, why in RULES:
        exempt_key = ((key or label), rule_id)
        allowed = EXEMPT.get(exempt_key, ())
        if exempt_key in EXEMPT and allowed is None:
            continue
        for number, line in enumerate(text.splitlines(), start=1):
            match = None
            for candidate in pattern.finditer(line):
                prefix = line[: candidate.start()]
                if any(a.search(prefix) for a in (allowed or ())):
                    continue
                match = candidate
                break
            if match:
                found.append(f"{label}:{number} [{rule_id}] {why} -- {line.strip()[:110]}")
                break
    return found


class TestTheRuleTableIsShared:
    def test_both_halves_read_the_same_file(self) -> None:
        node_gate = (
            REPO / "workspace" / "scripts" / "verify-release-surface.mjs"
        ).read_text(encoding="utf-8")
        assert "release-surface-rules.json" in node_gate
        assert "release-surface-rules.json" in Path(__file__).read_text(encoding="utf-8")

    def test_every_rule_has_a_pattern_and_a_reason(self) -> None:
        for rule_id, pattern, why in RULES:
            assert pattern.pattern, f"{rule_id} has no pattern"
            assert len(why) > 15, f"{rule_id} does not say why it matters"

    def test_the_shared_fixtures_hold_in_this_engine_too(self) -> None:
        """One fixture file, read by this suite and by the Node one.

        `phantom-repository` shipped broken twice because each engine kept its
        own cases: once with a literal backspace that matched nothing here, and
        once with a lookbehind that missed Markdown and ``repository:`` forms.
        A shared file is what stops a rule being green in one engine and blind
        in the other.
        """
        fixtures = json.loads(
            (REPO / "release-surface-fixtures.json").read_text(encoding="utf-8"))
        by_id = {rule_id: pattern for rule_id, pattern, _why in RULES}
        for rule_id, cases in fixtures.items():
            if rule_id.startswith("$"):
                continue
            assert rule_id in by_id, f"{rule_id} has fixtures but is not a rule"
            pattern = by_id[rule_id]
            for text in cases["catches"]:
                assert pattern.search(text), f"{rule_id} must catch: {text}"
            for text in cases["allows"]:
                assert not pattern.search(text), f"{rule_id} must not fire on: {text}"

    def test_the_patterns_compile_the_same_way_in_both_engines(self) -> None:
        """A JS-only construct in the table would silently never match here."""
        for rule_id, pattern, _why in RULES:
            assert "(?<" not in pattern.pattern, (
                f"{rule_id} uses a lookbehind; keep the table to syntax both "
                "engines read the same way"
            )


class TestTheExemptionIsScopedToOneOccurrence:
    """`watch-workspace` is a profile row id and a repository that does not exist.

    The exemption must excuse the row and nothing else: not the whole file,
    which would blind the rule where the confusing name lives, and not the
    whole line, which would hide a stale reference sitting beside the row.
    These cases are shared with workspace/tests/release-surface.test.mjs.
    """

    EXEMPTED = REPO / "workspace" / "packages" / "watch" / "workspace" / "README.md"

    @staticmethod
    def _appended(line: str) -> tuple[list[str], bytes]:
        """Scan the real file with ``line`` appended; return findings and bytes.

        Bytes throughout, for two separate reasons. `write_text` emits
        `os.linesep`, which would rewrite this tracked file's endings on
        Windows — and interpolating the bytes that were read into an f-string
        writes their *repr*: ``b'# @deepwatch...\\n\\n- id: ...'``, one long
        line of escapes where the file used to be. Scanning that is not
        scanning this file. The exempted row stops being at the start of a
        line, every other line stops existing, and what the rule then reports
        is a fact about a string the test invented.
        """
        cases = TestTheExemptionIsScopedToOneOccurrence
        original = cases.EXEMPTED.read_bytes()
        try:
            cases.EXEMPTED.write_bytes(original + f"\n{line}\n".encode())
            written = cases.EXEMPTED.read_bytes()
            relative = str(cases.EXEMPTED.relative_to(REPO)).replace("\\", "/")
            found = findings_in(relative, written.decode("utf-8"))
            return [f for f in found if "[phantom-repository]" in f], written
        finally:
            cases.EXEMPTED.write_bytes(original)

    @classmethod
    def _findings_for(cls, line: str) -> list[str]:
        return cls._appended(line)[0]

    @staticmethod
    def _cases() -> dict[str, list[str]]:
        return json.loads(
            (REPO / "release-surface-fixtures.json").read_text(encoding="utf-8")
        )["$exemptions"]["phantom-repository"]

    def test_the_scanned_fixture_is_the_real_file_plus_the_line(self) -> None:
        # If the fixture is not the file it claims to be, every assertion
        # below is about something else.
        original = self.EXEMPTED.read_bytes()
        line = self._cases()["clean"][0]
        _found, written = self._appended(line)
        assert written.startswith(original), "rewritten rather than appended to"
        assert written.endswith(f"\n{line}\n".encode())
        assert b"\\n" not in written, "the bytes were interpolated, not appended"
        assert written.decode("utf-8").splitlines()[-1] == line

    def test_the_original_bytes_come_back_exactly(self) -> None:
        original = self.EXEMPTED.read_bytes()
        self._findings_for("Clone watch-workspace and run pnpm install.")
        assert self.EXEMPTED.read_bytes() == original, (
            "a tracked file did not survive the scan byte for byte")

    def test_the_allowed_row_is_not_reported_however_it_is_spaced(self) -> None:
        for line in self._cases()["clean"]:
            assert self._findings_for(line) == [], (
                f"reported a legitimate profile row: {line!r}")

    def test_a_genuine_stale_reference_is_reported_including_beside_the_row(self) -> None:
        own_lines = len(self.EXEMPTED.read_text(encoding="utf-8").splitlines())
        for line in self._cases()["reported"]:
            found = self._findings_for(line)
            assert len(found) == 1, (
                f"missed a stale repository reference: {line!r}")
            # And on the appended line, not somewhere in the file's own text:
            # a finding reported against line 1 would pass the count and mean
            # the case under test was never reached.
            reported_at = int(found[0].split(" ", 1)[0].rsplit(":", 1)[1])
            assert reported_at > own_lines, (
                f"reported line {reported_at} of a {own_lines}-line file, "
                f"which is its own content rather than {line!r}")


class TestTheCliHelpIsCleanText:
    """Help output is the most-read documentation this project has."""

    @pytest.fixture(scope="class")
    @classmethod
    def help_pages(cls) -> dict[str, str]:
        # The console script, not `python -m`: this package has no
        # `__main__`, and the entry point is what a user actually types.
        exe = shutil.which("watch-skill", path=str(Path(sys.executable).parent))
        if exe is None:
            pytest.skip("watch-skill is not installed in this interpreter")
        # A narrow terminal wraps help text mid-word, which would turn a clean
        # page into a false positive and a dirty one into a false negative.
        env = {**os.environ, "COLUMNS": "200", "NO_COLOR": "1", "TERM": "dumb"}
        pages = {}
        for args in (["--help"], ["doctor", "--help"], ["watch", "--help"],
                     ["setup-vision", "--help"], ["bridge", "--help"]):
            result = subprocess.run(
                [exe, *args], cwd=REPO, capture_output=True, text=True,
                timeout=180, env=env, encoding="utf-8", errors="replace",
            )
            assert result.returncode == 0, (
                f"watch-skill {' '.join(args)} exited {result.returncode}: "
                f"{result.stderr[-300:]}"
            )
            pages[" ".join(args)] = result.stdout
        return pages

    def test_no_help_page_carries_a_release_surface_defect(self, help_pages) -> None:
        problems: list[str] = []
        for name, text in help_pages.items():
            problems.extend(findings_in(f"watch-skill {name}", text, key=""))
        assert problems == [], "\n  ".join(["the CLI help says:", *problems])

    def test_the_help_actually_said_something(self, help_pages) -> None:
        # A skipped subprocess that returned an empty string would pass the
        # rule above for the worst possible reason.
        for name, text in help_pages.items():
            assert len(text.strip()) > 40, f"{name} produced almost no output"


class TestTheDistributionsCarryNothingStale:
    @pytest.fixture(scope="class")
    @classmethod
    def built(cls, tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, Path]:
        out = tmp_path_factory.mktemp("surface-dist")
        result = subprocess.run(
            [sys.executable, "-m", "build", "--outdir", str(out)],
            cwd=REPO, capture_output=True, text=True,
        )
        if result.returncode != 0:
            pytest.skip(f"python -m build is unavailable here: {result.stderr[-400:]}")
        return next(out.glob("*.whl")), next(out.glob("*.tar.gz"))

    def test_every_document_in_the_sdist_is_clean(self, built) -> None:
        _wheel, sdist = built
        problems: list[str] = []
        checked = 0
        with tarfile.open(sdist) as archive:
            for member in archive.getmembers():
                if not member.isfile() or not member.name.endswith((".md", ".txt")):
                    continue
                relative = member.name.split("/", 1)[1]
                if relative in DETECTOR_FILES:
                    continue
                handle = archive.extractfile(member)
                assert handle is not None
                text = handle.read().decode("utf-8", errors="replace")
                problems.extend(findings_in(f"sdist:{relative}", text, key=relative))
                checked += 1
        assert checked > 30, f"only {checked} documents were read; the filter is wrong"
        assert problems == [], "\n  ".join(["the sdist ships:", *problems])

    def test_the_wheels_metadata_is_clean(self, built) -> None:
        wheel, _sdist = built
        problems: list[str] = []
        with zipfile.ZipFile(wheel) as archive:
            names = [n for n in archive.namelist() if n.endswith("METADATA")]
            assert names, "the wheel has no METADATA"
            for name in names:
                text = archive.read(name).decode("utf-8", errors="replace")
                problems.extend(findings_in(f"wheel:{name}", text, key=""))
        assert problems == [], "\n  ".join(["the wheel metadata says:", *problems])

    def test_the_project_description_is_clean(self) -> None:
        import tomllib

        pyproject = tomllib.loads((REPO / "pyproject.toml").read_text(encoding="utf-8"))
        description = pyproject["project"]["description"]
        assert findings_in("pyproject description", description, key="") == []


class TestThePositiveControls:
    """Every rule fired at text it must catch, in this engine."""

    CONTROLS = {
        "unresolved-template-token": "Watch Skill in {{AGENT_NAME}}",
        "unfinished-marker": "TODO: write the rest of this page",
        "unfinished-claim": "Desktop support is coming soon.",
        "stale-npm-scope": "npm install @watchskill/cli",
        "phantom-repository": "Clone watch-workspace and run pnpm install.",
        "personal-path": "uv --directory C:\\Users\\sam\\watch-skill run serve",
        "maintainer-drive": "The fixtures live in G:/watch-manual.",
        "unfilled-path-metavariable": "pi --skills-dir C:\\path\\to\\watch-skill",
        "obsolete-package-count": "The distribution is 17 packages.",
        "hardcoded-readiness": "4 of 12 capabilities are ready.",
        "temporary-machine-state": "Both apps are running now, so open the browser.",
    }

    def test_the_controls_cover_every_rule(self) -> None:
        assert sorted(self.CONTROLS) == sorted(rule_id for rule_id, _, _ in RULES)

    @pytest.mark.parametrize("rule_id", sorted(CONTROLS))
    def test_the_rule_catches_its_control(self, rule_id: str) -> None:
        pattern = next(p for i, p, _ in RULES if i == rule_id)
        assert pattern.search(self.CONTROLS[rule_id]), (
            f"{rule_id} does not match the text it exists for"
        )

    def test_a_clean_page_trips_nothing(self) -> None:
        clean = (
            "# Watch Skill\n\nInstall with `pip install watch-skill`. The "
            "DeepWatch distribution is 20 packages under @deepwatch. Point the "
            "CLI at <watch-skill-checkout> and run `watch-skill doctor`.\n"
        )
        assert findings_in("clean.md", clean, key="") == []
