<#
.SYNOPSIS
  Deploys PdfClaudeAssistant to the VPS over SSH.

.DESCRIPTION
  Packs the committed code (git archive of HEAD), copies it to the VPS with scp and
  runs scripts/deploy-remote.sh there: it swaps the code in the deploy directory,
  rebuilds and restarts the server container and waits for /api/health.
  The server's .env and data/ are never touched.

  Settings come from parameters or environment variables:
    PCA_DEPLOY_HOST  user@host of the VPS (required), e.g. root@<VPS_HOST>
    PCA_DEPLOY_DIR   deploy directory on the VPS (default /opt/pdfclaudeassistant)
    PCA_SSH_KEY      SSH private key (default %USERPROFILE%\.ssh\id_ed25519)

.EXAMPLE
  $env:PCA_DEPLOY_HOST = 'root@<VPS_HOST>'
  .\scripts\deploy.ps1

.EXAMPLE
  .\scripts\deploy.ps1 -DeployHost root@<VPS_HOST> -AllowDirty
#>
[CmdletBinding()]
param(
  [string]$DeployHost = $env:PCA_DEPLOY_HOST,
  [string]$Dir = $env:PCA_DEPLOY_DIR,
  [string]$Key = $env:PCA_SSH_KEY,
  # Deploy HEAD even if the working tree has uncommitted changes (they are not deployed).
  [switch]$AllowDirty
)

$ErrorActionPreference = 'Stop'
if (-not $Dir) { $Dir = '/opt/pdfclaudeassistant' }
if (-not $Key) { $Key = Join-Path $env:USERPROFILE '.ssh\id_ed25519' }

function Write-Step([string]$Message) { Write-Host "[PdfClaudeAssistant] $Message" -ForegroundColor Cyan }

function Invoke-Native([string]$What, [scriptblock]$Command) {
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$What failed (exit code $LASTEXITCODE)." }
}

if (-not $DeployHost) {
  throw 'Set PCA_DEPLOY_HOST (e.g. root@<VPS_HOST>) or pass -DeployHost.'
}
if (-not (Test-Path $Key)) { throw "SSH key not found: $Key" }
foreach ($tool in 'git', 'ssh', 'scp') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is not on PATH." }
}

$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  $dirty = git status --porcelain --untracked-files=no
  if ($dirty -and -not $AllowDirty) {
    throw "Uncommitted changes (only committed code is deployed). Commit them or pass -AllowDirty.`n$($dirty -join "`n")"
  }
  $rev = (git rev-parse --short HEAD).Trim()
  Write-Step "Deploying revision $rev to ${DeployHost}:$Dir"

  $tmp = Join-Path ([IO.Path]::GetTempPath()) "pca-deploy-$rev"
  New-Item -ItemType Directory -Force $tmp | Out-Null
  $archive = Join-Path $tmp 'pca-release.tgz'
  $remoteScript = Join-Path $tmp 'pca-deploy-remote.sh'
  Invoke-Native 'git archive' { git archive --format=tar.gz -o $archive HEAD }
  # bash needs LF line endings whatever the checkout uses.
  $sh = [IO.File]::ReadAllText((Join-Path $root 'scripts\deploy-remote.sh')) -replace "`r`n", "`n"
  [IO.File]::WriteAllText($remoteScript, $sh, (New-Object System.Text.UTF8Encoding $false))

  $sshOpts = @('-i', $Key, '-o', 'StrictHostKeyChecking=accept-new')
  Write-Step 'Uploading...'
  Invoke-Native 'scp' { scp @sshOpts -q $archive $remoteScript "${DeployHost}:/tmp/" }

  Write-Step 'Building and restarting on the server (this can take a few minutes)...'
  & ssh @sshOpts $DeployHost "bash /tmp/pca-deploy-remote.sh '$Dir' '$rev'; code=`$?; rm -f /tmp/pca-deploy-remote.sh; exit `$code"
  $code = $LASTEXITCODE
  if ($code -eq 3) {
    Write-Host ''
    Write-Host "First deploy: the code is in $Dir but there is no .env yet. On the server run:" -ForegroundColor Yellow
    Write-Host "  cd $Dir && cp .env.example .env"
    Write-Host '  docker compose build server'
    Write-Host "  docker compose run --rm --no-deps server node dist/hash-password.js '<password>'"
    Write-Host "  # paste APP_PASSWORD_HASH='...' into .env, set SESSION_SECRET (openssl rand -hex 32),"
    Write-Host '  # APP_PORT (a free loopback port) and CLAUDE_CODE_OAUTH_TOKEN (claude setup-token)'
    Write-Host 'Then run this script again. See README "Deploying on a VPS".'
    exit 3
  }
  if ($code -ne 0) { throw "Remote deploy failed (exit code $code)." }
  Write-Step "Done: revision $rev is live."
}
finally {
  Pop-Location
  if ($tmp -and (Test-Path $tmp)) { Remove-Item -Recurse -Force $tmp }
}
