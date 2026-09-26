<#
.SYNOPSIS
  Deploys PdfClaudeAssistant to the VPS over SSH, or sets its password / Claude token.

.DESCRIPTION
  Deploy (default): packs the committed code (git archive of HEAD), copies it to the
  VPS with scp and runs scripts/deploy-remote.sh there. The VPS builds it with a
  private Node 22, swaps it in, restarts the systemd service and checks
  /api/health, rolling back if the new version does not come up. The server's .env
  and data/ are never overwritten.

  -SetPassword     asks for the login password here and stores its hash on the VPS.
  -SetClaudeToken  asks for the token printed by 'claude setup-token' and stores it.
  Neither value is written to disk on this PC nor shown on screen.

  Settings (parameters or environment variables; none of them go in the repo):
    PCA_DEPLOY_HOST  user@host of the VPS (required), e.g. root@<VPS_HOST>
    PCA_DOMAIN       public name; when set, the app's block in the VPS Caddyfile is
                     (re)written. Prefix it with http:// when Cloudflare is in
                     Flexible mode, e.g. http://<APP_DOMAIN>
    PCA_APP_PORT     loopback port, used only when the first deploy creates .env
                     (default 8004)
    PCA_DEPLOY_DIR   deploy directory on the VPS (default /opt/pdfclaudeassistant)
    PCA_SSH_KEY      SSH private key (default %USERPROFILE%\.ssh\id_ed25519)

.EXAMPLE
  $env:PCA_DEPLOY_HOST = 'root@<VPS_HOST>'
  $env:PCA_DOMAIN = 'http://<APP_DOMAIN>'
  .\scripts\deploy.ps1
  .\scripts\deploy.ps1 -SetPassword
  .\scripts\deploy.ps1 -SetClaudeToken
#>
[CmdletBinding(DefaultParameterSetName = 'Deploy')]
param(
  [string]$DeployHost = $env:PCA_DEPLOY_HOST,
  [string]$Domain = $env:PCA_DOMAIN,
  [string]$Port = $env:PCA_APP_PORT,
  [string]$Dir = $env:PCA_DEPLOY_DIR,
  [string]$Key = $env:PCA_SSH_KEY,
  # Deploy HEAD even if the working tree has uncommitted changes (they are not deployed).
  [Parameter(ParameterSetName = 'Deploy')][switch]$AllowDirty,
  [Parameter(ParameterSetName = 'Password')][switch]$SetPassword,
  [Parameter(ParameterSetName = 'Token')][switch]$SetClaudeToken
)

$ErrorActionPreference = 'Stop'
if (-not $Dir) { $Dir = '/opt/pdfclaudeassistant' }
if (-not $Key) { $Key = Join-Path $env:USERPROFILE '.ssh\id_ed25519' }
if (-not $Port) { $Port = '8004' }

function Write-Step([string]$Message) { Write-Host "[PdfClaudeAssistant] $Message" -ForegroundColor Cyan }

if (-not $DeployHost) { throw 'Set PCA_DEPLOY_HOST (e.g. root@<VPS_HOST>) or pass -DeployHost.' }
if (-not (Test-Path $Key)) { throw "SSH key not found: $Key" }
if ($Port -notmatch '^\d{2,5}$') { throw "Invalid port: $Port" }
if ($Domain -and $Domain -notmatch '^(http://)?[A-Za-z0-9.-]+$') { throw "Invalid domain: $Domain" }
foreach ($tool in 'git', 'ssh', 'scp') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is not on PATH." }
}

$root = Split-Path -Parent $PSScriptRoot
$sshOpts = @('-i', $Key, '-o', 'StrictHostKeyChecking=accept-new')
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("pca-deploy-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $tmp | Out-Null
$remoteScript = Join-Path $tmp 'pca-deploy-remote.sh'
# bash needs LF line endings whatever the checkout uses.
$sh = [IO.File]::ReadAllText((Join-Path $root 'scripts\deploy-remote.sh')) -replace "`r`n", "`n"
[IO.File]::WriteAllText($remoteScript, $sh, (New-Object System.Text.UTF8Encoding $false))

function Invoke-Remote([string]$Arguments, $Stdin = $null) {
  $cmd = "bash /tmp/pca-deploy-remote.sh $Arguments; code=`$?; rm -f /tmp/pca-deploy-remote.sh; exit `$code"
  # Remote stderr (apt, pnpm warnings) must not abort the script: only the exit code counts.
  $ErrorActionPreference = 'Continue'
  if ($null -ne $Stdin) {
    # Secrets go through stdin (not the command line) as UTF-8.
    $prev = $OutputEncoding
    $OutputEncoding = New-Object System.Text.UTF8Encoding $false
    try { $Stdin | & ssh @sshOpts $DeployHost $cmd | Out-Host } finally { $OutputEncoding = $prev }
  }
  else {
    # Out-Host: the remote output is shown, not returned along with the exit code.
    & ssh @sshOpts $DeployHost $cmd | Out-Host
  }
  return $LASTEXITCODE
}

function Read-Secret([string]$Prompt) {
  $secure = Read-Host -AsSecureString $Prompt
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

Push-Location $root
try {
  if ($SetPassword -or $SetClaudeToken) {
    if ($SetPassword) {
      $secret = Read-Secret 'New login password'
      if ($secret.Length -lt 8) { throw 'Use at least 8 characters.' }
      if ($secret -cne (Read-Secret 'Repeat it')) { throw 'The passwords do not match.' }
      $command = 'set-password'
    }
    else {
      $secret = Read-Secret "Token printed by 'claude setup-token'"
      $command = 'set-claude-token'
    }
    & scp @sshOpts -q $remoteScript "${DeployHost}:/tmp/"
    if ($LASTEXITCODE -ne 0) { throw "scp failed (exit code $LASTEXITCODE)." }
    $code = Invoke-Remote "$command '$Dir'" $secret
    $secret = $null
    if ($code -ne 0) { throw "Remote command failed (exit code $code)." }
    Write-Step 'Done.'
    return
  }

  $dirty = git status --porcelain --untracked-files=no
  if ($dirty -and -not $AllowDirty) {
    throw "Uncommitted changes (only committed code is deployed). Commit them or pass -AllowDirty.`n$($dirty -join "`n")"
  }
  $rev = (git rev-parse --short HEAD).Trim()
  Write-Step "Deploying revision $rev to $Dir on the VPS"
  $archive = Join-Path $tmp 'pca-release.tgz'
  git archive --format=tar.gz -o $archive HEAD
  if ($LASTEXITCODE -ne 0) { throw 'git archive failed.' }

  Write-Step 'Uploading...'
  & scp @sshOpts -q $archive $remoteScript "${DeployHost}:/tmp/"
  if ($LASTEXITCODE -ne 0) { throw "scp failed (exit code $LASTEXITCODE)." }

  Write-Step 'Building and restarting on the server (a few minutes the first time)...'
  $code = Invoke-Remote "deploy '$Dir' '$rev' '$Domain' '$Port'"
  if ($code -eq 3) {
    Write-Host ''
    Write-Host 'Installed but not started: the login password is not set yet. Run:' -ForegroundColor Yellow
    Write-Host '  .\scripts\deploy.ps1 -SetPassword'
    Write-Host "  .\scripts\deploy.ps1 -SetClaudeToken   # token from 'claude setup-token'"
    exit 3
  }
  if ($code -ne 0) { throw "Remote deploy failed (exit code $code)." }
  Write-Step "Done: revision $rev is live."
}
finally {
  Pop-Location
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
}
