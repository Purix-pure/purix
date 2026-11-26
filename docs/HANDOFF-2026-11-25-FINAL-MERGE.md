# Handoff 2026-11-25: final merge on `packages.zip`

Base: `packages.zip`. Apply the changed-files zip over it (paths are relative to the repository folder, the one with `package.json`).

## What was in the uploads, and what was done with each

| Upload | Built on | Result |
| --- | --- | --- |
| `packages.zip` | the 11-24 merge (already holds the whole r2 overlay) | **Base.** |
| `packages-final-2026-11-23.zip` | older than the base | Not applied. Lacks the 11-24 files (`receipt`, `statusline_setup`, `duplication`, outcomes). |
| `purix-final-overlay-2026-11-23.zip` (64 files) and `...-r2.zip` (65 files) | older than the base | Not applied. Every line that is only in them is wording the base or later work replaced (checked file by file; example: `result_line.ts` now has the 120-character cap, `digest.ts` the coverage note). Applying them would undo the 11-24 merge. |
| `purix-changes-on-packages-2026-11-25.zip` (63 files) | the base | **Applied.** 21 files were already identical; 42 changed. Where it differs from the base it only adds (the largest change removes 8 lines), so no base work is lost. |
| `purix-test-fixes.zip` (16 files) | the base | **Applied.** Touches only `package.json` in common with the 11-25 overlay; that file was merged by hand (both scripts kept: `benchmark:analyze`, `test:one`). |
| `purix-coverage-extra.zip` (2 files) | the base | **Applied.** Its `observe_helpers_coverage.test.ts` is a superset of the copy in test-fixes (adds `sanitizeAndRecord` and provider-registry tests), so that copy was used. |

Result: 58 files differ from `packages.zip` (20 new, 38 changed, none deleted), plus this handoff.

## One behaviour change to know about (from test-fixes)

`security/secrets_manager.ts`: the search for an old Purix secret store now stops at the person's home folder. A store in the project or in the home folder is still found; a store in a folder above home is no longer treated as Purix's. Reason given in the code: a test whose temp folder sits inside a throw-away home could otherwise reach the developer's real home. `secrets_manager_walkup.test.ts` passes. Revert that one file if you want the old reach.

Five older tests were edited by test-fixes to use the isolated home (`secret_read`, `sandbox_strict`, `auth_no_input`, `c2_planted_eslint`, `secret_user_level.e2e`). All pass.

## What was run (Linux, Node 22.23, no real model)

- Typecheck: core, mcp-server, cli. Clean.
- Build: `tsc -p tsconfig.build.json` per package, in order core, mcp-server, cli. Clean.
- Tests: core 3,509 pass, 0 fail, 3 skipped (the old skips), plus 19/19 in the second batch the runner prints; mcp-server 167/167; cli 437/437.
- Gates: core boundary, import cycles (301 files), core exports (120), single-point (R1 to R8, R6=0), env docs (30 variables), tool boundary (603 files), no toolchain artifacts, claims, versions (24 checks), checks page up to date.
- ESLint on the changed `.ts` files: 0 errors, 4 warnings (`any`, three in code that came in with the overlay, one in a test).

## What was NOT run

- `pnpm run typecheck` and `pnpm run build` through turbo: turbo could not start a child process in this container ("Exec format error"). The same commands were run package by package instead.
- `generate-tool-catalog.mjs`: it needs network, `uv` and a working `npm`; the container blocks `releases.astral.sh`. It rewrites the catalog, so it is not a check; the catalog files were confirmed untouched, and `catalog.test.ts` (which recomputes every lock hash from the committed data) passes inside the core suite. The new pytest-cov pin was therefore not re-resolved here; the 11-25 handoff says it was run with a real pytest in a throwaway venv, which I did not repeat.
- Windows, macOS, a real browser, a live Claude Code or OpenCode session, a real model run, real OSV/registry replies, a packed-tarball install.
- The test runners' isolation (own home and temp folder per test) was exercised only on Linux.

## What is complete, against the "Showing developers what Purix did" plan and the open items of 11-24

Built and tested here: result line, `purix watch`, status line install (`purix statusline --install`), local dashboard (home, project, receipt, telemetry, how pages), weekly digest, receipts (`purix receipt`, `--redact`), rework risk, dependency lookup (off by default; `purix lookup on|off|status`; one question at the end of `purix connect`, terminal only), duplication check (opt-in), changed-line coverage for JavaScript, TypeScript and Python, `purix check` state on dashboard cards, per-agent split, OpenCode panel (`purix panel`), pull-request receipts (trailer plus redacted receipt, `docs/PR_RECEIPTS.md`), benchmark analysis script (`pnpm benchmark:analyze`, `docs/BENCHMARK_PROTOCOL.md`), no-outbound guard over the whole dashboard folder.

## Still missing from the final code base

1. **Benchmark data.** The script exists; nobody has collected paired runs, so the dashboard still reads "not measured" for the saving against a plain agent.
2. **Live checks that cannot be done on Linux:** `purix statusline --install` in a real Claude Code project; the OpenCode panel in a live session (the slot name and `tui.json` location come from a third-party plugin's README; OpenCode issues #59458 and #66252 report slots that do not repaint, so a stale panel line is the first suspect); the dashboard in a browser; Windows (registry path, the drive-letter fix in the panel); macOS.
3. **Per-file-pattern view of risky files** sent to a person (gate events carry no pattern).
4. **Changed-line coverage** for languages other than JavaScript, TypeScript and Python.
5. **Dashboard check cards** run `purix check` via `process.argv[1]`; behind a wrapper that is not the CLI entry they read "could not be checked" (never shown as clean).
6. `BETA_SCOPE.md` was not edited and may not mention the features above.
7. Not in these uploads, so not assessed: the rest of the Purix completion plan (tasks C-xx / N-xx), the API/web dashboard package, and the ADR renumbering.
