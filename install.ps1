# Watch Skill one-command installer for Windows.
#   powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/oxbshw/watch-skill/main/install.ps1 | iex"
# Installs uv (and thereby Python) if missing, clones/updates Watch Skill,
# syncs dependencies, runs the self-healing doctor, and offers to register
# the MCP server in every AI agent found on the machine.

$ErrorActionPreference = 'Stop'
$repo = 'https://github.com/oxbshw/watch-skill'
$installDir = Join-Path $env:USERPROFILE 'watch-skill'

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
    $env:Path = [Environment]::GetEnvironmentVariable('Path','User') + ';' + $env:Path
    if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
        Write-Error "uv did not land on PATH - open a new terminal and re-run this script."
    }
}

# --- get the code ----------------------------------------------------------
if (Test-Path (Join-Path $installDir 'pyproject.toml')) {
    Write-Step "Updating existing install at $installDir"
    if (Get-Command git -ErrorAction SilentlyContinue) { git -C $installDir pull --ff-only }
} elseif (Get-Command git -ErrorAction SilentlyContinue) {
    Write-Step "Cloning into $installDir"
    git clone $repo $installDir
} else {
    Write-Step "git not found - downloading source zip"
    $zip = Join-Path $env:TEMP 'watch_skill.zip'
    Invoke-WebRequest "$repo/archive/refs/heads/main.zip" -OutFile $zip
    Expand-Archive $zip -DestinationPath $env:TEMP -Force
    Move-Item (Join-Path $env:TEMP 'watch-skill-main') $installDir -Force
}

# --- dependencies + self-healing doctor ------------------------------------
Write-Step "Installing dependencies (uv sync)"
Push-Location $installDir
try {
    uv sync --extra all
    Write-Step "Running the doctor (bootstraps ffmpeg / yt-dlp / deno)"
    uv run watch-skill doctor
    Write-Step "Registering Watch Skill in your AI agents"
    uv run watch-skill setup --yes
} finally {
    Pop-Location
}

Write-Step "Done"
Write-Host @"
If your agent was not auto-configured, paste this MCP server config:

  { "mcpServers": { "watch-skill": {
      "command": "uv",
      "args": ["--directory", "$($installDir -replace '\\','\\\\')", "run", "watch-skill", "serve"] } } }

Per-agent guides: $installDir\docs\agents\README.md
Try it: restart your agent and say  "watch this video: <any URL>"
"@
