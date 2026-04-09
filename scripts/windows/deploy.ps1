[CmdletBinding()]
param(
  [string]$RepoUrl = "https://github.com/hannnibal/ai-chat",
  [string]$Branch = "main",
  [string]$InstallDir = "C:\baileys-adapter",
  [string]$NodeVersion = "20",
  [string]$ChatwootBaseUrl = "",
  [string]$ChatwootApiToken = "",
  [string]$ChatwootAccountId = "",
  [string]$AiMiddlewareUrl = "",
  [string]$AiMiddlewareToken = "",
  [switch]$ForceEnvUpdate
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Test-CommandExists([string]$CommandName) {
  return $null -ne (Get-Command $CommandName -ErrorAction SilentlyContinue)
}

function Ensure-Winget {
  if (-not (Test-CommandExists "winget")) {
    throw "winget is not available. Please install App Installer from Microsoft Store first."
  }
}

function Install-WithWinget([string]$Id, [string]$DisplayName) {
  Write-Step "Installing $DisplayName"
  winget install --id $Id --exact --accept-source-agreements --accept-package-agreements
}

function Ensure-Git {
  if (Test-CommandExists "git") {
    Write-Host "Git already installed" -ForegroundColor Green
    return
  }

  Ensure-Winget
  Install-WithWinget "Git.Git" "Git"
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
  if (-not (Test-CommandExists "git")) {
    throw "Git installation finished, but git is still not in PATH. Please reopen PowerShell and rerun the script."
  }
}

function Ensure-Node {
  $nodeOk = $false
  if (Test-CommandExists "node") {
    try {
      $major = (node --version).TrimStart("v").Split(".")[0]
      if ($major -eq $NodeVersion) {
        $nodeOk = $true
      }
    } catch {}
  }

  if ($nodeOk) {
    Write-Host "Node.js $NodeVersion already installed" -ForegroundColor Green
    return
  }

  Ensure-Winget
  Install-WithWinget "OpenJS.NodeJS" "Node.js"
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
  if (-not (Test-CommandExists "node")) {
    throw "Node.js installation finished, but node is still not in PATH. Please reopen PowerShell and rerun the script."
  }
}

function Ensure-NpmPackage([string]$PackageName, [string]$DisplayName) {
  if (Test-CommandExists $PackageName) {
    Write-Host "$DisplayName already installed" -ForegroundColor Green
    return
  }

  Write-Step "Installing $DisplayName"
  npm install -g $PackageName
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
}

function Ensure-InstallDir {
  Write-Step "Preparing directories"
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $InstallDir "wa_data") -Force | Out-Null
}

function Sync-Repo {
  if (Test-Path (Join-Path $InstallDir ".git")) {
    Write-Step "Updating existing repository"
    Push-Location $InstallDir
    git fetch origin
    git checkout $Branch
    git pull origin $Branch
    Pop-Location
    return
  }

  if ((Get-ChildItem -Force $InstallDir | Measure-Object).Count -gt 0) {
    throw "$InstallDir exists and is not empty, but is not a git repository. Please clean it manually or choose another InstallDir."
  }

  Write-Step "Cloning repository"
  git clone --branch $Branch $RepoUrl $InstallDir
}

function Prompt-IfEmpty([string]$CurrentValue, [string]$Prompt) {
  if ([string]::IsNullOrWhiteSpace($CurrentValue)) {
    return Read-Host $Prompt
  }
  return $CurrentValue
}

function Write-EnvFile {
  $envPath = Join-Path $InstallDir ".env"
  if ((Test-Path $envPath) -and (-not $ForceEnvUpdate)) {
    Write-Host ".env already exists, keeping current file" -ForegroundColor Yellow
    return
  }

  Write-Step "Writing .env"
  $resolvedChatwootBaseUrl = Prompt-IfEmpty $ChatwootBaseUrl "CHATWOOT_BASE_URL"
  $resolvedChatwootApiToken = Prompt-IfEmpty $ChatwootApiToken "CHATWOOT_API_TOKEN"
  $resolvedChatwootAccountId = Prompt-IfEmpty $ChatwootAccountId "CHATWOOT_ACCOUNT_ID"
  $resolvedAiMiddlewareUrl = $AiMiddlewareUrl
  $resolvedAiMiddlewareToken = $AiMiddlewareToken
  $waSessionDir = Join-Path $InstallDir "wa_data\wa_session"

  @"
PORT=3001
NODE_ENV=production

CHATWOOT_BASE_URL=$resolvedChatwootBaseUrl
CHATWOOT_API_TOKEN=$resolvedChatwootApiToken
CHATWOOT_ACCOUNT_ID=$resolvedChatwootAccountId

AI_MIDDLEWARE_URL=$resolvedAiMiddlewareUrl
AI_MIDDLEWARE_TOKEN=$resolvedAiMiddlewareToken

WA_SESSION_DIR=$waSessionDir
"@ | Set-Content -Path $envPath -Encoding ASCII
}

function Install-AppDependencies {
  Write-Step "Installing project dependencies"
  Push-Location $InstallDir
  npm install
  npm run build
  Pop-Location
}

function Configure-Pm2 {
  Write-Step "Configuring PM2"
  Push-Location $InstallDir

  $statusText = ""
  try {
    $statusText = pm2 jlist
  } catch {
    $statusText = "[]"
  }

  if ($statusText -match '"name":"baileys-adapter"') {
    pm2 restart baileys-adapter --update-env
  } else {
    pm2 start .\dist\index.js --name baileys-adapter --max-memory-restart 512M
  }

  pm2 save

  if (Test-CommandExists "pm2-startup") {
    try {
      pm2-startup install
    } catch {
      Write-Host "pm2-startup install failed. You can rerun it later in an elevated PowerShell." -ForegroundColor Yellow
    }
  }

  Pop-Location
}

function Show-NextSteps {
  Write-Step "Deployment finished"
  Write-Host "Health URL:  http://localhost:3001/health" -ForegroundColor Green
  Write-Host "Admin URL:   http://localhost:3001/admin" -ForegroundColor Green
  Write-Host "Logs:        pm2 logs baileys-adapter --lines 100" -ForegroundColor Green
  Write-Host ""
  Write-Host "Important:" -ForegroundColor Yellow
  Write-Host "1. Open /admin and create or reconnect WhatsApp accounts."
  Write-Host "2. Set the Chatwoot Inbox ID for each account in the admin page."
  Write-Host "3. If Chatwoot is hosted remotely, add a stable HTTPS entrypoint later."
}

Write-Step "Starting Windows deployment"
Ensure-Git
Ensure-Node
Ensure-NpmPackage "pm2" "PM2"
Ensure-NpmPackage "pm2-windows-startup" "pm2-windows-startup"
Ensure-InstallDir
Sync-Repo
Write-EnvFile
Install-AppDependencies
Configure-Pm2
Show-NextSteps
