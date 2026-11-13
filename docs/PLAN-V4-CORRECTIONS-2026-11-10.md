# Plan v4 (2026-11-08): what no longer matches the tree, as of 2026-11-10

Read from the code and from the 11-10 handoffs. Not re-read by anyone else.

| Plan v4 says | The tree now |
| --- | --- |
| Decision 6 (which version) open; D-a, D-b, D-c open | Versions set to 0.4.0-beta.0 and decisions written in `docs/DECISIONS-2026-11-08.md` (in the earlier changed-on-top zip). D-a still cannot be built as worded: the commit trailer holds only a head hash, with no machine identifier |
| "Indexing was measured quadratic"; the index speed stage fails | `purix index` no longer verifies each file: it lists files and records symbols, all `pending`, result `verification: "not_run"`. 206 files 0.44 to 0.49 s; 10,000 synthetic files 0.88 s (one machine) |
| `--incremental` and `--full` on `purix index` | Never read by `runIndex`; the CLI help now says so |
| 6.1 table: "L3 payload log keeps metadata only" not proven | `call_log_no_prompt_text.test.ts` searches every byte written by `callLlm` (success, provider error, bad reply); Linux and a stubbed fetch only; audit-event writers not covered |
| 6.3 F06-02: "reproduce a 1-in-2 flaky failure passing; design baseline compare" | Built for the TypeScript provider in the sandbox path (`BASELINE_RUNS` = 3). Dependents re-check and Python unchanged. See `HANDOFF-2026-11-10-F06-02.md` and `ADR-DRAFT-flaky-failure-baseline-compare.md` |
| 6.3 F06-04: "no producer for `changedLineCoverage`" | Still no producer. The pure parts now exist (`verify/changed_line_coverage.ts`: line diff, lcov reader, changed-line numbers); the runner call and the trust-gate step are not built |
| Section 9 baseline: core 2,527 tests | With the earlier overlay, core 2,538 (11-10 unowned-items session). Plus 21 new tests from this session (7 + 14), not part of a full run |
| Section 11 / single-point check | `verify/tests.ts` had to be kept at or under its allowed count of console calls; it now has 2 |
