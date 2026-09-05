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
EXEMPT = {(entry["file"], entry["rule"]) for entry in CONFIG["exemptions"]}

#: Text that is fine in source and not fine in something a user is handed.
#:
#: `phantom-repository` and `stale-npm-scope` are checked against the *detectors*
#: that exist for them, so they are exempt where the detector lives. Everything
#: else applies everywhere on this surface.
DETECTOR_FILES = {"scripts/secret_scan.py", "scripts/validate_agent_docs.py"}


def findings_in(label: str, text: str, key: str | None = None) -> list[str]:
    found = []
    for rule_id, pattern, why in RULES:
        if ((key or label), rule_id) in EXEMPT:
            continue
        for number, line in enumerate(text.splitlines(), start=1):
            match = pattern.search(line)
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

    def test_the_patterns_compile_the_same_way_in_both_engines(self) -> None:
        """A JS-only construct in the table would silently never match here."""
        for rule_id, pattern, _why in RULES:
            assert "(?<" not in pattern.pattern, (
                f"{rule_id} uses a lookbehind; keep the table to syntax both "
                "engines read the same way"
            )


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
