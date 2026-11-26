# Handoff 2026-11-26: merge on the new `packages.zip`, and what is complete or missing

Base: the `packages.zip` uploaded 2026-11-26. Unzip the changed-files zip over it (paths relative to the repository folder, the one with `package.json`). `docs/HANDOFF-2026-11-25-FINAL-MERGE.md` is left as it is in the base; this file adds to it.

## 1. How the new `packages.zip` relates to earlier work

I rebuilt the common ancestor (the old base plus the three 11-25 overlays and the `test:one` script, i.e. the first merge) and compared the new `packages.zip` with it. The new base **already contains the whole first merge**, byte for byte, plus 12 changes made after it:

| File | What changed | Judgement |
| --- | --- | --- |
| `core/src/state/repo_lock.ts` | the wait for a lock that is still being written is measured on the wall clock, not by counting polls | Sound (a loaded machine stretches one 25 ms wait). Kept. |
| `core/src/state/exclusive_create_race*.ts` | longer start lead and hold in the race test | Test timing only. Kept. |
| `core/src/verify/python_test_integrity.ts` | interpreter found is cached for the process, a miss for 60 s; Windows probes `python`, `py`, `python3`; per-probe stop raised to 15 s; `pythonAnalysisAvailable()` | **Defect found and fixed, see section 2.** The rest kept. |
| `core/src/verify/test_integrity_evasions.test.ts` | skips the Python block when no usable interpreter | Kept. |
| `core/src/tools/catalog_data.ts`, `catalog_manifest.json` | `coverage` pin moved 7.6.10 to 7.10.7 and the lock re-resolved (new `lockSha256`) | Someone ran the generator with network; I did not. `catalog.test.ts` (recomputes every hash) passes. Nothing else referenced 7.6.10. |
| `core/src/security/full_audit.ts` | line endings only (CRLF to LF); identical ignoring whitespace | Kept. |
| `scripts/test-home-preload.mjs`, `scripts/speed-test.mjs` | remembers the real home for the Python launcher; times `lookup status` and `panel --status` | Kept. |
| `eslint.config.mjs`, `.gitignore`, `skills-lock.json` | `.agents/` ignored; `.cjs` may use `require`; a locked local security-audit skill | Kept (not Purix product code). |

None of these 12 files is one I changed, so there was **no file-level conflict**. The only file both sides created was the 11-25 handoff, which is why this one is a new file.

## 2. The one defect found and fixed in the new base

`python_test_integrity.ts` passed `deadlineMs: 15_000` to the interpreter probe, which overrides the 10 s T1 stop on every platform. On Linux and macOS two hung candidates (`python3`, `python`) then cost 30 s, and `python_stop_handling.test.ts` ("inside the T1 budget", limit 25 s) failed with 30,033 ms. The test is skipped on Windows, where the change was made. **Fix:** the longer 15 s applies on Windows only; elsewhere the T1 stop applies (20 s for two hung candidates). Run on the file alone before and after: 2 of 3 pass, then 3 of 3. If you want 15 s everywhere instead, raise the test limit to 35 s; I chose not to loosen a test that encodes the T1 budget.

## 3. What this round adds on top of the new base (18 files, plus this handoff)

