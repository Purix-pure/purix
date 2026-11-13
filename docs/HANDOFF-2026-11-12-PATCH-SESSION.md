> **Already merged (2026-11-12).** Do not apply the patch or zip this note describes: its work is in this tree. See `docs/HANDOFF-2026-11-12-MERGE.md` for what was kept, dropped and de-duplicated.

# Handoff, 2026-11-12: six open items from plan v6, each reproduced or test-first

Base: `packages.zip` as uploaded on 2026-11-11 (it already held R1-d, D-j, D-o, D-h and R1-f from the earlier session). Apply: `patch -p1 < purix-session-2026-11-12.patch` from the repository root (checked with `--dry-run` against a clean copy). The patch also deletes `packages/cli/src/cli/commands/index_headline.test.ts` (plan v6 section 9; it was still in the zip and broke the CLI typecheck), `scripts/benchmark-cli-help.mjs` and `purix-mcp-smoke-test.mjs` (nothing references them). After applying, `docs/WHAT_PURIX_CHECKS.md` is already regenerated.

## What was done
| Item | Change | Red before the fix |
|---|---|---|
| F03-02 / F03-03 first part | `gates/manifest_delta.ts` + hook in `runSecurityGate`. A package.json is judged against its `base`: git / GitHub shorthand / tarball dependency blocks; added or changed preinstall/install/postinstall blocks; path or link dependency is an advisory; every added or raised dependency is an advisory saying it was NOT looked up for vulnerabilities; a changed `registry=` in `.npmrc` blocks | 22 of 28 new tests |
| R1-c (E3c) | The repair loop returns `triedStates`; `resolveVerification` passes them to `runEscalation(..., { alreadyTried })`, which seeds its guard | 4 of 5 new tests |
| R1-b | `--override-trust` behavioural tests (abort without it, not lifted by the other two flags, lifted by it with one TrustGate audit row, ignored by `--dry-run`). Harness: fake classifier confidence, optional related test with `tsx` linked | Mutation: disabling the flag fails test 3 |
| Index/check contradiction (new) | `check.ts` drift section skips the `purix-codebase-index` row. Reproduced with a real `purix index`, hand edit, `purix check` (exit 1, "across 0 governed components") | 1 of 2 new tests |
| Scripts | Runner: unknown `--only`/`--skip` group, or no stage left, exits 2 (was green with zero stages). Speed test: scale sizes 500/2,000/8,000, stops at 30 s | `--only gatess` exit 2 checked by hand; scale run 167/208/369 ms, slope 0.42 |
| Claims | F03-02 fix block; F07-06 and F05-09 notes and `not_covered` rewritten | check-claims ok, 149 rows |

## Results (Linux, 2 CPUs, Node 22.23.4, pnpm 12.4.1; nothing real-machine)
- core 2,877 tests, 2,874 pass, 0 fail, 3 skipped; serial 19 of 19; mcp-server 133 of 133; cli 289 of 289
- `tsc --noEmit` clean in all three packages; boundary, single-point, tool-boundary, artifact, env-docs, import-cycle checks exit 0; checks page current; ESLint on the changed files: 0 errors
- `packages/core/.purix` absent after the full core run

## Not done, and why
- **No vulnerability or existence lookup.** The gate is synchronous and ADR-009 keeps the network out of its path; research 03 (3.1, 3.4) wants a lookup of the added (name, version) pairs online, which sends package names off the machine. That is your ruling (D-q below). `npm audit` after the change was rejected: the sandbox does not install, so it would audit the old lockfile and report the new dependency clean.
- Lockfile `resolved`-host and integrity diff, requirements.txt, pyproject.toml.
- `Math.random` in `llm/call_failure.ts` left alone: it is retry jitter, not a security value.
- `docs/client-runs.json` still has the `<the version text>` placeholder: only you know the real OpenCode version. Its note ("Empty means...") is stale.
- Not touched: R1-a (your running session), F05-06/07 follow-ups, SSRF at `platform/net.ts`, zip-slip, independent read of the new fixes (I wrote them, so I cannot read them), compliance sweep.
- Real agent (C5 stderr), Windows, macOS, Docker, GitHub workflows, real bubblewrap: never run.

## Decision for you
- **D-q: network lookup of added dependencies.** My recommendation: allow it as opt-in first (a new egress purpose through `platform/net.ts`, names and versions only, project registry or OSV, "not checked" when unreachable), then decide the default after one real-machine run. It needs the gate or `verifyInSandbox` to become async, or the lookup to run in the callers.
