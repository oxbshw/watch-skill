#!/usr/bin/env sh
# AgentVision one-command installer for macOS/Linux.
#   curl -fsSL https://raw.githubusercontent.com/oxbshw/agentvision/main/install.sh | sh
# Installs uv (and thereby Python) if missing, clones/updates AgentVision,
# syncs dependencies, runs the self-healing doctor, and offers to register
# the MCP server in every AI agent found on the machine.
#
# STATUS: written and shellcheck-linted on Windows; community verification
# on real macOS/Linux machines is wanted — please report issues.

set -eu

REPO="https://github.com/oxbshw/agentvision"
INSTALL_DIR="${AGENTVISION_HOME:-$HOME/agentvision}"

step() { printf '\n==> %s\n' "$1"; }

step "AgentVision installer"

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

# --- get the code -----------------------------------------------------------
if [ -f "$INSTALL_DIR/pyproject.toml" ]; then
    step "Updating existing install at $INSTALL_DIR"
    if command -v git >/dev/null 2>&1; then
        git -C "$INSTALL_DIR" pull --ff-only || true
    fi
elif command -v git >/dev/null 2>&1; then
    step "Cloning into $INSTALL_DIR"
    git clone "$REPO" "$INSTALL_DIR"
else
    step "git not found — downloading source tarball"
    mkdir -p "$INSTALL_DIR"
    curl -fsSL "$REPO/archive/refs/heads/main.tar.gz" | tar -xz -C "$INSTALL_DIR" --strip-components=1
fi

# --- dependencies + self-healing doctor --------------------------------------
step "Installing dependencies (uv sync)"
cd "$INSTALL_DIR"
uv sync --all-extras

step "Running the doctor (checks ffmpeg / yt-dlp / deno)"
uv run agentvision doctor || true

step "Registering AgentVision in your AI agents"
uv run agentvision setup --yes || true

step "Done"
cat <<EOF

If your agent was not auto-configured, paste this MCP server config:

  { "mcpServers": { "agentvision": {
      "command": "uv",
      "args": ["--directory", "$INSTALL_DIR", "run", "agentvision", "serve"] } } }

Per-agent guides: $INSTALL_DIR/docs/agents/README.md
Try it: restart your agent and say  "watch this video: <any URL>"
EOF
