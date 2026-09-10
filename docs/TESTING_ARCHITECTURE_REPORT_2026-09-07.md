# Purix Testing and Architecture Status

Date: 2026-09-07
Scope: public repository (`core`, `cli`, `mcp-server`)

## Evidence standard

An item is **resolved** here only when this workspace contains a literal command and literal output proving the relevant behavior. Historical claims whose raw evidence is unavailable are not promoted to resolved.

## Resolved Items

- **Config writer process-tree cleanup.** `config_hot_reload.test.ts` now kills the complete tsx process tree and avoids waiting forever when the child exits before the listener is attached. Evidence: `pnpm --filter @purix/core exec tsx --test --test-concurrency=1 src/state/config_hot_reload.test.ts` produced `tests 2`, `pass 2`, `fail 0`; a post-run process query found no `config_hot_reload` or `config_race_worker` processes.
- **Scheduler worker tree cleanup.** `scheduler.test.ts` now uses a detached POSIX group and Windows `taskkill /T /F`. Direct worker evidence recorded `BEFORE=0 AFTER=31` and `SUCCESS: The process with PID ... has been terminated` for both the tsx shim and its worker child.
- **Scheduler deterministic cleanup.** The scheduler test now closes the manifest SQLite handle before deleting its Windows temp directory. Evidence: the formerly failing isolated test produced `tests 1`, `pass 1`, `fail 0`.
- **Scheduler isolated live-reload behavior.** `pnpm --filter @purix/core exec tsx --test --test-concurrency=1 --test-name-pattern="real long-lived process" src/state/scheduler.test.ts` produced `tests 1`, `pass 1`, `fail 0`.
- **Strict core typecheck for audited files.** `pnpm --filter @purix/core exec tsc --noEmit` completed with no output and exit code `0` after the child-process typing fixes.
- **Budget worktree child-process tests.** `pnpm --filter @purix/core exec tsx --test --test-concurrency=1 src/llm/budget_worktree.test.ts` produced `tests 3`, `pass 3`, `fail 0`.
- **Provider hot-reload child-process tests.** `pnpm --filter @purix/core exec tsx --test --test-concurrency=1 --test-name-pattern="custom" src/llm/providers.test.ts` produced `tests 3`, `pass 3`, `fail 0`.

## Open Items

- **Windows atomic config replacement race.** The combined scheduler run failed with literal output: `Error: EPERM: operation not permitted, rename '...config.json.<pid>....tmp' -> '...config.json'`. This is a production `config.ts` portability issue, not merely a test assertion. Decision needed: retry/backoff, a Windows-specific replacement strategy, or an explicit concurrency contract.
- **Full scheduler file is not green on Windows.** The latest clean run produced `tests 5`, `pass 4`, `fail 1`; the one failure is the config rename race above. The isolated scheduler e2e test passes, so this must not be summarized as a scheduler logic failure without the Windows rename context.
- **Safety-cap observability.** `packages/core/src/state/config_race_worker.ts` contains `const HARD_SAFETY_CAP_MS = 30_000`. It protects against an interrupted parent test orphaning an infinite writer, but the worker does not report whether the cap or the intended kill stopped it. Add an explicit exit reason/marker and assert the cap was not reached in the normal test path.
- **Full core suite status.** No fresh complete `353`-test result is available in this reporting pass. Earlier execution stalled in cross-process config testing before the wait-race fix; that historical output is not a current full-suite result.
- **Deep adversarial audit from the requested session report §3.** Carry forward as explicitly open. It has not been run as a complete audit of all process trees, file handles, timers, temp-directory writers, listeners, ports, watchers, and lock files.
- **Private repositories.** `api` and `web` were not present in this workspace and were not audited.

## Partially Verified

- **Process-tree lifecycle correctness.** Config and the isolated scheduler e2e path were checked with live Windows process evidence. Budget/provider tests passed, but no dedicated post-completion process-tree capture was completed for those two test files; classify their lifecycle status as partial, not fully verified.
- **Scheduler behavior.** Direct worker execution and isolated e2e behavior are verified. The combined test file remains partially verified because Windows config replacement fails under concurrent access.
- **Sandbox/platform coverage.** Prior MCP evidence was collected in an environment without `bwrap`/`sandbox-exec`, where output stated: `[sandbox] no bwrap (Linux) or sandbox-exec (macOS) found — running tests unisolated.` Windows process cleanup was tested, but Linux sandbox isolation was not established by this report.
- **Historical resolved claims.** No attached session report, handoff document, prior report, or Git history was available in this workspace. Prior claims therefore remain unverified here unless their raw command/output is supplied.

## Scope and Product Decisions

These are decisions, not engineering fixes:

- Beta language scope is **TypeScript and Python**. This is recorded in `BETA_SCOPE.md`.
- The hosted `api` and `web` repositories are outside this public checkout.
- The public repository contains `core`, `cli`, and `mcp-server`; the MCP server currently exposes four tools according to the prior raw MCP evidence: `purix_status`, `purix_modify`, `purix_index`, and `purix_ingest`.
- No separate `purix_index_full` MCP tool is recorded as a product decision; full indexing is an argument path on `purix_index`.

## Claimed, Not Verified

- Any previously resolved item whose raw command and output existed only in the missing session report or an unavailable handoff document.
- Any claim that the complete core suite is `353/353` after the lifecycle fixes.
- Any claim that all temp-directory cleanup sites are safe under Windows file-handle semantics.
- Any claim that all network listeners, watchers, ports, lock files, and timers terminate cleanly after every test.

## Information Needed

1. The missing `TEST_REPORT_2026-09-07.md`, including its full §2 not-attempted list and §3 deep-audit prompt.
2. The prior handoff/architecture report and the full list of historically resolved items.
3. Raw command/output attachments for those historical items, especially any claim involving concurrency or process cleanup.
4. Access to the private `api` and `web` repositories if their testing status belongs in the finalized project report.
5. A product decision on whether Windows config replacement should retry transient `EPERM` failures.
