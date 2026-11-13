// src/verify/test_counts.ts
//
// The count rule (research 06 section 1, ADR-069): a pass must mean at least one test ran and passed, counted from the runner's
// own report, whatever the exit code said. Pure functions, no I/O, so every runner shares one rule and it can be tested without
// starting a runner.
//
// Skipped and todo entries are NOT evidence. They are neither passes nor failures: they are left out of the pass count, left
// out of the failure path (a skipped test is never re-run or forgiven), and a run in which nothing else happened is "not tested".

/** What a runner's report says about one test. `skipped` covers skipped, pending, todo and disabled. */
export interface CountedTest {
  passed: boolean;
  skipped?: boolean;
}

export interface TestCounts {
  passed: number;
  failed: number;
  skipped: number;
}

/**
 * ran:          at least one test passed or failed, so the run exercised something. Failures are the caller's to handle.
 * no_tests_ran: the report holds no tests at all and the run exited 0.
 * all_skipped:  the report holds only skipped / todo entries and the run exited 0.
 * unreported:   nothing to count and a non-zero exit. The run may have crashed (a syntax error, a missing module), which is a
 *               failure of the code, so this rule stays out of it and the caller keeps its existing failure path.
 */
export type CountVerdict = "ran" | "no_tests_ran" | "all_skipped" | "unreported";

export function countTests(tests: readonly CountedTest[]): TestCounts {
  const counts: TestCounts = { passed: 0, failed: 0, skipped: 0 };
  for (const t of tests) {
    if (t.skipped) counts.skipped += 1;
    else if (t.passed) counts.passed += 1;
    else counts.failed += 1;
  }
  return counts;
}

export function assessTestReport(tests: readonly CountedTest[], exitCode: number | null): TestCounts & { verdict: CountVerdict } {
  const counts = countTests(tests);
  if (counts.passed > 0 || counts.failed > 0) return { ...counts, verdict: "ran" };
  if (exitCode !== 0) return { ...counts, verdict: "unreported" };
  return { ...counts, verdict: tests.length === 0 ? "no_tests_ran" : "all_skipped" };
}

export interface PytestCounts extends TestCounts {
  xfailed: number;
}

/**
 * pytest exits 0 when every test is skipped, so its exit code cannot be the whole story. The final summary line carries the
 * counts ("3 passed, 2 skipped in 0.02s"). Returns null when no summary line can be read: the caller must not guess from nothing.
 * An expected failure ("xfailed") proves nothing about the code, so it is never counted as passed.
 */
export function parsePytestSummary(stdout: string): PytestCounts | null {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!/\bin \d+(\.\d+)?s\b/.test(line)) continue;
    const found = new Map<string, number>();
    for (const m of line.matchAll(/(\d+) (passed|failed|skipped|xfailed|xpassed|errors?)\b/g)) {
      const key = m[2] === "error" ? "errors" : m[2]!;
      found.set(key, (found.get(key) ?? 0) + Number(m[1]));
    }
    if (found.size === 0) continue;
    return {
      passed: found.get("passed") ?? 0,
      failed: (found.get("failed") ?? 0) + (found.get("errors") ?? 0),
      skipped: found.get("skipped") ?? 0,
      xfailed: found.get("xfailed") ?? 0,
    };
  }
  return null;
}
