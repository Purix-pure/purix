# PURIX-33 live phase report

## Changed files
- PURIX-33-LIVE-REPORT.md — records the live-phase commands and their results.

## Setup and evidence
- Ran: `pnpm install --frozen-lockfile`
  - Result: success
  - Evidence: exit code 0; `Done in 11.5s using pnpm v12.4.1`
- Ran: `pnpm test`
  - Result: failed
  - Platform: Windows host (`E:\test\purix`, Node 26.5.0, pnpm 12.4.1)
  - Turbo summary: `Tasks: 4 successful, 7 total` and `Failed: @purix/cli#test`
  - Important failing output from the CLI suite:
    - `@purix/cli:test: ✖ stays silent on stderr for the hook command`
    - `Error [ERR_UNSUPPORTED_ESM_URL_SCHEME]: Only URLs with a scheme in: file, data, and node are supported by the default ESM loader. On Windows, absolute paths must be valid file:// URLs. Received protocol 'e:'`
    - `@purix/cli#test: ERROR command ... exited (1)`
  - Additional failing output from `@purix/mcp-server:test`:
    - `still failing: Python tooling (pyright) not installed`
- Ran, in order: `pnpm --filter @purix/core build`, `pnpm --filter @purix/mcp-server build`, `pnpm --filter @purix/cli build`
  - Result: all three builds succeeded.
- Ran: `pnpm typecheck`
  - Result: success; Turbo reported `Tasks: 5 successful, 5 total`.
- Ran: `pnpm boundary-check`
  - Result: success; `Core boundary check passed — no packages/core file imports from packages/cli or packages/api.`
- Ran: `pnpm tool-boundary-check`
  - Result: success; `374 files scanned, 0 violations`.
- Ran: `pnpm artifact-check`
  - Result: success; `No toolchain artifacts found outside .purix/tmp/.`
- Ran: `pnpm single-point-check`
  - Result: success; `R1=103 R2=0 R3=0 R4=0 R5=0 R6=0 R7=0`.
- Ran: `node scripts/check-claims.mjs`
  - Result: success; `27 rows (tested 23, simulated 1, stated-limit 3); README unmapped claim-shaped sentences: 16 (baseline 16)`.
  - It printed broken-link warnings in a generated README under `.purix/tmp/` and in three repo Markdown files; command still exited 0.
- Ran: `node scripts/smoke-test.mjs`
  - Result: success; `Done. 6 passed, 0 failed.`

## T1. Operating systems
- Ran on Windows: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\windows-test.ps1 -Work %TEMP%\purix-wintest-live-20261016` (without `-WithModel`).
- Result: `38 PASS, 0 FAIL, 1 NOT RUN, 3 INFO`.
- The skipped step was M1, the optional real model call. Informational steps reported Python 3.14.6, startup median 492 ms / max 604 ms, and that a BOM is treated as a byte change.
- D5b passed with the script's observed result: a `file://` custom reporter URL works, while a plain absolute path fails on this Windows Node setup.
- The detailed report is in `%TEMP%\purix-wintest-live-20261016\REPORT.md`, outside the repo.
- A separate earlier `pnpm test` run still failed in the CLI suite with the ESM `e:` URL error and also showed `pyright` missing in an MCP-server test. The Windows script passing does not erase those results.

## What I ran and what is blocked
- Platform: Windows; Node v26.5.0; pnpm 12.4.1.
- Repo install, builds, typecheck, tests, boundary/hygiene checks, claims check, smoke test, and Windows platform script were run as listed above.
- The user set a total live-model budget of $10. No live-model calls have been made; current spend is $0.
- The required plan file `PURIX-33-AI-USABILITY-FINAL-PLAN-2026-10-16.md` was not found in the repo or under `E:\test` when searched. It remains a prerequisite for interpreting the experiment and decision criteria.

## T2. The real eval (AI-15a / AI-15b)
- Not run.
- Blockers: the referenced plan file was not found, and the clean baseline versions needed for the A0/A1 comparison have not been established. `git show HEAD:packages/core/src/llm/prompts/edit_kinds.ts` reports that path does not exist in `HEAD`; the working tree copy is untracked, and `compile.ts` is modified. I will not invent the original-zip baseline.
- `purix provider status` reported `No provider configured yet`; no provider key was found through Purix's configured provider. No live call was made. The eval CLI supports `--budget-usd`; the user-set total budget is $10, and spend remains $0.

## T3. Live run of the new loop (AI-11, AI-12, AI-13, AI-09)
- Not run.
- Blocker: `purix provider status` reported no provider configured, and this task depends on real model calls.
- The prompt also requires a throwaway project and real provider setup; none were prepared.

## T4. Real agents (AI-17 and the client-support claims)
- User identified installed agents: OpenCode, Claude Code, and Codex.
- Ran `node scripts/real-agent-kit.mjs prepare claude-code`, `... prepare codex`, and `... prepare opencode`.
- Result: all three prepared successfully (`purix index`, `adopt`, `lock`, and `connect` succeeded for each).
- For OpenCode, the user supplied a client transcript in which filesystem actions failed with `'purix' is not recognized as an internal or external command`; the user agent therefore did not edit either fixture.
- Ran `node scripts/real-agent-kit.mjs check opencode --dir C:\Users\Fawad\AppData\Local\Temp\purix-real-opencode`.
  - Result: `RESULT: not a pass`.
  - The kit found `0 hook call(s)`, `hookRanAtAll` failed, `governedEditBlocked` passed, `ungovernedEditAllowed` failed, `hookConfigUntouched` passed, and `lockSectionPasses` passed.
  - Read the fixture files: `src/a.ts` remains `export const a = 1;`; `src/free.ts` remains `export const f = 1;`. No `payloads.jsonl` exists.
  - Checked command availability: `where purix` found no executable; `E:\test\purix\packages\cli\dist\cli.js` exists. The generated plugin launches bare `purix` with `spawnSync`, so OpenCode must be launched with a Purix CLI executable on PATH for its hook to run. The failure is fail-closed; it does not count as a passing real-client check.
  - Did not run `record` because the check did not pass.
- Claude Code and Codex remain prepared but not tested.

## T5. Release gate
- Not run.
- Reason: the required sequence is paused at T4 while awaiting the real-client interactions.

## T6. Evidence for open measurements
- Not run.
- Reason: requires call log and events from T2/T3/T4 runs which were not executed.

## T7. Coverage gate
- Not run.
- Reason: the prompt says to report it only, not fix it, but the required coverage run is a later task, not a step I should start before the blocked live-model tasks are approved.

## Decisions in section 5 (evidence only; no recommendation)
1. Keep or remove `modify_code` (AI-15a): not evaluated yet.
2. Build `line_edit` (AI-15b): not evaluated yet.
3. AI-13 interpretation skip: not evaluated yet.
4. Confirmation of D-AI-1 to D-AI-4: not evaluated yet.
5. Diff-XYZ license / project-call-log move: not evaluated yet.
6. IDEA-078 vault decision: open question; the vault is not reachable from this environment, and the prompt explicitly says not to guess.

## First thing to do next
- For OpenCode, relaunch it with a valid `purix` CLI executable on PATH, repeat the three requested interactions, then rerun `check`. Claude Code and Codex remain pending. The eval remains blocked until the final plan and original baseline source are available and a provider is configured. The live-call budget is $10; $0 has been spent so far.
