# scripts/dev.ps1: the fast loop. Test a fix on your own machine without GitHub and without npm.
#
#   .\scripts\dev.ps1 -Setup      once: install, build, and point the global `purix` command at THIS folder (npm link)
#   .\scripts\dev.ps1             after every edit: rebuild (a few seconds), then run `purix --version`
#   .\scripts\dev.ps1 -Test       rebuild, then typecheck and run the CLI tests
#
# After -Setup, `purix` in any PowerShell window runs the code in this folder. You only publish when the fixes are done (release.ps1).
# To go back to the published version:  npm unlink -g @purix/cli ; npm install -g @purix/cli@beta
param([switch]$Setup, [switch]$Test)
$ErrorActionPreference = "Continue"
Set-Location (Split-Path -Parent $PSScriptRoot)

function Run($label, [scriptblock]$cmd) {
  Write-Host "`n== $label" -ForegroundColor Cyan
  & $cmd
  if ($LASTEXITCODE -ne 0) { throw "$label failed (exit $LASTEXITCODE)" }
}

if ($Setup -or -not (Test-Path "node_modules")) { Run "install" { pnpm install --frozen-lockfile } }
Run "build" { pnpm run build }
if ($Setup) {
  Push-Location "packages/cli"
  try { Run "link the global purix command to this folder" { npm link } } finally { Pop-Location }
}
if ($Test) {
  Run "typecheck" { pnpm run typecheck }
  Run "cli tests" { pnpm --filter "@purix/cli" run test }
}
Write-Host "`n== running: purix --version" -ForegroundColor Cyan
purix --version
