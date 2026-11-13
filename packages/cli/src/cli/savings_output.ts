// packages/cli/src/cli/savings_output.ts
//
// Part 2: the "Savings This Run" / "Total Savings This Week" terminal
// output and the milestone-upsell line. Shared by lifecycle.ts's command
// actions (create, modify) rather than duplicated in each — both are
// where an intent_refinement/escalation call could actually happen.
import { getSavingsSummary } from "@purix/core/llm/budget";
import { config } from "@purix/core/state/config";
import { isLoggedIn } from "@purix/core/security/session";
import { isQuiet } from "./output.js";

const DEFAULT_MILESTONE_THRESHOLD_USD = 50;
const MILESTONE_LAST_SHOWN_KEY = "milestone-upsell-last-shown";
const MILESTONE_THRESHOLD_KEY = "milestone-threshold";

/**
 * Captures the all-time savings total/count BEFORE a command's action
 * runs. Diffing against the total AFTER is how "Savings This Run" is
 * derived — there's no other reliable way to scope a query to "just this
 * process's LLM calls" against a shared, cumulative SQLite ledger.
 */
export function snapshotSavings() {
  return getSavingsSummary(3650); // ~10 years ≈ "all time" for this project
}

/**
 * What the caller knows about verification for this run. The heading says "Verification Complete"
 * only for "passed". A caller that does not say (or says "failed"/"skipped") gets a neutral heading,
 * so a skipped or errored check can never read as a pass (FR-04, C-36).
 * "partial" means the code compiled and some checks ran, but at least one changed file had no test that
 * exercised it (or, for `create`, no test has run yet). It is a gap, so it never reads as a pass either.
 */
export type RunVerification = "passed" | "failed" | "skipped" | "partial";

export function printRunSummary(before: ReturnType<typeof snapshotSavings>, verification?: RunVerification): void {
  if (isQuiet() || config.get("show-savings") === "off") return;

  const after = getSavingsSummary(3650);
  const thisRunDelta = after.totalSavingsUsd - before.totalSavingsUsd;
  const thisRunCalls = after.callCount - before.callCount;
  const weekly = getSavingsSummary(7);

  // Per Part 2: on a run with no high-tier-eligible calls, omit the
  // "Savings This Run" line entirely rather than printing a misleading
  // $0.00 — a run that never touched intent_refinement/escalation, or
  // touched them without a genuine downgrade, has nothing to report.
  const lines: string[] = [];
  if (thisRunCalls > 0) {
    lines.push(`Savings This Run: $${thisRunDelta.toFixed(2)}`);
  }
  if (weekly.callCount > 0) {
    lines.push(`Total Savings This Week: $${weekly.totalSavingsUsd.toFixed(2)}`);
  }
  if (lines.length === 0) return; // nothing genuine to show at all

  console.log(runSummaryHeading(verification));
  for (const line of lines) console.log(line);

  maybePrintMilestoneUpsell();
}

export function runSummaryHeading(verification?: RunVerification): string {
  if (verification === "passed") return `\nPurix Verification Complete ✅`;
  if (verification === "failed") return `\nPurix run summary (verification did not pass)`;
  if (verification === "skipped") return `\nPurix run summary (verification was not run)`;
  if (verification === "partial") return `\nPurix run summary (not everything was tested)`;
  return `\nPurix run summary`;
}

function maybePrintMilestoneUpsell(): void {
  if (isLoggedIn()) return; // suppressed permanently once logged in

  const threshold = Number(config.get(MILESTONE_THRESHOLD_KEY) ?? DEFAULT_MILESTONE_THRESHOLD_USD);
  const allTime = getSavingsSummary(3650);
  if (allTime.totalSavingsUsd < threshold) return;

  const lastShown = config.get(MILESTONE_LAST_SHOWN_KEY);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  if (lastShown === today) return; // rate-limited to once per day

  console.log(
    `\nWant this data saved? Run \`purix login\` to unlock your web dashboard and get daily compute receipts sent to your inbox.`
  );
  config.set(MILESTONE_LAST_SHOWN_KEY, today);
}
