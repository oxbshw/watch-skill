# AgentVision one-command installer for Windows.
#   powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/agentvision/agentvision/main/install.ps1 | iex"
# Installs uv (and thereby Python) if missing, clones/updates AgentVision,
# syncs dependencies, runs the self-healing doctor, and offers to register
# the MCP server in every AI agent found on the machine.

$ErrorActionPreference = 'Stop'
$repo = 'https://github.com/agentvision/agentvision'
$installDir = Join-Path $env:USERPROFILE 'agentvision'

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

Write-Step "AgentVision installer"

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
    $zip = Join-Path $env:TEMP 'agentvision.zip'
    Invoke-WebRequest "$repo/archive/refs/heads/main.zip" -OutFile $zip
    Expand-Archive $zip -DestinationPath $env:TEMP -Force
    Move-Item (Join-Path $env:TEMP 'agentvision-main') $installDir -Force
}

# --- dependencies + self-healing doctor ------------------------------------
Write-Step "Installing dependencies (uv sync)"
Push-Location $installDir
try {
    uv sync --all-extras
    Write-Step "Running the doctor (bootstraps ffmpeg / yt-dlp / deno)"
    uv run agentvision doctor
    Write-Step "Registering AgentVision in your AI agents"
    uv run agentvision setup --yes
} finally {
    Pop-Location
}

Write-Step "Done"
Write-Host @"
If your agent was not auto-configured, paste this MCP server config:

  { "mcpServers": { "agentvision": {
      "command": "uv",
      "args": ["--directory", "$($installDir -replace '\\','\\\\')", "run", "agentvision", "serve"] } } }

Per-agent guides: $installDir\docs\agents\README.md
Try it: restart your agent and say  "watch this video: <any URL>"
"@
