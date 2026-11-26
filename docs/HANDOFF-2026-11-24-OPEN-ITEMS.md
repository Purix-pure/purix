# Handoff, 2026-11-24: open items and decisions closed

Applies on top of `packages.zip` with the overlay of 2026-11-24 already included in these files.

## Decisions (researched, then made)

1. **Pull-request receipts**: trailer plus a redacted receipt; the evidence bundle on request. `docs/PR_RECEIPTS.md`.
2. **Benchmark**: a separate script (`scripts/benchmark-analyze.ts`, `pnpm benchmark:analyze`), paired design, no single score. `docs/BENCHMARK_PROTOCOL.md`.
3. **Dependency lookup**: off until a person says yes; asked once at the end of `purix connect` (terminal only, never CI); stored in the user folder; `purix lookup on|off|status`; `PURIX_DEP_LOOKUP` always wins; the stored answer is ignored in CI.
4. **R6 exemption for `dashboard/server.ts`**: kept. The guard test now covers the whole dashboard folder (no network clients, no dynamic imports of network modules, no `require`; a child process only in `check_state.ts`, via `execFile`, no shell). R8 also exempts `observe/opencode_panel_source.ts`, the same kind of text as the OpenCode plugin in `hooks/install.ts`.

## Built

OpenCode panel (`purix panel`), `purix check` state on dashboard cards, per-agent split, Python changed-line coverage (pytest-cov now pinned with hashes inside the pytest tool), lookup setting and offer.

## Verified here

core 3491/3491 (3 skipped as before), cli 437/437, mcp-server 167/167; tsc for the three packages; env-docs, single-point (R1 to R8), core boundary, import cycles, core exports, claims, tool-catalog audit; eslint on changed files (warnings only, `any` in tests as before). Python coverage was run with a real pytest and pytest-cov in a throwaway venv.

## Not verified (cannot be done here)

- A live OpenCode session. The panel source type-checks against `@opencode-ai/plugin` 1.19.6, but a wrong slot name would not fail that check. OpenCode's own docs page for 1.x TUI plugins was not reachable; the `tui.json` location and `plugin` list come from a third-party plugin's README.
- A live Claude Code session (`purix statusline --install`), Windows, a real browser (the dashboard was not rendered in a browser), a real model run.
- The benchmark has no data: the dashboard still says "not measured".

## Small things

- `purix check` is run by the dashboard as a subprocess of the same CLI (`process.argv[1]`). If the dashboard is started through a wrapper where that is not the CLI entry, cards read "could not be checked".
- `BETA_SCOPE.md` was not edited.

## Second pass, 2026-11-25 (what was checked afterwards)

- Real CLI in a temp project and from a clean install of the packed tarballs: `panel --install/--status/--uninstall`, `lookup on/off/status` (CI ignores the stored answer), `statusline`, `check --json`, `receipt`, `dashboard` all ran. The packed install proved the new export-map entries resolve.
- The dashboard served by the real CLI was loaded in headless Chromium: the card read "checking", reloaded itself, and then read "not fully verified" (a project with no components); the project's "last seen" time did not move.
- Claude Code: the settings reference lists `statusLine` under "Any file", and `.claude/settings.local.json` is the documented project-local scope, so the install default is a file Claude Code reads. OBSERVABILITY.md updated.
- OpenCode: a third-party plugin reference confirms `.opencode/tui.json`, absolute path or `file://` entries, the `sidebar_content` slot, and a default export with `id` and `tui`. **New risk found:** OpenCode issues #59458 (2.1.4) and #66252 (2.4.1) report plugin slots that do not repaint on their own state changes. Both were seen on 2.x builds; if the panel line goes stale in a live session, that is the first suspect. Documented.
- Windows: reviewed the new code; one fix (drive-letter case in the panel's "installed" check). Not run on Windows.
- Repo-wide eslint: 0 errors.
- Still not possible here: a live OpenCode or Claude Code session, Windows, a real model run.
