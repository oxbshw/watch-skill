# Watch Skill one-command installer for Windows.
#   powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/oxbshw/watch-skill/main/scripts/install.ps1 | iex"
# Installs uv (and thereby Python) if missing, clones/updates Watch Skill,
# syncs dependencies, runs the self-healing doctor, and offers to register
# the MCP server in every AI agent found on the machine.
#
# Every push runs this script end to end on windows-latest; see
# .github/workflows/install.yml.
#
# Environment:
#   WATCHSKILL_HOME    install directory (default: $env:USERPROFILE\watch-skill)
#   WATCHSKILL_EXTRAS  dependency tier: standard (default) or all
#   WATCHSKILL_INSTALL_LOCAL=1  install from this checkout instead of cloning
#   WATCHSKILL_INSTALL_REF      git ref to check out after cloning

$ErrorActionPreference = 'Stop'
$repo = 'https://github.com/oxbshw/watch-skill'
$installDir = if ($env:WATCHSKILL_HOME) { $env:WATCHSKILL_HOME } else { Join-Path $env:USERPROFILE 'watch-skill' }
$extras = if ($env:WATCHSKILL_EXTRAS) { $env:WATCHSKILL_EXTRAS } else { 'standard' }

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

Write-Step "Watch Skill installer"

# --- uv (installs its own Python if none exists) -------------------------
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Write-Step "Installing uv (Python package manager)"
    try {
        winget install --id astral-sh.uv --accept-source-agreements --accept-package-agreements --silent
    } catch {
        Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression
    }
    # The uv installer writes the user PATH, which this already-running
    # process cannot see; pull it in, and add the default location in case
    # the installer used a fallback that has not registered yet.
    $env:Path = [Environment]::GetEnvironmentVariable('Path','User') + ';' +
                (Join-Path $env:USERPROFILE '.local\bin') + ';' + $env:Path
    if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
        Write-Error "uv did not land on PATH - open a new terminal and re-run this script."
    }
}

# In GitHub Actions each step is a fresh shell, so a PATH we discovered here
# is lost unless it is handed over explicitly.
if ($env:GITHUB_PATH) {
    $uvDir = Split-Path (Get-Command uv).Source
    Add-Content -Path $env:GITHUB_PATH -Value $uvDir -Encoding utf8
}

# --- get the code ----------------------------------------------------------
if ($env:WATCHSKILL_INSTALL_LOCAL -eq '1') {
    # CI path: exercise this checkout rather than whatever main happens to be.
    $srcDir = Split-Path -Parent $PSScriptRoot
    Write-Step "Installing from local checkout $srcDir"
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    Copy-Item -Path (Join-Path $srcDir '*') -Destination $installDir -Recurse -Force
} elseif (Test-Path (Join-Path $installDir 'pyproject.toml')) {
    Write-Step "Updating existing install at $installDir"
    if (Get-Command git -ErrorAction SilentlyContinue) { git -C $installDir pull --ff-only }
} elseif (Get-Command git -ErrorAction SilentlyContinue) {
    Write-Step "Cloning into $installDir"
    git clone $repo $installDir
    if ($env:WATCHSKILL_INSTALL_REF) { git -C $installDir checkout --detach $env:WATCHSKILL_INSTALL_REF }
} else {
    Write-Step "git not found - downloading source zip"
    $zip = Join-Path $env:TEMP 'watch_skill.zip'
    Invoke-WebRequest "$repo/archive/refs/heads/main.zip" -OutFile $zip
    Expand-Archive $zip -DestinationPath $env:TEMP -Force
    Move-Item (Join-Path $env:TEMP 'watch-skill-main') $installDir -Force
}

# --- dependencies + self-healing doctor ------------------------------------
# `standard` is frames + retrieval + MCP (~200 MB). `all` adds OCR, local
# Whisper, REST, and the browser used by THE LOOP (~600 MB). `doctor` names
# whatever is missing and prints the command that adds it.
Write-Step "Installing dependencies (uv sync --extra $extras)"
Push-Location $installDir
try {
    uv sync --extra $extras
    Write-Step "Running the doctor (bootstraps ffmpeg / yt-dlp / deno)"
    uv run watch-skill doctor
    Write-Step "Registering Watch Skill in your AI agents"
    uv run watch-skill setup --yes
} finally {
    Pop-Location
}

Write-Step "Done"
Write-Host @"
If your agent was not auto-configured, paste this MCP server config. It
points at the checkout this script just made, so your local changes are what
runs:

  { "mcpServers": { "watch-skill": {
      "command": "uv",
      "args": ["--directory", "$($installDir -replace '\\','\\\\')", "run", "watch-skill", "serve"] } } }

Not developing on it? Drop the checkout and use the published package instead:

  { "mcpServers": { "watch-skill": {
      "command": "uvx",
      "args": ["--from", "watch-skill[standard]", "watch-skill", "serve"] } } }

Per-agent guides: $installDir\docs\agents\README.md
Want OCR, local Whisper, and THE LOOP too?  uv sync --extra all
Try it: restart your agent and say  "watch this video: <any URL>"
"@
