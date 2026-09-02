"""What the published artifacts may and may not contain.

The source distribution shipped 899 files, and 332 of them were `workspace/` —
DeepWatch, which has its own release, and inside it a script-managed checkout
of DeepSeek Harness that git does not track at all. Nobody decided that.
Hatchling walks the filesystem, the include list did not say otherwise, and an
untracked vendored third party was being published inside Watch Core's sdist.

Nothing in a diff shows that. An sdist is built, not committed, so the only
place this can be caught is a test that builds one and reads it.

The build is slow, so it happens once for the whole module and both artifacts
are inspected from the same run.
"""
from __future__ import annotations

import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]

#: Top-level entries the source distribution is meant to carry.
#:
#: Asserted as an exact set rather than a floor: the defect this file exists
#: for was an *extra* directory nobody noticed, so "these and no others" is the
#: only assertion that would have caught it.
EXPECTED_SDIST_TOP_LEVEL = {
    "PKG-INFO",
    "pyproject.toml",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "llms.txt",
    ".gitignore",
    "src",
    "docs",
    "examples",
    "skills",
    "templates",
    "commands",
    "app",
    "scripts",
}


@pytest.fixture(scope="module")
def built(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, Path]:
    """Build the wheel and sdist once, and hand back both paths."""
    out = tmp_path_factory.mktemp("dist")
    result = subprocess.run(
        [sys.executable, "-m", "build", "--outdir", str(out)],
        cwd=REPO, capture_output=True, text=True,
    )
    if result.returncode != 0:
        pytest.skip(f"python -m build is unavailable here: {result.stderr[-400:]}")
    return next(out.glob("*.whl")), next(out.glob("*.tar.gz"))


def sdist_names(sdist: Path) -> list[str]:
    with tarfile.open(sdist) as archive:
        return [member.name for member in archive.getmembers() if member.isfile()]


def top_level(names: list[str]) -> set[str]:
    """The entries directly under the sdist's version directory."""
    found = set()
    for name in names:
        parts = Path(name).parts
        if len(parts) > 1:
            found.add(parts[1])
    return found


class TestSdist:
    def test_ships_exactly_the_intended_top_level(self, built) -> None:
        _wheel, sdist = built
        found = top_level(sdist_names(sdist))
        assert found == EXPECTED_SDIST_TOP_LEVEL, (
            "the sdist's top level drifted; update EXPECTED_SDIST_TOP_LEVEL and "
            "the policy comment in pyproject.toml together, or fix the include list"
        )

    def test_carries_no_second_product(self, built) -> None:
        """DeepWatch has its own release and does not belong in this one.

        Matched at the *top level*, not anywhere in the path:
        ``docs/assets/workspace/*.png`` are screenshots of the workspace
        feature and are documentation this package ships on purpose.
        """
        _wheel, sdist = built
        offenders = [
            name for name in sdist_names(sdist)
            if len(Path(name).parts) > 1 and Path(name).parts[1] == "workspace"
        ]
        assert offenders == []

    def test_carries_no_vendored_upstream(self, built) -> None:
        """`upstream/deepseek-harness` is somebody else's source, untracked here."""
        _wheel, sdist = built
        assert [n for n in sdist_names(sdist) if "/upstream/" in n] == []

    def test_carries_no_test_suite(self, built) -> None:
        """The suite holds credential-shaped fixtures; publishing them helps nobody."""
        _wheel, sdist = built
        assert [n for n in sdist_names(sdist) if "/tests/" in n] == []

    def test_carries_no_build_output_or_runtime_state(self, built) -> None:
        _wheel, sdist = built
        names = sdist_names(sdist)
        for pattern, why in [
            (".tgz", "a packed npm artifact"),
            (".log", "a log file"),
            ("dsh-home", "a profile"),
            ("node_modules", "an installed dependency tree"),
        ]:
            assert [n for n in names if pattern in n] == [], f"the sdist carries {why}"

    def test_the_repository_agents_md_is_not_shipped(self, built) -> None:
        """This repository's contributor guidance is not product content.

        `AGENTS.md` at the root is instructions for people working *on* Watch
        Skill. A copy of it inside a source distribution reads, to a tool that
        looks for one, as instructions for the project that installed the
        package -- which is how a governance file becomes somebody else's
        agent policy by accident.
        """
        _wheel, sdist = built
        prefix = sdist.name.removesuffix(".tar.gz")
        assert f"{prefix}/AGENTS.md" not in sdist_names(sdist)

    def test_the_agent_template_ships_and_says_it_is_one(self, built) -> None:
        """The template a user copies into their own project is product content.

        It ships under `.example.md`, which is what keeps a tool that scans for
        `AGENTS.md` from finding it, and the file says in its first lines that
        it is copied into a project rather than obeyed where it sits.
        """
        _wheel, sdist = built
        prefix = sdist.name.removesuffix(".tar.gz")
        name = f"{prefix}/templates/agent-integration/AGENTS.example.md"
        names = sdist_names(sdist)
        assert name in names

        with tarfile.open(sdist) as archive:
            member = archive.extractfile(name)
            assert member is not None
            text = member.read().decode("utf-8")
        head = "\n".join(text.splitlines()[:12])
        assert "Copy this file" in head
        assert "not this repository" in head

        # And nothing else in the distribution is named AGENTS.md.
        assert [n for n in names if n.endswith("/AGENTS.md")] == []


class TestWheel:
    def test_ships_the_package_and_nothing_around_it(self, built) -> None:
        wheel, _sdist = built
        names = zipfile.ZipFile(wheel).namelist()
        stray = [
            n for n in names
            if not n.startswith("watch_skill/") and not n.startswith("watch_skill-")
        ]
        assert stray == [], f"the wheel carries files outside the package: {stray[:5]}"

    def test_ships_the_bridge_surface(self, built) -> None:
        """The surface DeepWatch spawns must be in the artifact it installs."""
        wheel, _sdist = built
        names = zipfile.ZipFile(wheel).namelist()
        bridge = sorted(n for n in names if "surfaces/bridge/" in n)
        assert len(bridge) >= 8, bridge
        assert "watch_skill/surfaces/bridge/server.py" in bridge

    def test_declares_the_cli_entry_point(self, built) -> None:
        wheel, _sdist = built
        archive = zipfile.ZipFile(wheel)
        entry = next(n for n in archive.namelist() if n.endswith("entry_points.txt"))
        assert "watch-skill" in archive.read(entry).decode()

    def test_carries_no_agents_md_or_tests(self, built) -> None:
        wheel, _sdist = built
        names = zipfile.ZipFile(wheel).namelist()
        assert [n for n in names if n.endswith("AGENTS.md")] == []
        assert [n for n in names if "/tests/" in n] == []
