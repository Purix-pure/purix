# Handoff, 2026-11-12: merge of all scattered work on top of packages.zip (final)

Base: `packages.zip` (v7 tree). Apply: unzip this archive over the repository root. No file is deleted. Build order for tests: core, mcp-server, cli (the CLI suite needs `packages/cli/dist`).

## What was merged, in this order
1. Complete tree (`purix-complete-tree-2026-11-12.zip`): duplicate-sweep fixes (E3c tests kept in one place, git/URL dependency no longer reported twice), flat compliance docs.
2. Larger follow-up patch (14 files). The smaller follow-up patch is a subset and was not applied.
3. F03 decisions: D-q, D-r, D-s, F03-03, F03-02 lookup, lockfiles, pyproject, F03-08.
4. F06-04: changed-line coverage (node:test only).
Overlaps (`sandbox.ts`, `claims.json`, `WHAT_PURIX_CHECKS.md`) merged three-way against the base with no conflict. One conflict, the import block of `gates/security_gate.ts`, was resolved by keeping both sides.

## Fixed in this round
- F03-07: `password: parts[2]` (an index access) was flagged as an unquoted password. Red first (4 of 7 new tests failed), then one lookahead in `security/secrets.ts`. New file `security/secrets_index_access.test.ts`. The unquoted TOKEN rule was probed with the same cases and did not need the change, so it was left alone.
- Stale comment on `advisoryLookup` in `gates/security_gate.ts` corrected.
- Lint error in `cli/commands/status_index_line.test.ts` (unnecessary type assertion) removed.
- Not changed: `docs/claims.json` and the checks page do not mention the index-access fix. Add one line to F03-07 if you want it recorded.

## Duplicates found
- Uploaded twice, identical: merged patch (2 copies), plan v7 (2 copies).
- Small follow-up patch is a subset of the larger one.
- Five identical pairs under docs/compliance/ (top-level plus iso-42001/ or eu-ai-act/). Already in the base, other documents link to both paths, left alone. Belongs to the compliance sweep (plan 6.2).
- Kept on purpose: package.json parsed in both manifest_delta.ts and dep_delta.ts (different questions).

## Tested on the merged tree (Linux, 2 CPUs, Node 22.23.4, pnpm 12.4.1)
- Core: 2,987 tests, 2,984 pass, 0 fail, 3 skipped; serial group 19 of 19; `packages/core/.purix` absent afterwards.
- mcp-server: 140 of 140.
- cli: 294 tests. 293 passed on the first run; the one failure was the MCP stdout purity test, which needs `cli/dist`. After building the CLI it passes. The full cli suite was not rerun after the build.
- `tsc` clean in all three (core built first; mcp-server and cli builds ran).
- boundary, cycle, single-point, env-docs, artifact, tool-boundary checks: exit 0. check-claims ok (149 rows). Checks page current.
- ESLint on all changed files: 0 errors (about 190 warnings, all existing `no-unsafe-*` style).

## NOT tested
Coverage gate (`pnpm run coverage`, the 90 percent bar; F03 and F06-04 both added code in covered folders). `release-check.mjs`. Language conformance. Windows, macOS, a real agent, a real MCP client. Live OSV and registry calls (reply shapes are from documentation; whether OSV omits withdrawn records is unknown). Lockfile readers against real files from npm, pnpm, yarn classic and Berry, poetry, uv. Nobody but the authors has read F03 or F06-04.

## Left per the v7 plan (checked against what this merge added)
Done by this merge: F03-03, F03-02 lookup and lockfiles and pyproject, F03-08 (removes the lockout, detection still 7 of 18), F06-04 wiring for node:test.
Still open, code:
- R1-a (your running session): F05-06, F05-07, Python spawn budgets, Python BOM, a lock stamped in the future. Take that session's patch against this tree.
- R1-b remainder: a full fake-model run that reaches the TrustGate abort.
- F06-04 remainder: Jest, Vitest, Mocha and Python producers; the MCP server does not fill the field; the confidence step does not use the number; cost on a large project not timed.
- F06-02 remainder (needs D-e), F05-01 wiring and F05-09/F05-10 (needs D-l, one owner of `manifest/`), F07-05 (needs E4), F07-07, F08-02 (needs D-d), F00-04/05/06, F03-12.
- H1 to H7 catalogue items (types, sync calls, untrusted input, edge cases, operations, release hygiene, A6 measurement), not started.
Still open, non-code:
- Independent read of every recent fix by a session that wrote none of them (F03-07 with this change, F00-07, F05-10, F07-06/E3c, F06-02, F03-02 and F03-03, F03-08, F06-04, R1-d, C3, C4, override-trust tests).
- Claims housekeeping: F00-07 `not_covered` is a wrong copy of F03-05's text; trim `not_covered` of F03-05, F06-05, F01-06, F03-09, F04-04.
- docs/compliance sweep (stale figures: secrets now block, C5, override split, audit trail; new D-q/D-r text). Refresh test counts in docs/TESTING-PLAN.md.
- N6 rest (19 findings), N7 (not started), `version` in docs/client-runs.json, formatter on python_test_integrity.ts.
- Testing plan steps 2 to 8.
Only you: real-machine pass (A10e, C5 stderr on an allowed edit in Claude Code, Codex, Cursor), Docker build, a GitHub push for workflows, first npm publish, CODEOWNERS handle, rulings still open (D-e, D-l, D-d, decisions 4, 7, 10).
