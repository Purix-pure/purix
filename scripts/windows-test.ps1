param(
  [string]$Repo = (Split-Path -Parent $PSScriptRoot),
  [string]$Work = (Join-Path ([IO.Path]::GetTempPath()) 'purix-wintest'),
  [switch]$WithModel,
  [switch]$Interactive
)

$ErrorActionPreference = 'Continue'
# Keep equal to the tool count asserted in packages/mcp-server/src/live_test.test.ts (14 since MCP-5, 2026-10-14).
$ExpectedTools = 14
$IsWin = [Environment]::OSVersion.Platform -eq 'Win32NT'
$script:Results = New-Object System.Collections.ArrayList
$script:LogN = 0

function JP { $p = $args[0]; foreach ($s in $args[1..($args.Count - 1)]) { $p = Join-Path $p $s }; $p }
function WriteText([string]$Path, [string]$Text) {
  [IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
  [IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

# Runs a program, captures stdout and stderr separately, never hangs forever, logs everything.
function Run {
  param([string]$Exe, [string[]]$Arguments = @(), [string]$Dir = $null, [hashtable]$EnvVars = @{}, [string]$Stdin = $null, [int]$TimeoutSec = 900, [string]$Name = 'run')
  $script:LogN++
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $cmd = Get-Command $Exe -ErrorAction SilentlyContinue | Select-Object -First 1
  $rawArgs = (($Arguments | ForEach-Object { if ($_ -eq '' -or $_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' ')
  if ($IsWin -and $cmd -and $cmd.Source -match '\.ps1$') {
    $psi.FileName = "powershell"
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$($cmd.Source)`" $rawArgs"
  } elseif ($cmd -and $cmd.Source) { 
    $psi.FileName = $cmd.Source 
    $psi.Arguments = $rawArgs
  } else { 
    $psi.FileName = $Exe
    $psi.Arguments = $rawArgs
  }
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  # Purix writes UTF-8 (emoji in its messages). Without this the logs show them as mojibake (a check mark read as code page 437).
  $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
  $psi.RedirectStandardInput = ($null -ne $Stdin)
  if ($Dir) {
    if (-not (Test-Path -LiteralPath $Dir -PathType Container)) { throw ('test setup: working folder does not exist: ' + $Dir) }
    $psi.WorkingDirectory = $Dir
  }
  foreach ($k in $EnvVars.Keys) { $psi.EnvironmentVariables[$k] = [string]$EnvVars[$k] }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $code = -1; $out = ''; $err = ''
  try {
    $p = [System.Diagnostics.Process]::Start($psi)
    $o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync()
    if ($null -ne $Stdin) { $p.StandardInput.Write($Stdin); $p.StandardInput.Close() }
    if (-not $p.WaitForExit($TimeoutSec * 1000)) { try { $p.Kill() } catch {}; $code = -999; $err = 'TIMEOUT after ' + $TimeoutSec + 's' }
    else { $p.WaitForExit(); $code = $p.ExitCode }
    $out = $o.Result; if ($code -ne -999) { $err = $e.Result }
  } catch { $err = 'could not start: ' + $_.Exception.Message }
  $log = Join-Path (Join-Path $Work 'logs') ('{0:D3}-{1}.log' -f $script:LogN, ($Name -replace '[^A-Za-z0-9]+', '-'))
  $head = '$ ' + $Exe + ' ' + ($Arguments -join ' ') + "`r`n" + 'exit=' + $code + '  ' + [int]$sw.Elapsed.TotalSeconds + 's' + "`r`n--- stdout`r`n"
  [IO.File]::WriteAllText($log, $head + $out + "`r`n--- stderr`r`n" + $err)
  [pscustomobject]@{ Code = $code; Out = $out; Err = $err; All = ($out + "`n" + $err); Ms = $sw.ElapsedMilliseconds }
}

function Pass([string]$n = '') { @{ S = 'PASS'; N = $n } }
function Fail([string]$n) { @{ S = 'FAIL'; N = $n } }
function Skip([string]$n) { @{ S = 'NOT RUN'; N = $n } }
function Info([string]$n) { @{ S = 'INFO'; N = $n } }

function Check([string]$Id, [string]$Name, [scriptblock]$Test) {
  try { $r = @(& $Test)[-1] } catch { $r = Fail ('script error: ' + $_.Exception.Message) }
  if ($null -eq $r -or $r -isnot [hashtable]) { $r = Fail 'step returned nothing' }
  $color = @{ 'PASS' = 'Green'; 'FAIL' = 'Red'; 'NOT RUN' = 'DarkYellow'; 'INFO' = 'Cyan' }[$r.S]
  Write-Host ('{0,-8}{1,-4} {2}  {3}' -f $r.S, $Id, $Name, $r.N) -ForegroundColor $color
  [void]$script:Results.Add([pscustomobject]@{ Id = $Id; Name = $Name; Status = $r.S; Note = $r.N })
}

# ---------------------------------------------------------------- setup
if (Test-Path $Work) { Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force (Join-Path $Work 'logs') | Out-Null
New-Item -ItemType Directory -Force (Join-Path $Work 'tarballs') | Out-Null
$tar = Join-Path $Work 'tarballs'
$cleanDir = Join-Path $Work 'clean-dir'
$proj = Join-Path $Work 'proj'
$empty = Join-Path $Work 'empty'
New-Item -ItemType Directory -Force $cleanDir, $proj, $empty | Out-Null
# T1 moved the tools and install records out of the project into Purix's USER folder (<user folder>/tools/<project key>/). This test
# gives Purix its own user folder, so (a) installs are checked where they really go, (b) nothing here touches the real ~/.purix of
# the person running the test, and (c) another project's old install can never make "nothing was installed" look false.
$UserDir = Join-Path $Work 'user-state'
New-Item -ItemType Directory -Force $UserDir | Out-Null
$env:PURIX_USER_DIR = $UserDir
# Where an installed tool lives: <user folder>/tools/<project key>/<id>. The key is hashed inside Purix, so look under every key
# (this user folder holds only this test's project).
function ToolInstalled([string]$Id) {
  $root = Join-Path $UserDir 'tools'
  if (-not (Test-Path $root)) { return $false }
  foreach ($k in (Get-ChildItem $root -Directory -ErrorAction SilentlyContinue)) { if (Test-Path (Join-Path $k.FullName $Id)) { return $true } }
  return $false
}
# A fresh, existing, empty folder. Made right before use so a folder that went missing is a loud test error, never a Purix failure.
function FreshEmptyDir {
  New-Item -ItemType Directory -Force $empty | Out-Null
  if (-not (Test-Path -LiteralPath $empty -PathType Container)) { throw ('test setup: cannot create ' + $empty) }
  Get-ChildItem -LiteralPath $empty -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  $empty
}
$ver = (Get-Content (JP $Repo 'packages' 'cli' 'package.json') -Raw | ConvertFrom-Json).version
Write-Host ('Purix Windows test. Repo: ' + $Repo + '  version ' + $ver + '  Windows=' + $IsWin) -ForegroundColor White
Write-Host ('Work folder: ' + $Work) -ForegroundColor White

# ---------------------------------------------------------------- A. machine
Check 'A1' 'Node version is supported' {
  $r = Run node @('--version') -Name 'node-version'
  $v = $r.Out.Trim().TrimStart('v').Split('.')
  if ($r.Code -ne 0) { return Fail 'node not found' }
  $major = [int]$v[0]; $minor = [int]$v[1]
  if ($major -ge 24 -or ($major -eq 22 -and $minor -ge 13)) { Pass ('node ' + $r.Out.Trim()) } else { Fail ('node ' + $r.Out.Trim() + ' is below 22.13') }
}
Check 'A2' 'git and npm are present' {
  $g = Run git @('--version') -Name 'git-version'; $n = Run npm @('--version') -Name 'npm-version'
  if ($g.Code -eq 0 -and $n.Code -eq 0) { Pass ($g.Out.Trim() + ', npm ' + $n.Out.Trim()) } else { Fail 'git or npm missing' }
}
Check 'A3' 'Python on this machine (information only)' {
  $found = @()
  foreach ($c in @(@('py', '-3'), @('python'), @('python3'))) {
    $argsArray = if ($c.Count -gt 1) { $c[1..($c.Count - 1)] } else { @() }
    $r = Run $c[0] ($argsArray + @('--version') | Where-Object { $_ }) -Name ('python-' + $c[0])
    if ($r.Code -eq 0) { $found += ($c -join ' ') + ' -> ' + $r.All.Trim() }
  }
  if ($found.Count -gt 0) { Info ($found -join ' | ') } else { Info 'no working Python found (python tool installs will say so)' }
}

# ---------------------------------------------------------------- B. packaging
if (-not (Test-Path (JP $Repo 'packages' 'cli' 'dist' 'cli.js'))) {
  Write-Host 'Building the repo first (pnpm install + pnpm build) ...' -ForegroundColor White
  [void](Run pnpm @('install', '--frozen-lockfile') -Dir $Repo -Name 'pnpm-install')
  [void](Run pnpm @('build') -Dir $Repo -Name 'pnpm-build')
}
Check 'B1' 'pack the three packages' {
  foreach ($pkg in 'core', 'mcp-server', 'cli') {
    $r = Run pnpm @('pack', '--pack-destination', $tar) -Dir (JP $Repo 'packages' $pkg) -Name ('pack-' + $pkg)
    if ($r.Code -ne 0) { return Fail ('pnpm pack failed for ' + $pkg) }
  }
  $n = @(Get-ChildItem $tar -Filter *.tgz).Count
  if ($n -eq 3) { Pass '3 tarballs' } else { Fail ($n.ToString() + ' tarballs, expected 3') }
}
Check 'B2' 'a stranger can npm install it (folder has spaces and non-ASCII)' {
  [void](Run npm @('init', '-y') -Dir $cleanDir -Name 'npm-init')
  $tgz = @(Get-ChildItem $tar -Filter *.tgz | ForEach-Object { $_.FullName })
  $r = Run npm (@('install') + $tgz + @('--no-audit', '--no-fund')) -Dir $cleanDir -Name 'npm-install'
  if ($r.Code -ne 0) { return Fail ('npm install failed: ' + ($r.All -split "`n" | Select-Object -Last 3) -join ' ') }
  if ($r.All -match 'workspace:') { return Fail 'a workspace: dependency leaked into a tarball' }
  Pass 'installed'
}
$bin = JP $cleanDir 'node_modules' '.bin'
if ($IsWin) { $Purix = Join-Path $bin 'purix.cmd' } else { $Purix = Join-Path $bin 'purix' }
$CliJs = JP $cleanDir 'node_modules' '@purix' 'cli' 'dist' 'cli.js'
function P { param([string]$Dir, [string]$Name, [string[]]$A, [string]$Stdin = $null, [hashtable]$EnvVars = @{}) Run $Purix $A -Dir $Dir -Stdin $Stdin -EnvVars $EnvVars -Name $Name }

function VersionOk($r) { if ($r.Code -eq 0 -and $r.Out.Trim() -eq $ver) { Pass $r.Out.Trim() } elseif ($r.Code -eq 0 -and $r.Out.Trim() -eq '') { Fail 'exit 0 but printed NOTHING (the silent-launcher bug)' } else { Fail ('exit ' + $r.Code + ' output: ' + $r.All.Trim()) } }
Check 'B3' 'launcher: purix shim' { VersionOk (P $cleanDir 'v-shim' @('--version')) }
Check 'B4' 'launcher: node dist/cli.js' { VersionOk (Run node @($CliJs, '--version') -Dir $cleanDir -Name 'v-node') }
Check 'B5' 'launcher: npx --no-install purix' { VersionOk (Run npx @('--no-install', 'purix', '--version') -Dir $cleanDir -Name 'v-npx') }
if ($IsWin) {
  Check 'B6' 'launcher: purix.ps1 shim (blocked by execution policy is a finding, not a bug)' {
    $ps1 = Join-Path $bin 'purix.ps1'
    $r = Run powershell @('-NoProfile', '-File', $ps1, '--version') -Dir $cleanDir -Name 'v-ps1'
    if ($r.All -match 'running scripts is disabled|UnauthorizedAccess') { Info 'blocked by PowerShell execution policy: users on a Restricted policy hit this' } else { VersionOk $r }
  }
  Check 'B7' 'launcher: from cmd.exe' { VersionOk (Run cmd @('/c', $Purix, '--version') -Dir $cleanDir -Name 'v-cmd') }
}
Check 'B8' 'help is one page and lists the commands that matter' {
  # The two-level help (--help, then --help --all) was replaced by one grouped page, so this is the single help check.
  $r = P $cleanDir 'help' @('--help')
  $missing = @('check', 'lock', 'evidence', 'tools', 'connect', 'index', 'adopt', 'secret', 'mcp-serve') | Where-Object { $r.Out -notmatch ('(?m)^\s+' + $_ + '\b') }
  if ($r.Code -eq 0 -and $missing.Count -eq 0) { Pass } else { Fail ('exit ' + $r.Code + '; missing from help: ' + ($missing -join ', ')) }
}
Check 'B9' 'startup time (information only)' {
  $t = 1..5 | ForEach-Object { (P $cleanDir 'latency' @('--version')).Ms } | Sort-Object
  Info ('--version median ' + $t[2] + ' ms, max ' + $t[4] + ' ms')
}

# ---------------------------------------------------------------- C. no project, no model
Check 'C1' 'check in a folder with no Purix state exits 0 and says nothing was checked' {
  $e = FreshEmptyDir; $r = P $e 'check-empty' @('check')
  if ($r.Code -eq 0 -and $r.All -match 'Nothing was checked') { Pass } else { Fail ('exit ' + $r.Code + ': ' + $r.All.Trim()) }
}
Check 'C2' 'check --strict in the same folder exits 1' {
  $e = FreshEmptyDir; $r = P $e 'check-empty-strict' @('check', '--strict')
  if ($r.Code -eq 1) { Pass } else { Fail ('exit ' + $r.Code) }
}
Check 'C3' 'check --json prints one clean JSON document on stdout' {
  $e = FreshEmptyDir; $r = P $e 'check-json' @('check', '--json')
  try { $j = $r.Out | ConvertFrom-Json; if ($null -ne $j.outcome) { Pass ('outcome=' + $j.outcome) } else { Fail 'no outcome field' } } catch { Fail ('stdout is not JSON: ' + $r.Out.Substring(0, [Math]::Min(120, $r.Out.Length))) }
}
Check 'C4' 'read-only commands leave no state behind' {
  $bad = @()
  foreach ($c in @('status', 'check', 'tools plan', 'tools status', 'lang list', 'provider list', 'provider status', 'tier-status', 'audit-log verify', 'stats', 'library')) {
    $d = Join-Path $Work ('ro-' + [guid]::NewGuid().ToString('N').Substring(0, 8)); New-Item -ItemType Directory $d | Out-Null
    [void](P $d ('ro-' + $c) ($c -split ' '))
    if (Test-Path (Join-Path $d '.purix')) { $bad += $c }
  }
  if ($bad.Count -eq 0) { Pass } else { Fail ('created .purix: ' + ($bad -join ', ')) }
}
Check 'C5' 'bad input fails cleanly (no stack trace)' {
  $e = FreshEmptyDir
  $a = P $e 'bad-command' @('frobnicate'); $b = P $e 'bad-dir' @('index', (Join-Path $Work 'does-not-exist'))
  $dirty = @($a, $b) | Where-Object { $_.All -match 'Unhandled error|node:internal|file:///' }
  # Exit -1 / -999 mean the process never ran or timed out. That is a broken test, not a clean failure, so it must not pass here.
  $ran = ($a.Code -gt 0 -and $b.Code -gt 0)
  if ($ran -and -not $dirty) { Pass } else { 
    $msg = 'exits ' + $a.Code + '/' + $b.Code
    if (@($dirty).Count -gt 0) { $msg += ' and a stack trace' }
    Fail $msg 
  }
}

# ---------------------------------------------------------------- D. a real project, no model
$git = { param($a) Run git (@('-c', 'user.name=t', '-c', 'user.email=t@t') + $a) -Dir $proj -Name ('git-' + $a[0]) }
WriteText (Join-Path $proj 'package.json') "{`n  `"name`": `"fixture`", `"version`": `"1.0.0`", `"type`": `"module`", `"scripts`": { `"test`": `"node --test`" }`n}`n"
WriteText (Join-Path $proj 'tsconfig.json') "{ `"compilerOptions`": { `"target`": `"ES2022`", `"module`": `"NodeNext`", `"moduleResolution`": `"NodeNext`", `"strict`": true, `"noEmit`": true, `"allowImportingTsExtensions`": true, `"skipLibCheck`": true }, `"include`": [`"src`"] }`n"
$totalsTs = (JP $proj 'src' 'totals.ts')
WriteText $totalsTs "export function roundTotal(n: number): number {`n  return Math.round(n * 100) / 100;`n}`n"
WriteText (JP $proj 'src' 'totals.test.ts') "import { test } from 'node:test';`nimport assert from 'node:assert/strict';`nimport { roundTotal } from './totals.ts';`ntest('rounds to cents', () => { assert.equal(roundTotal(1.234), 1.23); });`n"
[void](& $git @('init')); [void](& $git @('add', '-A')); [void](& $git @('commit', '-m', 'fixture'))

Check 'D1' 'index on a fresh machine explains itself, and installs nothing behind your back' {
  $r = P $proj 'index-fresh' @('index')
  if ((ToolInstalled 'typescript') -or (Test-Path (JP $proj '.purix' 'tools'))) { return Fail 'a tool was installed without asking' }
  if ($r.All -match 'did not pass verification') {
    # -cmatch: PowerShell's -match ignores case, so 'FAIL' used to match the status word '[fail]' and pass with no reason given.
    # The reason is printed as "<file> [<status>]: <reason>".
    if ($r.All -cmatch '\[(fail|not_installed|error)\]: \S' -or $r.All -cmatch 'error TS') { Pass 'failed with a stated reason' } else { Fail 'said components failed but gave no reason' }
  } else { Pass 'indexed' }
}
function Install([string]$Tool) {
  if ($Interactive) {
    Write-Host ('  >> Purix will ask to install ' + $Tool + '. Read what it says, then type y and Enter.') -ForegroundColor Yellow
    Push-Location $proj; & $Purix tools install $Tool; Pop-Location
  } else { [void](P $proj ('install-' + $Tool) @('tools', 'install', $Tool) -Stdin "y`n") }
}
Check 'D2' 'declining an install installs nothing' {
  [void](P $proj 'install-decline' @('tools', 'install', 'typescript') -Stdin "n`n")
  if ((ToolInstalled 'typescript') -or (Test-Path (JP $proj '.purix' 'tools'))) { Fail 'installed although you said no' } else { Pass }
}
Check 'D3' 'approving installs the TypeScript checker' {
  Install 'typescript'
  if (Test-Path (JP $proj '.purix' 'tools')) { return Fail 'a tools folder appeared inside the project (T1: tools belong in the user folder)' }
  if (ToolInstalled 'typescript') { Pass 'installed in the Purix user folder, not in the project' } else { Fail ('not installed under ' + (Join-Path $UserDir 'tools')) }
}
Check 'D4' 'approving installs the test runner (tsx)' {
  Install 'tsx'
  if (Test-Path (JP $proj '.purix' 'tools')) { return Fail 'a tools folder appeared inside the project (T1: tools belong in the user folder)' }
  if (ToolInstalled 'tsx') { Pass 'installed in the Purix user folder, not in the project' } else { Fail ('not installed under ' + (Join-Path $UserDir 'tools')) }
}
Check 'D5' 'node types for the fixture' { $r = Run npm @('install', '-D', '@types/node@22', '--no-audit', '--no-fund') -Dir $proj -Name 'npm-types'; if ($r.Code -eq 0) { Pass } else { Fail ($r.All.Trim()) } }
Check 'D5b' 'node --test accepts a custom reporter given as a file:// URL (Purix passes it that way)' {
  $d = Join-Path $Work 'rep test'
  WriteText (JP $d 'rep.mjs') 'export default async function* (s) { for await (const e of s) { if (e.type === "test:pass") yield "REPORTER_OK\n"; } }'
  WriteText (JP $d 't.test.mjs') "import { test } from 'node:test';`ntest('x', () => {});`n"
  $plain = Run node @('--test', ('--test-reporter=' + (JP $d 'rep.mjs')), '--test-reporter-destination=stdout', 't.test.mjs') -Dir $d -Name 'reporter-plain-path'
  $uri = ([Uri](JP $d 'rep.mjs')).AbsoluteUri
  $url = Run node @('--test', ('--test-reporter=' + $uri), '--test-reporter-destination=stdout', 't.test.mjs') -Dir $d -Name 'reporter-file-url'
  $plainNote = if ($plain.All -cmatch 'REPORTER_OK') { 'a plain absolute path also works here' } else { 'a plain absolute path FAILS here (the cause of the old index failure)' }
  if ($url.All -cmatch 'REPORTER_OK') { Pass ('file URL works; ' + $plainNote) } else { Fail ('file URL did not work: ' + $url.All.Trim()) }
}
Check 'D6' 'index passes once the tools exist' {
  $r = P $proj 'index-ready' @('index'); $s = P $proj 'status-ready' @('status')
  # Since 0.4.0 `index` lists files and says "Indexed, not verified"; it no longer compiles or tests, so it never shows [pass].
  if ($r.Code -eq 0 -and $r.All -match 'Indexed' -and $r.All -match 'not verified' -and $s.Code -eq 0) { Pass 'indexed; honestly reported as not verified' } else { Fail ($s.Out.Trim() + ' | ' + $r.All.Trim()) }
}
Check 'D7' 'adopt registers a file as a component' { $r = P $proj 'adopt' @('adopt', 'src/totals.ts'); if ($r.Code -eq 0 -and $r.Out -match 'Adopted') { Pass } else { Fail $r.All.Trim() } }
Check 'D8' 'lock writes purix.lock.json' { $r = P $proj 'lock' @('lock'); if ($r.Code -eq 0 -and (Test-Path (Join-Path $proj 'purix.lock.json'))) { Pass } else { Fail $r.All.Trim() } }
Check 'D9' 'check is clean when nothing was touched' { $r = P $proj 'check-clean' @('check'); if ($r.Code -eq 0 -and $r.All -notmatch 'changed outside Purix') { Pass } else { Fail $r.All.Trim() } }
Check 'D10' 'a not-yet-tested component is never shown as passing (strict exits 1)' {
  $r = P $proj 'check-strict' @('check', '--strict')
  if ($r.Code -eq 1 -and $r.All -match 'not tested|skipped') { Pass } else { Fail ('exit ' + $r.Code + ': ' + $r.All.Trim()) }
}
$orig = [IO.File]::ReadAllText($totalsTs)
Check 'D11' 'an outside edit is detected and the file is named' {
  [IO.File]::AppendAllText($totalsTs, "// edited outside Purix`n")
  $r = P $proj 'check-edited' @('check')
  if ($r.Code -eq 1 -and $r.All -match 'totals\.ts') { Pass } else { Fail ('exit ' + $r.Code + ': ' + $r.All.Trim()) }
}
Check 'D12' 'restoring the file clears it' { WriteText $totalsTs $orig; $r = P $proj 'check-restored' @('check'); if ($r.Code -eq 0) { Pass } else { Fail $r.All.Trim() } }
Check 'D13' 'Windows line endings (CRLF) are NOT reported as an edit' {
  WriteText $totalsTs ($orig -replace "`r?`n", "`r`n")
  $r = P $proj 'check-crlf' @('check')
  WriteText $totalsTs $orig
  if ($r.Code -eq 0 -and $r.All -notmatch 'changed outside Purix') { Pass } else { Fail 'a plain CRLF rewrite was flagged as an outside edit' }
}
Check 'D14' 'a byte-order mark is a real byte change (information only)' {
  [IO.File]::WriteAllText($totalsTs, $orig, (New-Object System.Text.UTF8Encoding($true)))
  $r = P $proj 'check-bom' @('check'); WriteText $totalsTs $orig
  if ($r.Code -eq 1) { Info 'a BOM is flagged as an edit (Windows PowerShell 5.1 Set-Content -Encoding UTF8 adds one)' } else { Info 'a BOM is not flagged' }
}

# ---------------------------------------------------------------- E. secrets
Check 'E1' 'a stored secret is not readable as plain text' {
  $canary = 'canary-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
  $r = P $proj 'secret-set' @('secret', 'set', 'PT_TEST_SECRET', $canary)
  $roots = @((Join-Path $proj '.purix'), $UserDir)
  $hits = @(); $files = @()
  foreach ($d in $roots) { if (Test-Path $d) { Get-ChildItem $d -Recurse -Force -File -ErrorAction SilentlyContinue | ForEach-Object { $files += $_.FullName; if ((Get-Content $_.FullName -Raw -ErrorAction SilentlyContinue) -match [regex]::Escape($canary)) { $hits += $_.FullName } } } }
  $script:SecretFiles = $files
  [void](P $proj 'secret-remove' @('secret', 'remove', 'PT_TEST_SECRET'))
  if ($r.Code -ne 0) { return Fail ('secret set failed: ' + $r.All.Trim()) }
  if ($hits.Count -gt 0) { Fail ('plain text found in ' + ($hits -join ', ')) } else { Pass ('checked ' + $files.Count + ' files') }
}
Check 'E2' 'secret files are readable only by you' {
  if (-not $script:SecretFiles -or $script:SecretFiles.Count -eq 0) { return Skip 'no secret files were found' }
  $bad = @()
  foreach ($f in $script:SecretFiles | Where-Object { $_ -match 'secrets' -or $_ -match 'master' }) {
    if ($IsWin) { $acl = (Run icacls @($f) -Name 'icacls').Out; if ($acl -match 'Everyone|BUILTIN\\Users|Authenticated Users') { $bad += $f } }
    else { $mode = (& stat -c '%a' $f 2>$null); if ($mode -and $mode -ne '600') { $bad += ($f + ' (mode ' + $mode + ')') } }
  }
  if ($bad.Count -eq 0) { Pass } else { Fail ('too open: ' + ($bad -join '; ')) }
}

# ---------------------------------------------------------------- F. agents and MCP
Check 'F1' 'connect writes a launcher that suits this OS' {
  $r = P $proj 'connect' @('connect', 'claude-code')
  $cfg = Join-Path $proj '.mcp.json'
  if (-not (Test-Path $cfg)) { return Fail ('no .mcp.json written: ' + $r.All.Trim()) }
  try { $j = Get-Content $cfg -Raw | ConvertFrom-Json } catch { return Fail '.mcp.json is not valid JSON' }
  $s = $j.mcpServers.purix; $line = $s.command + ' ' + ($s.args -join ' ')
  $script:McpCmd = $s.command; $script:McpArgs = @($s.args)
  if ($IsWin -and ($s.command -ne 'cmd' -or $s.args[0] -ne '/c')) { return Fail ('on Windows an agent cannot start this directly: ' + $line) }
  if (-not $IsWin -and $s.command -notin @('purix', 'npx')) { return Fail ('unexpected launcher: ' + $line) }
  Pass $line
}
Check 'F2' 'the installed server starts and lists its tools' {
  $probe = @'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const [, , cmd, cwd, ...args] = process.argv;
const t = new StdioClientTransport({ command: cmd, args, cwd, env: { ...process.env, PURIX_MCP_AGENT_ID: 'wintest' }, stderr: 'pipe' });
let serverErr = '';
t.stderr?.on('data', (d) => { serverErr += String(d); });
const c = new Client({ name: 'probe', version: '1' }, { capabilities: {} });
try {
  await c.connect(t);
  const { tools } = await c.listTools();
  const r = await c.callTool({ name: 'purix_status', arguments: {} });
  console.log(JSON.stringify({ tools: tools.length, hasStatus: tools.some((t) => t.name === 'purix_status'), statusError: !!r.isError }));
} catch (e) { console.log(JSON.stringify({ error: String(e).slice(0, 200), serverStderr: serverErr.trim().slice(-600) })); }
finally { await c.close().catch(() => {}); process.exit(0); }
'@
  WriteText (Join-Path $cleanDir 'probe.mjs') $probe
  $r = Run node @((Join-Path $cleanDir 'probe.mjs'), 'node', $proj, $CliJs, 'mcp-serve') -Dir $cleanDir -Name 'mcp-probe' -TimeoutSec 120
  try { $j = $r.Out.Trim() | ConvertFrom-Json } catch { return Fail ('probe printed: ' + $r.All.Trim()) }
  if ($j.error) { return Fail ($j.error + ' | server said: ' + $j.serverStderr) }
  $script:F2Tools = $j.tools
  if ($j.tools -eq $ExpectedTools -and $j.hasStatus -and -not $j.statusError) { Pass ($j.tools.ToString() + ' tools, purix_status ok') } else { Fail ('expected ' + $ExpectedTools + ' tools incl. purix_status, got tools=' + $j.tools + ' hasStatus=' + $j.hasStatus + ' statusError=' + $j.statusError) }
}
Check 'F3' 'the exact command connect wrote starts too' {
  if (-not $script:McpCmd) { return Skip 'F1 wrote nothing' }
  $published = Run npm @('view', ('@purix/cli@' + $ver), 'version') -Name 'npm-view'
  if (($script:McpArgs -join ' ') -match 'npx' -and $published.Code -ne 0) { return Skip ('version ' + $ver + ' is not published on npm yet, so the npx form cannot work yet') }
  $probe = Join-Path $cleanDir 'probe.mjs'
  # Put the freshly installed .bin first so the command resolves to the build under test, never to an older global purix.
  $r = Run node (@($probe, $script:McpCmd, $proj) + $script:McpArgs) -Dir $cleanDir -Name 'mcp-probe-config' -TimeoutSec 180 -EnvVars @{ PATH = ($bin + [IO.Path]::PathSeparator + $env:PATH) }
  try { $j = $r.Out.Trim() | ConvertFrom-Json } catch { return Fail ('probe printed: ' + $r.All.Trim()) }
  if ($j.error) { Fail ('an agent using this config would fail: ' + $j.error + ' | server said: ' + $j.serverStderr) } elseif ($j.tools -eq $ExpectedTools -and $j.tools -eq $script:F2Tools) { Pass ($j.tools.ToString() + ' tools, same as the installed server') } else { Fail ('expected ' + $ExpectedTools + ' tools, got ' + $j.tools + ' (F2 saw ' + $script:F2Tools + '); an older purix may be first on PATH') }
}

# ---------------------------------------------------------------- G. Windows traps
Check 'G1' 'killing the server hard does not leave the project stuck' {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = (Get-Command node).Source; $psi.Arguments = '"' + $CliJs + '" mcp-serve'; $psi.WorkingDirectory = $proj
  $psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $p = [System.Diagnostics.Process]::Start($psi); Start-Sleep -Seconds 3
  # A server that already died would make "held no lock" a hollow pass, so say so instead.
  if ($p.HasExited) { $why = $p.StandardError.ReadToEnd().Trim(); return Fail ('the server exited by itself (exit ' + $p.ExitCode + ') before it could be killed: ' + $why) }
  $lock = Test-Path (JP $proj '.purix' 'repo.lock')
  try { $p.Kill() } catch {}
  $sw = [Diagnostics.Stopwatch]::StartNew(); $ok = $false
  while ($sw.Elapsed.TotalSeconds -lt 120 -and -not $ok) { $r = P $proj 'after-kill' @('remember', 'lock probe'); if ($r.Code -eq 0) { $ok = $true } else { Start-Sleep -Seconds 5 } }
  if ($ok) { Pass ('server ' + $(if ($lock) { 'held' } else { 'did not hold' }) + ' a lock; next write worked after ' + [int]$sw.Elapsed.TotalSeconds + 's') } else { Fail 'still stuck after 120s; would need a manual delete of .purix\repo.lock' }
}
Check 'G2' 'a file held open by another program is reported, not passed over' {
  if (-not $IsWin) { return Skip 'Windows only (Linux does not lock open files)' }
  $fs = [IO.File]::Open($totalsTs, 'Open', 'Read', 'None')
  try { $r = P $proj 'check-locked' @('check') } finally { $fs.Close() }
  if ($r.Code -ne 0 -or $r.All -match 'totals\.ts') { Pass ('exit ' + $r.Code) } else { Fail 'exit 0 and no mention of the locked file' }
}
Check 'G3' 'honesty: when tests run with no isolation, Purix says so' {
  WriteText (JP $proj 'src' 'canary.test.ts') ("import { test } from 'node:test';`nimport { writeFileSync } from 'node:fs';`ntest('canary', () => { writeFileSync(" + "'" + ((Join-Path $Work 'outside-canary.txt') -replace '\\', '/') + "', 'token=' + (process.env.PT_FAKE_TOKEN ?? 'absent')); });`n")
  $r = P $proj 'index-canary' @('index', '--full') -Stdin "y`n" -EnvVars @{ PT_FAKE_TOKEN = 'leakme' }
  Remove-Item (JP $proj 'src' 'canary.test.ts') -Force -ErrorAction SilentlyContinue
  $out = Join-Path $Work 'outside-canary.txt'
  if (-not (Test-Path $out)) { return Skip 'the canary test never ran (index did not execute it)' }
  $written = Get-Content $out -Raw
  if ($written -match 'leakme') { return Fail 'a secret-looking environment variable reached the test run' }
  $says = $r.All -match '(?i)without isolation|unisolated|no isolation|not isolated'
  $claims = $r.All -match '(?i)\bsandboxed\b|\bin an isolated\b'
  if ($says -and -not $claims) { Pass 'test code wrote outside the project, and Purix said it ran without isolation' }
  elseif ($says) { Info 'said "without isolation" but also uses sandbox wording: read the log' }
  else { Fail 'test code escaped the project and Purix did not say the run was unisolated' }
}

# ---------------------------------------------------------------- H. real model (optional)
if ($WithModel) {
  $prov = Read-Host 'Provider id (anthropic / openai / gemini)'; if (-not $prov) { $prov = 'anthropic' }
  $envName = @{ anthropic = 'ANTHROPIC_API_KEY'; openai = 'OPENAI_API_KEY'; gemini = 'GEMINI_API_KEY' }[$prov]
  $secure = Read-Host 'API key (hidden)' -AsSecureString
  $key = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  $mEnv = @{ PURIX_COST_CEILING_USD = '1' }; $mEnv[$envName] = $key
  [void](P $proj 'provider-set' @('provider', 'set', $prov))
  $before = (Get-FileHash $totalsTs).Hash
  Check 'M1' 'one real model call (dry run) shows a diff and writes nothing' {
    $r = P $proj 'model-dry-run' @('modify', 'totals', 'add a short doc comment above roundTotal', '--dry-run') -EnvVars $mEnv -TimeoutSec 300
    $same = ((Get-FileHash $totalsTs).Hash -eq $before)
    if ($r.Code -eq 0 -and $same) { Pass ('exit 0, file unchanged, ' + [int]($r.Ms / 1000) + 's') } else { Fail ('exit ' + $r.Code + ', file unchanged=' + $same + ': ' + $r.All.Trim().Substring(0, [Math]::Min(300, $r.All.Trim().Length))) }
  }
  Check 'M2' 'a wrong key fails cleanly and is never echoed' {
    $bad = @{ PURIX_COST_CEILING_USD = '1' }; $bad[$envName] = 'sk-wrong-key-123'
    $r = P $proj 'model-bad-key' @('modify', 'totals', 'x', '--dry-run') -EnvVars $bad -TimeoutSec 120
    if ($r.Code -ne 0 -and $r.All -notmatch 'sk-wrong-key-123' -and $r.All -notmatch 'Unhandled error|node:internal') { Pass } else { Fail ('exit ' + $r.Code) }
  }
  Check 'M3' 'your real key is not on disk anywhere Purix or this test wrote' {
    $hits = @()
    $roots = @($Work, $UserDir); $homeDir = if ($IsWin) { $env:USERPROFILE } else { $env:HOME }; if ($homeDir) { $roots += (Join-Path $homeDir '.purix') }
    foreach ($d in $roots) { if (Test-Path $d) { Get-ChildItem $d -Recurse -Force -File -ErrorAction SilentlyContinue | ForEach-Object { if ((Get-Content $_.FullName -Raw -ErrorAction SilentlyContinue) -match [regex]::Escape($key)) { $hits += $_.FullName } } } }
    if ($hits.Count -gt 0) { Pass } else { Fail ('KEY FOUND in ' + ($hits -join ', ') + ' : delete those files and rotate the key') }
  }
  $key = $null
} else {
  Check 'M1' 'real model call' { Skip 'run with -WithModel to include it' }
}

# ---------------------------------------------------------------- I. sweep and report
Check 'I1' 'no stack traces or internal errors in any command output' {
  $hits = @(Get-ChildItem (Join-Path $Work 'logs') -Filter *.log | Where-Object { $_.Name -notmatch 'reporter-plain-path' } | Select-String -Pattern 'Unhandled error|node:internal|\(file:///' | Select-Object -First 5 | ForEach-Object { $_.Filename })
  if ($hits.Count -eq 0) { Pass } else { Fail ('see ' + (($hits | Select-Object -Unique) -join ', ')) }
}

$pass = @($script:Results | Where-Object Status -eq 'PASS').Count; $fail = @($script:Results | Where-Object Status -eq 'FAIL').Count
$nr = @($script:Results | Where-Object Status -eq 'NOT RUN').Count; $inf = @($script:Results | Where-Object Status -eq 'INFO').Count
$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine('# Purix Windows test report'); [void]$sb.AppendLine('')
[void]$sb.AppendLine('- Purix ' + $ver + ' | ' + [Environment]::OSVersion.VersionString + ' | PowerShell ' + $PSVersionTable.PSVersion + ' | ' + (Get-Date -Format 'yyyy-MM-dd HH:mm'))
[void]$sb.AppendLine('- **' + $pass + ' PASS, ' + $fail + ' FAIL, ' + $nr + ' NOT RUN, ' + $inf + ' INFO**'); [void]$sb.AppendLine('')
[void]$sb.AppendLine('| Step | Result | What | Note |'); [void]$sb.AppendLine('|---|---|---|---|')
foreach ($r in $script:Results) { [void]$sb.AppendLine('| ' + $r.Id + ' | ' + $r.Status + ' | ' + $r.Name + ' | ' + ($r.Note -replace '\|', '/' -replace "[\r\n]+", ' ') + ' |') }
[IO.File]::WriteAllText((Join-Path $Work 'REPORT.md'), $sb.ToString())
$zip = Join-Path $Work 'purix-wintest-evidence.zip'
try { Compress-Archive -Path (Join-Path $Work 'logs'), (Join-Path $Work 'REPORT.md') -DestinationPath $zip -Force } catch {}
Write-Host ''
Write-Host ('RESULT: ' + $pass + ' PASS, ' + $fail + ' FAIL, ' + $nr + ' NOT RUN, ' + $inf + ' INFO') -ForegroundColor White
Write-Host ('Report:   ' + (Join-Path $Work 'REPORT.md')) -ForegroundColor White
Write-Host ('Send me:  ' + $zip) -ForegroundColor White
if ($fail -gt 0) { exit 1 } else { exit 0 } 
