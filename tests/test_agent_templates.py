"""The contributor templates live where their names say they do.

Two paths were misleading in a way that cost a reader time and could cost an
agent more than that.

``adapters/agents-md/`` sat beside ``src/watch_skill/integrations/``, which is
where the real framework adapters are. Nothing in ``adapters/`` was executable
-- it held one Markdown file -- so the directory named a category of code that
was not there.

And the file inside it was called ``AGENTS.md``. That name is a convention: a
coding agent that finds one treats it as instructions for the repository it is
standing in. This one is a template *for somebody else's project*, and it
shipped in the source distribution, where a tool scanning an installed package
would read a Watch Skill usage guide as its host project's policy. Renaming it
``AGENTS.example.md`` is what makes the two unmistakable.

This file holds the migration so it cannot be half-undone: a stale link, a
resurrected directory, or a page copied from the template and merged with the
holes still in it.
"""

from __future__ import annotations

import importlib.util
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]

MOVED = {
    "adapters/agents-md/AGENTS.md": "templates/agent-integration/AGENTS.example.md",
    "templates/agent-adapter/README.md": "templates/agent-integration/README.md",
    "templates/agent-adapter/docs-skeleton.md": (
        "templates/agent-integration/agent-docs.template.md"
    ),
    "templates/agent-adapter/validate.py": "scripts/validate_agent_docs.py",
}

# Every spelling of the old locations, including the directories themselves.
STALE = ["adapters/agents-md", "templates/agent-adapter", "docs-skeleton.md"]

# The changelog records what past releases did, under the paths those releases
# had. Rewriting history to match today's tree would make it useless as
# history. It is exempt by name, and by name only.
STALE_EXEMPT = {"CHANGELOG.md"}


def load_validator(name: str = "agent_validate"):
    """Import the validator from its path, the way a contributor runs it."""
    spec = importlib.util.spec_from_file_location(
        name, ROOT / "scripts" / "validate_agent_docs.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def validator():
    return load_validator()


def tracked() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True
    )
    return [line.strip() for line in out.stdout.splitlines() if line.strip()]


class TestTheMigrationHappened:
    def test_every_new_path_exists(self) -> None:
        for old, new in MOVED.items():
            assert (ROOT / new).is_file(), f"{old} was moved to {new}, which is not there"

    def test_no_old_path_is_still_tracked(self) -> None:
        files = tracked()
        for old in MOVED:
            assert old not in files, f"{old} is still tracked; the move did not happen"

    def test_the_adapters_directory_is_gone(self) -> None:
        """It named executable code and held one Markdown file."""
        assert not (ROOT / "adapters").exists()
        assert [f for f in tracked() if f.startswith("adapters/")] == []


class TestNothingStillPointsAtTheOldPaths:
    def test_no_tracked_file_mentions_a_stale_path(self) -> None:
        offenders: list[str] = []
        for relative in tracked():
            if relative in STALE_EXEMPT:
                continue
            path = ROOT / relative
            if not path.is_file() or path.suffix in {".png", ".jpg", ".gz", ".pyc"}:
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            # This file names the old paths on purpose, to detect them.
            if relative == "tests/test_agent_templates.py":
                continue
            for stale in STALE:
                if stale in text:
                    line = text[: text.index(stale)].count("\n") + 1
                    offenders.append(f"{relative}:{line} still names {stale}")
        assert offenders == [], "\n  ".join(["stale paths survive the move:", *offenders])

    def test_the_positive_control_would_catch_one(self) -> None:
        """The rule is only worth having if it fails on the text it targets."""
        sample = "see [the template](templates/agent-adapter/README.md) for more"
        assert any(stale in sample for stale in STALE)


class TestTheValidatorWorksFromItsNewHome:
    def test_it_resolves_the_repository_root(self, validator) -> None:
        """`parents[2]` was right two directories ago and is wrong now."""
        assert validator.ROOT == ROOT
        assert (validator.ROOT / "docs" / "agents").is_dir()

    def test_it_sweeps_the_agent_pages_by_default(self, validator) -> None:
        assert validator.main([]) == 0

    def test_the_template_may_carry_its_own_holes(self, validator) -> None:
        assert validator.main([str(validator.TEMPLATE)]) == 0


class TestGeneratedPagesCarryNoHoles:
    def test_no_agent_page_has_an_unresolved_token(self) -> None:
        token = re.compile(r"\{\{[A-Z][A-Z0-9_]*\}\}")
        for page in sorted((ROOT / "docs" / "agents").glob("*.md")):
            found = token.findall(page.read_text(encoding="utf-8"))
            assert found == [], f"{page.name} still carries {found}"

    def test_the_old_placeholder_spelling_is_gone(self) -> None:
        """`YOUR-AGENT` read enough like prose to survive review."""
        for page in sorted((ROOT / "docs" / "agents").glob("*.md")):
            assert "YOUR-AGENT" not in page.read_text(encoding="utf-8")

    def test_a_copy_of_the_template_fails_the_gate(self, tmp_path: Path) -> None:
        """The whole point of the syntax: a half-filled page is detectable."""
        module = load_validator("agent_validate_control")
        template = ROOT / "templates" / "agent-integration" / "agent-docs.template.md"
        copied = tmp_path / "some-agent.md"
        copied.write_text(template.read_text(encoding="utf-8"), encoding="utf-8")
        assert module.main([str(copied)]) > 0


class TestTheExampleSaysWhatItIs:
    def test_it_declares_itself_a_template_in_its_first_lines(self) -> None:
        head = "\n".join(
            (ROOT / "templates" / "agent-integration" / "AGENTS.example.md")
            .read_text(encoding="utf-8")
            .splitlines()[:12]
        )
        assert "Copy this file" in head
        assert "not this repository" in head

    def test_the_repository_guide_is_a_different_file(self) -> None:
        """Root `AGENTS.md` is governance; the example is product content."""
        assert (ROOT / "AGENTS.md").is_file()
        assert (ROOT / "templates" / "agent-integration" / "AGENTS.example.md").is_file()

    def test_nothing_else_in_the_tree_is_named_agents_md(self) -> None:
        named = [f for f in tracked() if Path(f).name == "AGENTS.md"]
        assert named == ["AGENTS.md"], (
            f"a second AGENTS.md would be read as policy where it sits: {named}"
        )
