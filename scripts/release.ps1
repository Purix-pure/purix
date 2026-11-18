# scripts/release.ps1: one command from "the fixes are done" to "the new version is installed on this machine".
#
#   .\scripts\release.ps1 -Version 0.4.0-beta.4
#   .\scripts\release.ps1 -Version 0.4.0-beta.4 -SetLatest     also move npm's `latest` tag to it (needs `npm login`)
#   .\scripts\release.ps1 -Version 0.4.0-beta.4 -SkipTests     skip test:all (it takes about 10 minutes); the workflow still runs its own checks
#
# What it does, in order, and stops at the first problem:
#   1. checks you are on main, up to date, and the version is not on npm yet
#   2. pnpm run version-set <Version>     (every file that holds the version, plus the changelog)
#   3. pnpm run test:all                  (unless -SkipTests)
#   4. shows `git status`, asks you to confirm, commits, pushes main
#   5. pushes the tag v<Version>          (this is what starts the "Publish to npm" workflow)
#   6. waits for that workflow to finish  (needs `gh` logged in as the account that can push to Purix-pure/purix)
#   7. installs @purix/cli@<tag> globally and checks `purix --version` equals <Version>
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [switch]$SkipTests,
  [switch]$SetLatest
)
$ErrorActionPreference = "Continue"
Set-Location (Split-Path -Parent $PSScriptRoot)

function Run($label, [scriptblock]$cmd) {
  Write-Host "`n== $label" -ForegroundColor Cyan
  & $cmd
  if ($LASTEXITCODE -ne 0) { throw "$label failed (exit $LASTEXITCODE)" }
}

if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$') { throw "Version must look like 0.4.0-beta.4, got '$Version'" }
$tag = "v$Version"
$distTag = if ($Version -match '-([A-Za-z]+)') { $Matches[1] } else { "latest" }   # 0.4.0-beta.4 -> beta

# 1. checks
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne "main") { throw "You are on '$branch'. Switch to main first: git checkout main" }
Run "pull latest main" { git pull --ff-only }
if (git tag --list $tag) { throw "Tag $tag already exists locally." }
$onNpm = npm view "@purix/cli@$Version" version 2>$null
if ($onNpm) { throw "@purix/cli@$Version is already on npm. npm never reuses a version: pick a higher one." }

# 2-3. bump and test
Run "set version $Version everywhere" { pnpm run version-set $Version }
Run "version check" { pnpm run version-check }
if (-not $SkipTests) { Run "full test run (test:all)" { pnpm run test:all } } else { Write-Host "`n(tests skipped)" -ForegroundColor Yellow }

# 4. commit and push main
Write-Host "`n== files that will be committed" -ForegroundColor Cyan
git status --short
$answer = Read-Host "`nCommit ALL of these and release $tag? Untracked files that are not meant to ship should be removed first. (y/N)"
if ($answer -ne "y") { throw "Stopped before committing. Nothing was pushed." }
Run "git add" { git add -A }
Run "git commit" { git commit -m "Release $Version" }
Run "push main" { git push origin main }

# 5. tag, which starts the publish workflow
Run "create tag $tag" { git tag $tag }
Run "push tag $tag" { git push origin $tag }

# 6. wait for the workflow
Write-Host "`n== waiting for the Publish to npm run for $tag" -ForegroundColor Cyan
$runId = $null
for ($i = 0; $i -lt 30 -and -not $runId; $i++) {
  Start-Sleep -Seconds 4
  $runs = gh run list --workflow "publish.yml" --event push --limit 10 --json databaseId,headBranch | ConvertFrom-Json
  $runId = ($runs | Where-Object { $_.headBranch -eq $tag } | Select-Object -First 1).databaseId
}
if (-not $runId) { throw "Could not find the publish run for $tag. Open the Actions tab on GitHub." }
Run "publish run $runId" { gh run watch $runId --exit-status }

# 7. optional: move latest, then install and verify
if ($SetLatest) {
  foreach ($p in "core", "mcp-server", "cli") { Run "latest -> $Version for @purix/$p" { npm dist-tag add "@purix/$p@$Version" latest } }
}
Run "install @purix/cli@$distTag globally" { npm install -g "@purix/cli@$distTag" }
$installed = (purix --version).Trim()
if ($installed -ne $Version) { throw "purix --version says '$installed', expected '$Version'. If the dev link is active run: npm unlink -g @purix/cli, then install again." }
Write-Host "`nDone. purix $installed is published and installed." -ForegroundColor Green