New: `observe/risky_files.ts` (+ test), `scripts/benchmark-run.ts` (+ test). Changed: `ledger_reader.ts` (`riskyFiles` in the summary), `dashboard/pages.ts` (Security panel line), `commands/digest.ts` (+ test), `dashboard/check_state.ts` (+ test) and `commands/dashboard.ts` (the check cards find the CLI from the module's own location, not `process.argv[1]`), `dashboard_outcomes.test.ts`, `package.json` (`benchmark:run`), `BETA_SCOPE.md`, `docs/OBSERVABILITY.md`, `docs/BENCHMARK_PROTOCOL.md`, `python_test_integrity.ts` (section 2), `scripts/benchmark-analyze.ts` (section 3a). What each does is in the table in section 5.

## 3a. Fix after your Windows run of `benchmark-run.ts` (same day)

Running `node --import tsx scripts/benchmark-run.ts` on Windows printed nothing, and `pnpm benchmark:run plan.json runs.json, --dry-run` printed nothing either. Cause: the script (and `scripts/benchmark-analyze.ts`, which came in the base with the same line) decided "am I the script being run?" with `import.meta.url === \`file://${process.argv[1]}\``. On Windows that is `file:///E:/test/...` against `file://E:\test\...`, never equal, so `main` never ran. Both now compare with `pathToFileURL(process.argv[1]).href`, which the repo's other scripts already use. The second command also had a typo: in PowerShell `runs.json, --dry-run` is one joined argument, so pnpm passed `"runs.json --dry-run"`. The runner now says so and shows what to write (`plan.json runs.json --dry-run`, spaces only), prints usage when called with no arguments, and `--dry-run` needs only the plan file. Ran here on Linux (not Windows): no arguments gives the usage and exit 2; `--dry-run` with only a plan prints each task's drawn order; the comma form gives the joined-argument message; a subprocess test now runs the script as a script (the case that failed). `scripts/benchmark-analyze.ts` was checked the same way (usage on no arguments). I could not run Windows; the fix follows from the URL forms above and from the pattern the other scripts use, so please run the same three commands once more. One search of the repo found no other use of the broken pattern (`language/conformance/run.ts` has a file-name fallback that also works on Windows).

## 4. What was run (Linux, Node 22.23), on the merged tree

- Typecheck and build per package (core, mcp-server, cli): clean.
- Tests: core 3,518 pass, 0 fail, 3 skipped (old skips), plus 19/19 in the runner's second batch; mcp-server 167/167; cli 443/443; script tests 18/18 (after the fix in 3a).
- Gates, all passing: core boundary, import cycles (302 files), core exports (120), single-point (R1 to R8), env docs (30), tool boundary (605 files), no toolchain artifacts, claims, versions (24), checks page up to date.
- ESLint, whole repository: 0 errors, 157 warnings (not introduced here).
- Duplicate-code sweep: no function with the same name and same body in two files.
- Live runs from the previous round (real Claude Code 2.1.332 status line; real OpenCode 1.19.6 panel with repaint; dashboard in headless Chromium), on Linux, with stand-in events and no model. Not re-run on this tree, because none of the code they exercise changed in this merge.

## 5. Open items and their state

| # | Item | State |
| --- | --- | --- |
| 1 | Benchmark | Runner built (`pnpm benchmark:run plan.json runs.json`, `--dry-run`): paired plain and Purix runs, order drawn per task from a recorded seed, fresh copy per arm, hidden acceptance tests copied in only after the agent finishes, cost and interruptions recorded only if the agent reports them. Its 8 tests use a made-up agent and produce no benchmark data. **No paired runs exist**: they need a real agent, a model and credentials. The dashboard still reads "not measured". |
| 2 | Live checks | Run on Linux (see section 4). **Not run:** Windows, macOS, sessions with a real model. |
| 3 | Risky files by pattern | Built: groups the files named by policy-block events by generic pattern, never by name; a line in the Security panel and the digest; counts stops, not files. |
| 4 | Changed-line coverage for other languages | **Not done, on purpose:** needs a provider per language; `BETA_SCOPE.md` records Rust, Go and Ruby as removed on purpose, and `language/unsupported_languages.ts` requires research, a manifest and a provider first. Your decision. |
| 5 | Dashboard check cards and `process.argv[1]` | Fixed (`resolveCliEntry`), 4 tests. |
| 6 | `BETA_SCOPE.md` | Updated, with `docs/OBSERVABILITY.md`. |
| 7 | Completion plan (C-xx / N-xx), API/web package, ADR renumbering | Not assessed: not in the uploads. |

## 6. What was NOT run

- `pnpm run typecheck` / `build` through turbo: turbo cannot start a child process in this container (run per package instead).
- `generate-tool-catalog.mjs`: needs network, `uv` and `npm`. The catalog in the new base was re-resolved by someone else; I checked it only through `catalog.test.ts`.
- Windows and macOS (including the Windows-only 15 s probe stop and the `python`/`py`/`python3` order), a session with a real model, a packed-tarball install.

## 7. Still missing

1. **Benchmark data**: run `pnpm benchmark:run` with a real agent over enough tasks.
2. **Windows and macOS runs** of the status line, panel and dashboard, and sessions with a real model.
3. **Other-language providers**: your product decision (item 4).
4. The completion plan, API/web package and ADR work (item 7): not in the uploads.
