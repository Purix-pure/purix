# Handoff 2026-11-23: merge audit, duplicate check, plan completion

Inputs: `packages.zip` (base, 0.4.0-beta.5), `purix-observability-overlay.zip` (46 files; it contains the earlier overlay and the `files_11.zip` work), `purix-dashboard-overlay.zip` (16 files), `purix-overlay-2026-11-23.zip` (17 files), and the notes and plan you attached. Everything below was run on Linux, Node 22, with no real model. Nothing was run on Windows, macOS or Node 26, and no real OSV or registry reply was used.

## 1. Result

1. **The merge is done and builds.** Order: base, then observability overlay, then dashboard overlay, then two files that fix the security-scan list (section 4). All imports resolve; build, typecheck, all three test suites and every repo gate pass (section 2).
2. **`purix-overlay-2026-11-23.zip` is not applied as a layer.** Its shared files are already inside the dashboard overlay at the same paths, and its own versions of `budget.ts`, `core/package.json`, the digest and the policy-block code are the second copy of work the observability and dashboard sessions did. What was worth keeping from it was ported by hand (section 4).
3. **Five tasks were done twice by different sessions:** the `policy_block` event, the "budget left" line, the digest, the list of what the security scans look for, and the read-only reader test. One copy of each is in the tree (section 4).
4. **Duplicated source code is low** (0.4%), and none of it comes from this round except one 9-line clone (section 2).
5. **Plan:** the data layer, result line, `watch`, `statusline`, `dashboard`, `digest`, `feedback`, rework and revert counts are in the tree, and their tests pass. Not built: OpenCode panel, changed-line coverage, duplication check, benchmark mode, pull-request receipts (section 5).

