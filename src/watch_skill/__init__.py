"""Watch Skill — give any agent a video input.

Core engine: acquisition, perception, transcription, indexing, vision, and
the autonomous watch-critique-iterate loop. Surfaces (MCP, CLI, REST) are
thin wrappers around this package and live outside it.
"""

from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _pkg_version

# Read the version from installed metadata instead of restating it here.
# v1.0.0 shipped reporting "0.6.0" because the release bumped every manifest
# and missed this line; deriving it removes the chance of a second drift.
try:
    __version__ = _pkg_version("watch-skill")
except PackageNotFoundError:  # running from a source tree with no install
    __version__ = "0.0.0+unknown"

__all__ = ["__version__"]
