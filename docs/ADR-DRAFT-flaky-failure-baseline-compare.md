# ADR draft: flaky and pre-existing test failures are judged against the unmodified code

Status: **DRAFT, not ratified.** Research 06 section 8, item 4 asks for this ADR. It records what the code does as of 2026-11-10; it does not settle the open questions at the end.

## Context
Until now, when a selected test failed, Purix re-ran the changed code once and forgave the failure if the re-run passed (quarantine only if the stored history was already mixed). Research 06 section 4 measured a test failing one run in two passing the gate 72 percent of 60 runs (formula 1 minus p squared: 75 percent). The Python provider has no re-run, so a failing pytest blocks.

## Decision (built for the TypeScript provider, in the sandbox path)
1. A failing test is re-run on the unmodified project, up to 3 times (`BASELINE_RUNS`), in a fresh verification copy made only when a test fails.
2. Failed there at least once: pre-existing or flaky. Not blocking. Named in `preExistingFailures` and on the console; one "fail" is added to the test history.
3. Passed there every time, or not reported there by name: this change's failure. It blocks, whatever a re-run of the changed code does.
4. No comparison possible (copy failed, none of the selected test files exist on the unmodified code, baseline run stopped, runner not found): nothing is forgiven.
5. Where no baseline is offered (the dependents re-check, where the change has already landed), the older re-run-and-forgive rule stays.

## Consequences
- A real intermittent regression is no longer forgiven by a lucky re-run of the changed code.
- A test that already fails before the change no longer blocks it. This is the research's design; it is a change in what Purix lets through and belongs in the release note.
- Cost: up to 3 runs of the selected set on the unmodified code, on a failure only.

## Not settled
- Whether the Python provider should get the same rule (today it blocks on any failure, so this would be less strict).
- Whether the dependents re-check should keep forgiving.
- The pass-through figures after the change (70 and 50 percent) are arithmetic that assumes the baseline fails as often as the change; not measured.
- Jest, Vitest and Mocha baseline reading is untested.
- Evidence: `packages/core/src/verify/tests_baseline_compare.test.ts` (7 tests; 6 fail on the old rule).
