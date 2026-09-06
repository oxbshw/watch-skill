"""The one resolved workspace root Core shares with the Host.

A real owner session wrote ``owner-test/totals.json`` correctly and then could
not verify it, because three layers each answered "which directory is this
relative path in?" from a different place. The Harness derived its session
workspace from the host process's invoking directory; Watch Core was spawned
with an empty ``cwd`` and inherited whatever the Host had; and the Bridge's
verification surface, handed no ``workingDir``, fell back to ``Path(".")`` —
the Core process's own cwd, which was neither of the other two.

The verifier then behaved honestly and uselessly: the file was outside every
root it was allowed to look in, so the answer was ``INCONCLUSIVE``.

The fix is not a wider verifier. It is one canonical workspace, established by
the launcher and carried to Core in :data:`WORKSPACE_ENV`, so the filesystem
tools, shell containment, Watch policy, the verifier, the evidence resolver and
receipts all resolve a relative path in the same directory.

**Fail closed.** :func:`require_workspace` raises rather than inventing a root.
A layer that cannot say where it is must stop and say so, because the
alternative is what shipped: a silent default that looked like it worked.

This module is about *where the workspace is*. :mod:`watch_skill.workspace` is
about what a workspace UI draws; the two do not overlap.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path, PurePath

WORKSPACE_ENV = "DEEPWATCH_WORKSPACE"
"""Environment variable naming the canonical workspace for a composed run.

Written by ``deepwatch web`` / ``deepwatch desktop`` and read here. The name is
spelled in three places — this module, ``@deepwatch/cli`` and
``@deepwatch/dsh-contracts`` — and a test on each side holds them together."""


class WorkspaceNotEstablished(Exception):
    """No canonical workspace, and nothing may guess one.

    Carries the fix rather than only the fact, because this is raised at the
    boundary where somebody can still act on it.
    """

    fix = (
        "Start DeepWatch with `deepwatch web --workspace <dir>`, or set "
        f"{WORKSPACE_ENV} to an absolute path, so the agent's tools, Watch "
        "containment and the verifier all resolve relative paths in one place."
    )

    def __init__(self, where: str) -> None:
        super().__init__(
            f"{where} needs the canonical workspace and none was established."
        )
        self.where = where


class WorkspaceEscape(Exception):
    """A relative path that would land outside the canonical workspace."""

    def __init__(self, attempted: str) -> None:
        super().__init__(
            f"{attempted!r} resolves outside the workspace. Paths handed to the "
            "agent, the shell and the verifier are workspace-relative by "
            "contract; nothing outside it is reachable by relative path."
        )
        self.attempted = attempted


def workspace_from_environment(env: Mapping[str, str] | None = None) -> Path | None:
    """The canonical workspace this process was launched with, if any.

    Returns ``None`` rather than raising, so a caller can tell "nobody said"
    apart from "somebody said something unusable" and report the right one. A
    relative value is refused outright: it was written by whoever composed the
    environment, and resolving it against *this* process's cwd would
    reintroduce the ambiguity this module exists to remove.

    ``resolve()`` follows symlinks and Windows junctions, which is what makes
    the result canonical rather than merely absolute — a containment check
    comparing an unresolved spelling against a resolved one reports a file
    outside a workspace it is plainly inside.
    """
    source: Mapping[str, str] = os.environ if env is None else env
    named = source.get(WORKSPACE_ENV)
    if not named:
        return None
    if not PurePath(named).is_absolute():
        return None
    candidate = Path(named)
    if not candidate.is_dir():
        return None
    return candidate.resolve()


def require_workspace(where: str, explicit: str | Path | None = None) -> Path:
    """The workspace to work in, or a refusal naming what to do about it.

    ``explicit`` wins when a caller was given one — a request that names its
    own ``workingDir`` is stating intent, and honouring it is what lets a Host
    verify a directory other than the one Core happens to sit in. Everything
    else comes from the launcher's canonical value. Nothing comes from
    ``Path(".")``.

    :raises WorkspaceNotEstablished: when neither source has an answer.
    """
    if explicit is not None and str(explicit) != "":
        return Path(explicit).resolve()
    inherited = workspace_from_environment()
    if inherited is None:
        raise WorkspaceNotEstablished(where)
    return inherited


def inside_workspace(root: Path, candidate: Path) -> bool:
    """Whether a path lands inside the workspace once traversal is resolved.

    The containment question, asked the way a boundary must ask it: before the
    side effect, and on the resolved path rather than on its spelling.
    """
    try:
        candidate.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return True


def resolve_in_workspace(root: Path, relative: str) -> Path:
    """An absolute path for a workspace-relative one, or a refusal.

    The single resolution every layer routes through. ``..`` is resolved
    *before* the containment test, so ``../elsewhere/notes.md`` is refused
    rather than quietly landing a directory up — the check a literal prefix
    comparison gets wrong.

    An already-absolute input is accepted only when it is inside the workspace,
    which stops a caller smuggling an outside path through a parameter
    documented as relative.
    """
    base = root.resolve()
    candidate = Path(relative)
    joined = (candidate if candidate.is_absolute() else base / candidate).resolve()
    if not inside_workspace(base, joined):
        raise WorkspaceEscape(relative)
    return joined


def workspace_relative(root: Path, candidate: Path) -> str | None:
    """The workspace-relative, forward-slashed spelling of a path.

    What a receipt, a Library row and a verification request should carry, so
    one file is one string everywhere and no machine's directory names ride
    along. Returns ``None`` when the path is outside, so a caller cannot treat
    a failed conversion as a success and emit an absolute path.
    """
    try:
        relative = candidate.resolve().relative_to(root.resolve())
    except ValueError:
        return None
    return relative.as_posix() if relative.parts else "."
