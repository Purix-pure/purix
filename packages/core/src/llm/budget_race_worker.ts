// packages/core/src/llm/budget_race_worker.ts
//
// Standalone entry point spawned as a real child process (a real OS
// process, not an in-process simulation) by budget_worktree.test.ts, one
// per simulated worktree. Each invocation attempts exactly one budget
// reservation against whatever repo-shared state its cwd resolves to,
// then prints a single JSON line to stdout reporting success/failure so
// the parent test can inspect both outcomes without racing on shared
// in-process state itself. cwd and PURIX_COST_CEILING_USD are set by the
// parent via child_process spawn options / env — this file reads neither
// argv nor hardcodes anything repo-specific.
import { assertBudgetAvailable } from "./budget.js";

const estimatedCost = Number(process.argv[2] ?? "0.08");

try {
  assertBudgetAvailable(estimatedCost);
  process.stdout.write(JSON.stringify({ result: "success" }) + "\n");
  process.exit(0);
} catch (err) {
  process.stdout.write(
    JSON.stringify({ result: "fail", message: err instanceof Error ? err.message : String(err) }) + "\n"
  );
  process.exit(0); // exit 0 even on a budget-denied result — this is an expected outcome, not a worker crash
}