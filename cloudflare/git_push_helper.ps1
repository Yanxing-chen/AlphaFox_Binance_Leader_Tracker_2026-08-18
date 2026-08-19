param(
  [string]$Message = "Update Cloudflare leader tracker"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$GitCandidates = @(
  "git",
  "$env:LOCALAPPDATA\GitHubDesktop\app-3.6.4\resources\app\git\cmd\git.exe",
  "$env:LOCALAPPDATA\GitHubDesktop\app-3.6.3\resources\app\git\cmd\git.exe",
  "C:\Program Files\Git\cmd\git.exe"
)

$Git = $GitCandidates | Where-Object {
  try { & $_ --version *> $null; $true } catch { $false }
} | Select-Object -First 1

if (-not $Git) {
  throw "Git was not found. Install Git or use GitHub Desktop to commit and push manually."
}

if (-not (Test-Path (Join-Path $RepoRoot ".git"))) {
  throw "This folder is not a Git repository yet. Open the folder in GitHub Desktop, publish it to GitHub, then run this helper again."
}

function Invoke-Git {
  & $Git -C $RepoRoot @args
  if ($LASTEXITCODE -ne 0) {
    throw "Git command failed: git $args"
  }
}

Invoke-Git status
Invoke-Git add cloudflare .github
$Changes = & $Git -C $RepoRoot status --porcelain
if (-not $Changes) {
  Write-Host "No changes to commit."
  exit 0
}
Invoke-Git commit -m $Message
Invoke-Git push
