#!/usr/bin/env sh
# Watch Skill one-command installer for macOS/Linux.
#   curl -fsSL https://raw.githubusercontent.com/oxbshw/watch-skill/main/scripts/install.sh | sh
# Installs uv (and thereby Python) if missing, clones/updates Watch Skill,
# syncs dependencies, runs the self-healing doctor, and offers to register
# the MCP server in every AI agent found on the machine.
#
# Every push runs this script end to end on ubuntu-latest and macos-latest;
# see .github/workflows/install.yml.
#
# Environment:
#   WATCHSKILL_HOME    install directory (default: $HOME/watch-skill)
#   WATCHSKILL_EXTRAS  dependency tier: standard (default) or all
#   WATCHSKILL_INSTALL_LOCAL=1  install from this checkout instead of cloning
#   WATCHSKILL_INSTALL_REF      git ref to check out after cloning

set -eu

REPO="https://github.com/oxbshw/watch-skill"
INSTALL_DIR="${WATCHSKILL_HOME:-$HOME/watch-skill}"
EXTRAS="${WATCHSKILL_EXTRAS:-standard}"

step() { printf '\n==> %s\n' "$1"; }

step "Watch Skill installer"

# --- uv (installs its own Python if none exists) ---------------------------
if ! command -v uv >/dev/null 2>&1; then
    step "Installing uv (Python package manager)"
    curl -fsSL https://astral.sh/uv/install.sh | sh
    # uv installs into ~/.local/bin (or XDG equivalent)
    PATH="$HOME/.local/bin:$PATH"
    export PATH
    if ! command -v uv >/dev/null 2>&1; then
        echo "ERROR: uv did not land on PATH — open a new shell and re-run." >&2
        exit 1
    fi
fi

# In GitHub Actions each step is a fresh shell, so a PATH we discovered here
# is lost unless it is handed over explicitly.
if [ -n "${GITHUB_PATH:-}" ]; then
    dirname -- "$(command -v uv)" >> "$GITHUB_PATH"
fi

# --- get the code -----------------------------------------------------------
if [ "${WATCHSKILL_INSTALL_LOCAL:-}" = "1" ]; then
    # CI path: exercise this checkout rather than whatever main happens to be.
    unset CDPATH  # a set CDPATH makes `cd` print and can land elsewhere
    SRC_DIR=$(cd -- "$(dirname -- "$0")/.." && pwd)
    step "Installing from local checkout $SRC_DIR"
    mkdir -p "$INSTALL_DIR"
    # shellcheck disable=SC2216  # cp -R of a dot-path copies contents, not the dir
    cp -R "$SRC_DIR/." "$INSTALL_DIR/"
elif [ -f "$INSTALL_DIR/pyproject.toml" ]; then
    step "Updating existing install at $INSTALL_DIR"
    if command -v git >/dev/null 2>&1; then
        git -C "$INSTALL_DIR" pull --ff-only || true
    fi
elif command -v git >/dev/null 2>&1; then
    step "Cloning into $INSTALL_DIR"
    git clone "$REPO" "$INSTALL_DIR"
    if [ -n "${WATCHSKILL_INSTALL_REF:-}" ]; then
        git -C "$INSTALL_DIR" checkout --detach "$WATCHSKILL_INSTALL_REF"
    fi
else
    step "git not found — downloading source tarball"
    mkdir -p "$INSTALL_DIR"
    curl -fsSL "$REPO/archive/refs/heads/main.tar.gz" | tar -xz -C "$INSTALL_DIR" --strip-components=1
fi

# --- dependencies + self-healing doctor --------------------------------------
# `standard` is frames + retrieval + MCP (~200 MB). `all` adds OCR, local
# Whisper, REST, and the browser used by THE LOOP (~600 MB). `doctor` names
# whatever is missing and prints the command that adds it, so starting small
# is safe.
step "Installing dependencies (uv sync --extra $EXTRAS)"
cd "$INSTALL_DIR"
uv sync --extra "$EXTRAS"

step "Running the doctor (checks ffmpeg / yt-dlp / deno)"
uv run watch-skill doctor || true

step "Registering Watch Skill in your AI agents"
uv run watch-skill setup --yes || true

step "Done"
cat <<EOF

If your agent was not auto-configured, paste this MCP server config. It
points at the checkout this script just made, so your local changes are what
runs:

  { "mcpServers": { "watch-skill": {
      "command": "uv",
      "args": ["--directory", "$INSTALL_DIR", "run", "watch-skill", "serve"] } } }

Not developing on it? Drop the checkout and use the published package instead:

  { "mcpServers": { "watch-skill": {
      "command": "uvx",
      "args": ["--from", "watch-skill[standard]", "watch-skill", "serve"] } } }

Per-agent guides: $INSTALL_DIR/docs/agents/README.md
Want OCR, local Whisper, and THE LOOP too?  uv sync --extra all
Try it: restart your agent and say  "watch this video: <any URL>"
EOF
