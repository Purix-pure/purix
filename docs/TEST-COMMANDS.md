# Purix test commands, one part at a time

Run every command from the repository folder (the one that holds `package.json`). On Windows use PowerShell. Each command tests a different thing and can be run alone.

**Before the first run, once:** `pnpm install` then `pnpm run build`.

**Safe by design.** The test runners give every test its own empty home folder and temp folder, so a test cannot read or change your real `~/.purix` (your keys and login). Run tests through the commands below, not with a bare `node --test`, which does not do this.

## 1. Everything, in one go

| What | Command |
| --- | --- |
| The whole plan (32 stages, one log each, a `SUMMARY.md` at the end) | `pnpm run test:all` |
| The same, one test file at a time (use on Windows) | `node scripts/purix-04-run-all.mjs --serial` |
| List the stages without running | `node scripts/purix-04-run-all.mjs --list` |
| Skip the slow groups | `node scripts/purix-04-run-all.mjs --skip slow` |
| Also run the live dependency-audit check (needs internet) | `node scripts/purix-04-run-all.mjs --network` |

Logs go to `.test-logs\<time>\`, summary in `SUMMARY.md` and `summary.json`.

## 2. One group of stages

`node scripts/purix-04-run-all.mjs --only <group>` (several groups: `--only gates,tests`).

| Group | What it covers |
| --- | --- |
| `gates` | Dependency install, boundaries, single-point, env docs, import cycles, tool boundary, build junk, versions, claim ledger, checks page, types, lint |
| `build` | Build all packages |
| `speed` | Command speed and index-size scaling |
| `tests` | Core, mcp-server and cli test suites, and the no-leftover-state check |
| `coverage` | The 90% coverage gate |
| `conformance` | TypeScript and Python checks agree |
| `flows` | Lock, hook, bypass flows; agent connect; MCP smoke test |
| `release` | Pack, clean install, versions, tarball contents, audit |
| `windows` | The Windows real-machine test |

## 3. Each test suite

| What | Command |
| --- | --- |
| Core suite | `pnpm --filter @purix/core test` |
| mcp-server suite | `pnpm --filter @purix/mcp-server test` |
| cli suite | `pnpm --filter @purix/cli test` |
| Core minus the coverage-gated folders (what `test:all` runs) | PowerShell: `$env:PURIX_CORE_SKIP_COVERED="1"; pnpm --filter @purix/core test` |
| Types, one package | `pnpm --filter @purix/cli typecheck` |
| Types, all | `pnpm run typecheck` |
| Lint | `pnpm run lint` |

## 4. One test file, or one test

```
node scripts/test-one.mjs <path to a .test.ts file>
node scripts/test-one.mjs <path> --name "part of a test name"
```

Examples, for the things built recently:

| What | Command |
| --- | --- |
| Dashboard (pages, protections, receipt, redact) | `node scripts/test-one.mjs packages/cli/src/cli/dashboard/dashboard.test.ts` |
| Dashboard never calls out | `node scripts/test-one.mjs packages/cli/src/cli/dashboard/server_no_outbound.test.ts` |
| Receipt | `node scripts/test-one.mjs packages/cli/src/cli/commands/receipt.test.ts` |
| Weekly digest | `node scripts/test-one.mjs packages/cli/src/cli/commands/digest.test.ts` |
| Watch and the other observability commands | `node scripts/test-one.mjs packages/cli/src/cli/commands/observability.test.ts` |
| Status line install / uninstall (CLI part) | `node scripts/test-one.mjs packages/cli/src/cli/commands/statusline_setup.test.ts` |
| Status line install / uninstall (core part) | `node scripts/test-one.mjs packages/core/src/observe/statusline_install.test.ts` |
| Result line | `node scripts/test-one.mjs packages/core/src/observe/result_line.test.ts` |
| Stored events and ledger reader | `node scripts/test-one.mjs packages/core/src/observe/observe.test.ts` |
| Secrets: old-store lookup | `node scripts/test-one.mjs packages/core/src/security/secrets_manager_walkup.test.ts` |
| Secrets: hook refuses reading key files | `node scripts/test-one.mjs packages/core/src/hooks/secret_read.test.ts` |
| Provider key status | `node scripts/test-one.mjs packages/core/src/llm/providers_key_status.test.ts` |
| Webhook notification | `node scripts/test-one.mjs packages/core/src/cli-io/notify.test.ts` |
| CLI command surface (every command registered) | `node scripts/test-one.mjs packages/cli/src/cli.integration.test.ts` |

## 5. Coverage

| What | Command |
| --- | --- |
| The 90% gate on `llm`, `licensing`, `gates`, `sandbox`, `verify` | `pnpm run coverage` |

It prints a table per file and fails if lines, branches or functions are under 90% over all those folders.

## 6. Speed

| What | Command |
| --- | --- |
| Every command's `--help` and a real run, the agent hook, the MCP server | `pnpm run speed` |
| Only one section | `node scripts/speed-test.mjs --only commands` (also `hooks`, `mcp`, `scale`) |
| Index time against project size | `node scripts/speed-test.mjs --only scale` |
| Steadier medians (3 to 50 runs, default 5) | `node scripts/speed-test.mjs --runs 9` |

The report is written to `.test-logs\speed\speed-latest.md`. A command that exists but is not listed in `scripts/speed-test.mjs` makes the run fail on purpose: add it to `READ`, `WRITE`, `CHAIN` or `HELP_ONLY`.

## 7. Gates, one by one

| What | Command |
| --- | --- |
| `core` never imports `cli` | `pnpm run boundary-check` |
| No new scattered console/fetch/env/`.purix` use | `pnpm run single-point-check` |
| Every environment variable is documented | `pnpm run env-docs-check` |
| No import cycles | `pnpm run cycle-check` |
| Tools install only through the broker | `pnpm run tool-boundary-check` |
| No build junk committed | `pnpm run artifact-check` |
| Versions agree everywhere | `pnpm run version-check` |
| Claim ledger | `node scripts/check-claims.mjs` |
| Checks page is current | `pnpm run checks-page:check` |
| Public exports are used | `pnpm run exports-check` |

## 8. Flows, language, release, Windows

| What | Command |
| --- | --- |
| Lock then strict check on a fresh checkout | `pnpm run ci-lock-flow` |
| Hook payloads of six agents | `pnpm run ci-hook-flow` |
| Simulated agent: hooks block a direct edit | `pnpm run ci-bypass-flow` |
| Every supported agent's connect config starts a server | `pnpm run connect-harness` |
| Real MCP server over stdio | `node scripts/smoke-test.mjs` |
| TypeScript and Python checks agree | `pnpm exec tsx packages/core/src/language/conformance/run.ts` |
| Pack, clean install, tarball contents | `node scripts/release-check.mjs package` |
| Windows real-machine test | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows-test.ps1` |
| Same, plus one real model call | add `-WithModel` |
| Live dependency-audit detection (internet) | `pnpm exec tsx scripts/verify-dependency-audit.ts` |

## 9. See it yourself (browser and CLI)

Make a small demo project, add the simulated records with `seed-demo.ts`, then:

| What | Command |
| --- | --- |
| Live events | `purix watch --once` |
| Last 7 days beside the 7 before | `purix digest` |
| A change's receipt | `purix receipt` |
| Status line text | `purix statusline --range all` (pipe `{}` into it) |
| Browser dashboard | `purix dashboard` |

## What a pass means

A pass means what the stage names, on that machine. The windows group is the only one that runs real Windows behaviour. Nothing here uses a real model unless you add `-WithModel`, and a stage marked NOT CHECKED was not run and is not a pass.