## 2. What was run on the final tree

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | ok |
| Build core, mcp-server, cli (each package's own build; `pnpm build` through turbo fails in this sandbox with "Exec format error" before any task runs, cause not found, so run it on your machine) | ok |
| Typecheck core, mcp-server, cli | clean |
| Core tests | 3,436 run, 3,433 pass, 0 fail, 3 skipped (the existing skips) |
| MCP server tests | 167 of 167 |
| CLI tests | 394 of 394 |
| Gates: core boundary, import cycles (292 files), core exports (116), single-point (R6 = 0), env docs (29), tool boundary, no toolchain artifacts, versions (24), claims, checks page | all ok |
| ESLint on the changed and new source files | clean |
| Built CLI in a throwaway git project, no store | `status`, `budget show`, `digest`, `watch --once`, `statusline` answer sensibly; `digest --days 0` and `feedback maybe` exit 2 |
| Built CLI with a recorded verification and a `policy_block` | `digest` lists "Stopped before landing: 1" with the reason; `digest --json` parses; `watch --once` prints a STOPPED line; `statusline` prints "0 landed · 1 stopped"; `budget show` ends "($5.00 left)"; registry file written |
| Dashboard over HTTP | no token: 403; token: 302 to the page; wrong `Host`: 403; POST: 405; the project's Catches tab shows the blocked secret event |
| Source duplication (jscpd, non-test source, 6+ lines) | 22 clones, 177 lines, 0.4%. All small and older than this round, except one 9-line clone between `digest.ts` and `observe.ts` (opening the ledger). Not refactored: a shared helper would change two commands for 9 lines |

Not checked: the dashboard rendered in a real browser (I fetched the HTML only), `statusline` fed real Claude Code JSON on stdin, `purix dashboard` opening a browser, anything on Windows.

## 3. Problems found and fixed

| # | Problem | Evidence | Fix |
| --- | --- | --- | --- |
| 1 | The claims gate failed (3 rows: F03-02, F03-11) because the observability work reshaped `full_audit.ts` and `classify.ts`; the register still looked for the old lines | `check-claims` failed; I read the new code: the audit still runs the vulnerability scan, and `classify.ts` still sends the scrubbed prompt (`provider.generate(outbound, ...)`) and returns the scrubbed reply | Three evidence strings updated in `docs/claims.json`. The claims themselves still hold. Gate and checks-page pass |
| 2 | The Security panel says "Not looked for: anything else", but `purix modify` runs an advisory scan (rate limiting, input validation, `eval`) that the list left out. That scan prints only; it records no event | `lifecycle.ts` line 405; `security_audit.ts`; the list in `security_gate.ts` | Fifth group added to `SECURITY_CHECK_GROUPS`; its drift test now reads `security_audit.ts` too. Mutation check: removing an entry fails the test; renaming a category in the scanner fails the test; restored, both pass (410 gate tests) |
| 3 | The CLI test suite wrote `projects.json` and the usage ledger into the real `~/.purix` (said in the observability notes) | Reproduced with an empty HOME | `scripts/test_user_dir.mjs` preload sets `PURIX_USER_DIR` to a temporary folder. After the full CLI suite the home folder has no `.purix` |
| 4 | The MCP server suite left a pending tool-approval file in the real `~/.purix`. Present in the base tree too, not from any overlay | Reproduced on `packages.zip` alone | Same preload in `packages/mcp-server`. Clean after the run |
| 5 | `docs/OBSERVABILITY.md` listed rework, secrets and dependency events, audit history and the weekly digest as "not built yet" | The code and tests exist | Paragraph corrected |
| 6 | `purix digest --json` (in the 11-23 version) was lost when the dashboard version replaced it | Option list of `digest.ts` | Restored: prints both periods' summaries as JSON; a test parses it |
| 7 | The no-store case for `policy_block` (no store means no event and no store created) was tested only in the 11-23 copy | Test list of the dashboard copy | Test added; mutation check: removing the `storeExists()` guard fails it |
| 8 | A busy repository lock stopped `purix digest` in the 11-23 version (it was not in `READ_ONLY_COMMANDS`; it exited with "already locked") | Test that holds the lock and fails without the listing; reproduced on that version | The dashboard version is already listed read-only. The test is kept as a regression test (`digest_busy_lock.test.ts`) |
| 9 | `[Unreleased]` in the changelog was empty | | Entry added for the whole round |
| 10 | `BETA_SCOPE.md` said the free tier enforces 25 components (`licensing/tier.ts` has had no cap since 2026-11-02) | | Already corrected in the observability overlay's `BETA_SCOPE.md`; my own earlier edit is not needed |

## 4. The same task done more than once, and what the tree now has

| Task | 11-23 session | Observability and dashboard sessions | In the tree |
| --- | --- | --- | --- |
| `policy_block` event | `count`, `categories`, `severities`, `formats`, `files` | `findings`, `categories`, `files`, tests for both stop points | The dashboard copy. The reader, `watch` and the Catches tab use the event kind, `categories` and `files`; none uses the 11-23 extras. Lost: `severities` and `formats`. Added back: the no-store test |
| Digest | `core/state/digest.ts` on raw events | `digest.ts` on the shared ledger reader, compares with the previous period, same numbers as the dashboard | The reader-based one, plus `--json` (this round). `--days` is 1 to 90 (the 11-23 one allowed 366) |
| "Budget left" | `Estimated left: $x.xxxx.` | `Estimated spend: … (… left)` | The observability wording |
| List of what the scans look for | `security/scan_coverage.ts` (24 categories, limit statements) | `SECURITY_CHECK_GROUPS` in `security_gate.ts`, used by the dashboard | The dashboard mechanism with the advisory group added (problem 2). The 11-23 limit statements are not carried over: nothing displays them |
| Read-only reader test | raw read-only SQLite connection | `ledger_reader_wal.test.ts`, through the shipped reader | The reader version |

Files from the 11-23 overlay that are therefore absent: `core/state/digest.ts` and its test, the `./state/digest` export, `security/scan_coverage.ts` and its test, `manifest/store_readonly_reader.test.ts`.

`files_11.zip`'s 15 files are inside the observability overlay: 13 are byte-identical, and the two that differ (`events.ts`, `resolve_verification.ts`) are the two the notes say were merged by hand.

## 5. Plan completion: "Showing developers what Purix did"

**In the tree and passing tests** (suite results above; smoke checks where named):

| Item | Evidence |
| --- | --- |
| One change id per change | `observe/change_context.ts`; events carry it; `observe.test.ts` |
| Test counts and verification time on the verification event | `sandbox.ts`, `verify.ts`; `digest` shows "did not record test counts" for runs without them, never zero |
| Approval wait times kept | `approvals/wait_times.ts` and test |
| Events: secrets removed, dependency lookup, audit run, rolled-back apply, policy block, change landed | `events.ts` kinds; emitters behind `storeExists()`; tests in core |
| "Did this help?" record | `purix feedback` (bad input exits 2, smoke); `change_feedback` events |
| Project registry | `projects.json` written in the smoke run |
| Ledger schema version | `observe/ledger_version.ts` |
| Result line on MCP replies, off with `PURIX_RESULT_LINE=off` | `result_line.test.ts` (mcp-server) |
| `purix watch` | smoke run; guard test that every stop kind has a STOPPED line |
| `purix statusline` | smoke run (own output only) |
| `purix dashboard`: home, project page, six tabs, change receipt, `/how`, JSON export, redact switch, version stamp, loopback, token, Host check, GET only | smoke run over HTTP; `dashboard.test.ts` |
| Rework (14 days) and git reverts, kept apart from Purix's own undo | `state/rework.ts` and test; smoke shows "nothing old enough to judge yet" |
| Digest | one copy, with `--json` |
| Budget left | in `budget show` |
| Security panel names what was scanned | complete after problem 2 |

**Not built, by any session:** OpenCode sidebar and footer panel (needs the plugin API of the installed version), changed-line coverage producer, optional duplication check, benchmark mode and the saving against a plain agent (the dashboard says "not measured"), pull-request receipts (the store does not travel with a clone, so the source of the bundle is undecided), a telemetry preview page, a `purix check` state on each dashboard card.

**Decisions from the plan or the notes (answered in section 7):**
1. `check-single-point` rule R6 exempts `cli/dashboard/server.ts` (inbound listener on 127.0.0.1) instead of routing it through `platform/net.ts`.
2. Rework counts per component, not per line (the audit chain holds identifiers only); the plan suggested lines.
3. Dependency lookup stays off (`PURIX_DEP_LOOKUP`): it sends package names to the registries and OSV.
4. `purix digest --days` upper bound 90 against the old 366.
5. Windows first checks, per the notes: the registry path, opening a browser from `dashboard`, a long project path.

## 6. What was not run

A real model, real OSV or registry replies, Windows, macOS, Node 26, a browser rendering of the dashboard, a real agent session. `PURIX-SELF-TEST-PROMPT-LLM-VIA-MCP.md` needs a provider key, OpenCode and spend, and was not run. `PURIX-OBSERVABILITY-NOTES.md` and its `__1_` copy are byte-identical.

## 7. Open decisions: answers from research

Evidence labels: **code** = read in the tree; **run** = executed here (Linux, Node 22, no real model); **source** = external page; **open** = cannot be settled from here.

| # | Decision | Answer | Evidence |
| --- | --- | --- | --- |
| 1 | R6 exemption for `cli/dashboard/server.ts` | **Keep the exemption.** `platform/net.ts` is built for outbound calls (timeouts, size caps, scrubbing); the dashboard is the only inbound listener, binds `127.0.0.1`, and calls nothing. Routing a listener through an outbound wrapper would not add a protection. R2 and R6 cannot see `http.request` in that file, so a guard test now holds the exemption's premise: one `node:http` import (`createServer`, `Server`), no other network module, no `fetch`/`request`/`child_process`, every `listen` on `127.0.0.1` | code (`check-single-point.ts`, `net.ts`, `server.ts`); run: `server_no_outbound.test.ts` 3/3, mutation (an added `node:http` import) fails it, restored passes |
| 2 | Rework per component or per line | **Per component.** The hash-chained audit log stores identifiers only (no lines, no diffs), so per-line would need a new store of code, which `PRIVACY.md` rules out. The two outside definitions measure other things: DORA's rework rate is the share of deployments that are unplanned fixes; GitClear's churn is code reverted or significantly altered within two weeks, and is correlational. Purix takes only the 14-day window from GitClear. The `rework.ts` header claimed it "follows GitClear's definition"; corrected | code (`rework.ts`, `landed_change.ts`); source: DORA 2024 report and GitClear churn definition; run: rework tests pass |
| 3 | Dependency lookup default | **Stay off** (`PURIX_DEP_LOOKUP`). It sends package names and versions to the registries and OSV (querybatch takes names and versions, no account). D-q in `DECISIONS-2026-11-12.md` made it opt-in. Reopen after one real-machine run with real OSV replies. `PRIVACY.md` does not yet describe this egress, the registry file, stored `policy_block` paths or the local dashboard: that is a task, not a decision | code (`dep_lookup.ts`, `PRIVACY.md`); source: OSV API docs; **not run**: no real OSV reply |
| 4 | `digest --days` upper bound | **Keep 90.** Log retention is 365 days and the digest compares with the previous period, so a window of N reads 2N days: 90 gives 180, the old 366 would reach 732 and compare against deleted data. Add a note in the digest when the older period is cut by retention | code (`scheduler.ts` retention 365, `digest.ts`); run: `--days 0` exits 2 |
| 5 | Windows first checks (registry path, browser open, long path) | **open.** Needs a Windows run. Nothing here can answer it | not run |
| 6 | First reader of the receipts | A solo developer on one machine. `BETA_SCOPE.md` excludes team and hosted features from Release 1 | code (docs) |
| 7 | Hosted export format | The signed `audit-export.json` already exists and is the natural base. Do not design a second format before a team view is in scope | code |
| 8 | Benchmark mode (saving against a plain agent) | A script in the pattern of `scripts/eval-l1.ts`, not a runtime command: it needs a real model and spend. The dashboard says "not measured" until then | code |
| 9 | Result line default | **On** (about 24 tokens a reply, `PURIX_RESULT_LINE=off` turns it off). Add a test for the length cap | code (`result_line.ts`) |
| 10 | OpenCode sidebar and footer panel | **Do not build yet.** Sources disagree on slot names; build against the installed version's types | source (OpenCode TUI plugin docs, conflicting); **not run** |

## 8. Plan tasks still not done

Not built by any session:
1. OpenCode sidebar and footer panel (blocked on decision 10).
2. Changed-line coverage producer.
3. Optional duplication check.
4. Benchmark mode and the saving against a plain agent.
5. Pull-request receipts (the store does not travel with a clone; the bundle's source is undecided).
6. Telemetry preview page.
7. `purix check` state on each dashboard card.
8. Receipt lines "Rework risk" and "Dependencies added".
9. Four-week trend lines; per-agent split inside a project.
10. Displays for drift (reconciliation), library reuse, `memory_recorded`, escalation aggregates, risky files by pattern.
11. `statusline` auto-wiring into Claude Code settings.
12. Result-line length-cap test and measurement.
13. Digest: note when retention cuts the older period; docs page for `purix digest`.
14. `PRIVACY.md` updates (dependency-lookup egress, registry file, stored `policy_block` paths, local dashboard).

Needs a machine this sandbox is not: Windows checks (decision 5), a real-model self-test run, real OSV and registry replies, a browser rendering of the dashboard, `statusline` fed real Claude Code JSON. Done in this pass: the stale `/how` sentence in `pages.ts`, the `rework.ts` comment, the server guard test.
