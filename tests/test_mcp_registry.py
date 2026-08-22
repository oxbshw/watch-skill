"""`server.json` is release metadata, so it has to track the release.

The MCP Registry resolves the entry to a real PyPI package at a real version.
A version that drifts from `pyproject.toml` publishes a pointer to something
that does not exist, and the failure surfaces to whoever tries to install the
server rather than to us.

Schema validation runs offline against a committed copy of the official
schema. Fetching it during a test run would make the suite depend on the
network, and pinning the copy is also what makes a schema change something a
person reviews rather than something that breaks CI one morning.
"""
from __future__ import annotations

import json
import tomllib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SERVER_JSON = ROOT / "server.json"
SCHEMA = ROOT / "schemas" / "mcp-server.schema.json"


def _server() -> dict:
    return json.loads(SERVER_JSON.read_text(encoding="utf-8"))


def _project_version() -> str:
    data = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    return data["project"]["version"]


def test_server_json_matches_the_official_schema() -> None:
    jsonschema = pytest.importorskip("jsonschema")
    jsonschema.validate(_server(), json.loads(SCHEMA.read_text(encoding="utf-8")))


def test_the_declared_versions_track_the_release() -> None:
    """Registry, top-level and package versions are one version, not three."""
    server = _server()
    version = _project_version()
    assert server["version"] == version, (
        f"server.json says {server['version']}, pyproject says {version}")
    for package in server["packages"]:
        assert package["version"] == version, (
            f"{package['identifier']} pinned at {package['version']}, "
            f"pyproject says {version}")


def test_the_package_it_points_at_is_the_one_that_is_published() -> None:
    (package,) = _server()["packages"]
    assert package["registryType"] == "pypi"
    assert package["identifier"] == "watch-skill"
    assert package["transport"]["type"] == "stdio"


def test_the_command_it_advertises_actually_starts_the_server() -> None:
    """The arguments have to name a real CLI command and a real extra.

    A registry entry is an install instruction. If it resolves to a command
    the CLI does not have, the first thing a new user sees is a traceback.
    """
    import typer.main

    from watch_skill.surfaces.cli.main import app

    (package,) = _server()["packages"]
    positional = [a["value"] for a in package.get("packageArguments", [])
                  if a["type"] == "positional"]
    assert positional, "no command is passed to the entry point"

    commands = typer.main.get_command(app).commands
    assert positional[0] in commands, (
        f"server.json starts `{positional[0]}`, which is not a CLI command")

    extras = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    declared = extras["project"]["optional-dependencies"]
    for argument in package.get("runtimeArguments", []):
        if argument.get("name") == "--from":
            value = argument["value"]
            assert value.startswith("watch-skill["), value
            extra = value.split("[", 1)[1].rstrip("]")
            assert extra in declared, (
                f"server.json installs the `{extra}` extra, which pyproject "
                f"does not declare")


def test_the_readme_carries_the_pypi_ownership_marker() -> None:
    """PyPI ownership is proved by a marker in the package description.

    The README becomes that description at build time, so the marker has to
    live here and survive the rewrite. The registry requires the token to be
    followed by a boundary, which the comment close provides.
    """
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    marker = f"<!-- mcp-name: {_server()['name']} -->"
    assert marker in readme, (
        f"README.md must contain {marker!r} for PyPI ownership verification")
