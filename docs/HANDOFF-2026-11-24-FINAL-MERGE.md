# Handoff 2026-11-24: merge of the outcomes and receipts/statusline overlays

Base: `packages.zip`. It is identical to `packages-final-2026-11-23-r2.zip` (apart from `.gitignore` and `repeat-run-logs/`) and already contains the whole r2 overlay (65 files byte-identical). Not applied, because older: `purix-final-overlay-2026-11-23.zip`, `purix-merge-fixes-2026-11-23.zip`.

## What was merged
Two overlays built on the same base, never merged before: `purix-outcomes-overlay.zip` (20 files) and `purix-overlay-2026-11-24.zip` (17 files). 32 files changed in total; 5 were touched by both (`pages.ts`, `ledger_reader.ts`, `digest.test.ts`, `OBSERVABILITY.md`, changelog).

## The one design choice
Both overlays built the receipt lines "Dependencies added" and "Rework risk". Kept: the 11-24 version (`reworkOfChange` in `state/rework.ts`, rich `ChangeDependencies`). Dropped: the outcomes `markReworkRisk` and its count-only `ChangeDependencies`.
Evidence: `reworkOfChange` uses the same rule as the project number (`reworkWithin`: judged kinds create/modify/ingest, touching kinds modify/ingest/accept_drift/delete). `markReworkRisk` counted any later landed change on the component, so a receipt could disagree with the project total. The 11-24 parser matches the real `dependency_lookup` event (`mode`, `registry.exists`, `advisories.pairs`, `missing_names`, `vulnerable`, checked in `security/dep_lookup.ts`) and keeps the package names; the outcomes parser dropped them. The outcomes "Changed lines" line, `purix receipt`, trend, Process panel, `/telemetry` and duplication check are all kept.
Edits made to merge: `ledger_reader.ts` (one dependency/rework model, coverage kept), `pages.ts` (`receiptFor` matches the chain entry and judges rework; one `receiptLines`), `outcomes.test.ts` (rework-risk tests removed; they are covered by `rework.test.ts`), `dashboard_outcomes.test.ts` (fixture uses the real event shape and writes a chain entry; without one the receipt says "not judged"), `OBSERVABILITY.md` (outcomes text).

## What was run (Linux, Node 22, no real model)
Typecheck core, mcp-server, cli: clean. Builds: ok. Core 3,471 run, 3,468 pass, 0 fail, 3 skipped (the old skips). MCP 167/167. CLI 420/420. Ten gates ok: claims, core boundary, core exports (117), import cycles (295 files), single-point (R6=0), env docs (30), tool boundary, no toolchain artifacts, versions (24), checks page. ESLint clean on the 27 changed source files.
Not run: Windows, macOS, a browser, a real Claude Code or OpenCode session, a real model, real OSV/registry replies, `pnpm build` through turbo.

## Still not built
OpenCode panel (needs the installed plugin API), benchmark mode and the saving against a plain agent, `purix check` state on dashboard cards, per-agent split inside a project, Python changed-line coverage, pull-request evidence beyond `purix receipt`.
## Decisions still yours
Pull-request receipts source; benchmark in CLI or script; dependency lookup default (off now); R6 exemption for `dashboard/server.ts` (kept, guarded by `server_no_outbound.test.ts`). First real checks: `purix statusline --install` in a real Claude Code project, the dashboard in a browser, Windows registry path.
