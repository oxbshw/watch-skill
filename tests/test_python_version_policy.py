"""`.python-version` is the compatibility floor, and four files have to agree.

The file says ``3.11`` while Python 3.13 exists, which looks like neglect and
is not. It is the oldest interpreter this project supports, and developing on
it is what makes a 3.12-only call fail on the machine that wrote it instead of
in a matrix job twenty minutes later.

That only works while four things say the same thing: the floor file, the
``requires-python`` lower bound, the classifiers, and the versions CI actually
executes. Each has drifted from the others in a released project before —
3.13 was advertised in the classifiers and never run — and each drift is
invisible from inside any one of them.

So this is the gate that holds them together, and the reason raising the
minimum is a deliberate act rather than an edit to one file.
"""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"

PYPROJECT = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
PROJECT = PYPROJECT["project"]


def version_tuple(text: str) -> tuple[int, ...]:
    return tuple(int(part) for part in text.strip().split("."))


def classifier_versions() -> list[str]:
    found = []
    for classifier in PROJECT["classifiers"]:
        match = re.fullmatch(r"Programming Language :: Python :: (\d+\.\d+)", classifier)
        if match:
            found.append(match.group(1))
    return sorted(found, key=version_tuple)


def workflow(name: str) -> dict:
    return yaml.safe_load((WORKFLOWS / name).read_text(encoding="utf-8"))


class TestTheFloorIsTheFloor:
    def test_the_pinned_interpreter_is_the_minimum_supported_one(self) -> None:
        pinned = (ROOT / ".python-version").read_text(encoding="utf-8").strip()
        assert pinned == classifier_versions()[0], (
            "`.python-version` is the compatibility floor. If this is failing "
            "because the minimum moved, move requires-python, the classifiers, "
            "the CI matrix and the CONTRIBUTING paragraph with it."
        )

    def test_requires_python_names_that_same_minimum(self) -> None:
        bound = re.fullmatch(r">=\s*(\d+\.\d+)", PROJECT["requires-python"].strip())
        assert bound is not None, (
            f"requires-python is {PROJECT['requires-python']!r}; this gate reads a "
            "simple >= lower bound and should be taught the new shape deliberately"
        )
        assert bound.group(1) == classifier_versions()[0]

    def test_the_pin_is_a_bare_version_a_tool_can_read(self) -> None:
        # uv, pyenv and rye all read this file. A comment or a range in it is
        # read as the version by at least one of them.
        raw = (ROOT / ".python-version").read_text(encoding="utf-8")
        assert re.fullmatch(r"\d+\.\d+\s*", raw), f"unreadable pin: {raw!r}"


class TestEveryAdvertisedVersionIsExecuted:
    def test_the_matrix_runs_all_of_them(self) -> None:
        """3.13 was in the classifiers and in no job, for a whole release."""
        matrix = workflow("ci.yml")["jobs"]["test"]["strategy"]["matrix"]["python"]
        assert sorted(str(v) for v in matrix) == classifier_versions(), (
            "the classifiers advertise a version CI does not run, which is the "
            "same unverified claim as a documented-but-untested integration"
        )

    def test_the_matrix_covers_more_than_one_operating_system(self) -> None:
        matrix = workflow("ci.yml")["jobs"]["test"]["strategy"]["matrix"]["os"]
        assert len(matrix) >= 2, f"one OS is not a matrix: {matrix}"


class TestReleaseBuildsUseASupportedInterpreter:
    @pytest.mark.parametrize(
        "name", ["release.yml", "install.yml", "integration.yml"]
    )
    def test_the_workflow_pins_a_supported_version(self, name: str) -> None:
        text = (WORKFLOWS / name).read_text(encoding="utf-8")
        pinned = re.findall(r'python-version:\s*["\']?(\d+\.\d+)["\']?', text)
        assert pinned, f"{name} sets up Python without naming a version"
        for version in pinned:
            assert version in classifier_versions(), (
                f"{name} builds on Python {version}, which this project does not "
                "claim to support"
            )


class TestNoDocumentSaysThreeElevenIsTheOnlyOne:
    # Phrasings that would tell a reader on 3.13 that they cannot use this.
    #
    # Regexes rather than substrings, because the first version of this list
    # was substrings and its own positive control walked straight past it:
    # `requires Python 3.11.` did not match `requires Python 3.11 and will
    # not run on newer`. A detector that only catches the sentence you
    # happened to imagine is not a detector.
    MISLEADING = [
        re.compile(r"Python 3\.11 only"),
        re.compile(r"only Python 3\.11"),
        re.compile(r"requires Python 3\.11(?!\+)"),
        re.compile(r"Python 3\.11 is required"),
        re.compile(r"must use Python 3\.11"),
        re.compile(r"Python 3\.11(?!\+)[^.\n]*will not run"),
    ]

    # Where a reader looks to find out what they need. Each must state the
    # range rather than the pin.
    STATES_SUPPORT = ["README.md", "CONTRIBUTING.md"]

    def test_no_current_document_narrows_the_supported_set(self) -> None:
        offenders = []
        for path in [*ROOT.glob("*.md"), *(ROOT / "docs").rglob("*.md")]:
            text = path.read_text(encoding="utf-8")
            for phrase in self.MISLEADING:
                found = phrase.search(text)
                if found:
                    offenders.append(f"{path.relative_to(ROOT)}: {found.group(0)!r}")
        assert offenders == [], "\n  ".join(["these say 3.11 is the only one:", *offenders])

    @pytest.mark.parametrize("relative", STATES_SUPPORT)
    def test_the_documents_that_state_support_state_the_range(self, relative: str) -> None:
        text = (ROOT / relative).read_text(encoding="utf-8")
        newest = classifier_versions()[-1]
        assert f"3.{newest.split('.')[1]}" in text or "3.11+" in text, (
            f"{relative} never tells a reader that {newest} is supported"
        )

    def test_contributing_explains_why_the_pin_is_the_oldest(self) -> None:
        text = (ROOT / "CONTRIBUTING.md").read_text(encoding="utf-8")
        assert ".python-version" in text
        assert "compatibility floor" in text, (
            "without the reason, the next reader 'fixes' the pin to the newest "
            "version and the floor stops being tested by anybody"
        )

    def test_the_positive_control(self) -> None:
        sample = "This project requires Python 3.11 and will not run on newer."
        assert any(phrase.search(sample) for phrase in self.MISLEADING)

    def test_the_control_does_not_fire_on_the_correct_phrasing(self) -> None:
        fine = "Watch Skill supports Python 3.11, 3.12 and 3.13; requires Python 3.11+."
        assert [p.pattern for p in self.MISLEADING if p.search(fine)] == []
