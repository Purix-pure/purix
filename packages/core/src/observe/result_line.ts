// packages/core/src/observe/result_line.ts
//
// The one short line appended to a Purix reply, and printed by `purix statusline`: what was checked, what was stopped, what it cost,
// what is left. It lands in the agent's context on every call, so it is one line, it can be turned off (PURIX_RESULT_LINE=off), and it
// is left out when there is nothing to say.
//
// Words are chosen so the line cannot read as more than it is: "checks passed" and "N tests passed" say what ran, never "safe" or
// "correct". Dollars are the provider's price table times the tokens Purix counted, so the spend figure is an estimate and the line
// says "spent" the way `purix budget show` does.
import { purixEnv } from "../platform/env.js";
import { openLedger, type TestTotals } from "./ledger_reader.js";

export interface ResultLineInput {
  /** Test counts of the change's passing run, or null when none were recorded. */
  tests: TestTotals | null;
  /** Whether a verification passed for this change. */
  checksPassed: boolean;
  /** Things Purix stopped in this change. */
  stopped: number;
  /** Dollars spent on this change's model calls, or null when it made none or the figure is unknown. */
  costUsd: number | null;
  /** Budget left, or null when unknown. */
  leftUsd: number | null;
  /** Approvals waiting for a person right now. */
  waiting: number;
}

export function resultLineEnabled(): boolean {
  const v = (purixEnv("PURIX_RESULT_LINE") ?? "").trim().toLowerCase();
  return !(v === "off" || v === "0" || v === "false" || v === "no");
}

function usd(n: number): string {
  return n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `${n} ${one}` : `${n} ${many}`;
}

/**
 * The longest the line may be, in characters. The line lands in the agent's context on every reply, so its size is a cost the
 * person pays. The longest line the wording makes with realistic numbers is about 110 characters, so the cap rarely bites; it
 * is there so a later wording change cannot quietly grow the line. Over the cap, the least urgent parts are dropped first
 * (PRIORITY) and the rest kept whole: a part is never cut in half.
 */
export const RESULT_LINE_MAX_CHARS = 120;

/** Parts in the order they are dropped when the line is too long: first in the list goes first. */
const PRIORITY = ["left", "cost", "tests", "waiting", "stopped"] as const;
type PartKey = (typeof PRIORITY)[number];

/** The line, or null when there is nothing worth saying. At most RESULT_LINE_MAX_CHARS characters. */
export function formatResultLine(i: ResultLineInput): string | null {
  const parts = new Map<PartKey, string>();
  if (i.tests) {
    let t = `${plural(i.tests.passed, "test", "tests")} passed`;
    if (i.tests.failed > 0) t += `, ${i.tests.failed} failed`;
    if (i.tests.skipped > 0) t += ` (${i.tests.skipped} skipped)`;
    parts.set("tests", t);
  } else if (i.checksPassed) {
    parts.set("tests", "checks passed, test counts not recorded");
  }
  if (i.stopped > 0) parts.set("stopped", `${i.stopped} stopped`);
  if (i.waiting > 0) parts.set("waiting", `${i.waiting} waiting for approval`);
  if (i.costUsd !== null && i.costUsd > 0) parts.set("cost", `${usd(i.costUsd)} spent`);
  // "left" says nothing by itself: it is only worth the tokens beside something that happened.
  if (i.leftUsd !== null && parts.size > 0) parts.set("left", `${usd(i.leftUsd)} left`);
  if (parts.size === 0) return null;
  const order: PartKey[] = ["tests", "stopped", "waiting", "cost", "left"];
  const build = () => `Purix: ${order.filter((k) => parts.has(k)).map((k) => parts.get(k)).join(", ")}`;
  for (const drop of PRIORITY) {
    if (build().length <= RESULT_LINE_MAX_CHARS || parts.size === 1) break;
    parts.delete(drop);
  }
  return build();
}

/**
 * The line for one change, read from the project's record. Null when the line is off, the record cannot be read, or there is
 * nothing to say. Never throws: a reply must not fail because its footer could not be built.
 */
export function resultLineForChange(stateDir: string, changeId: string | null, waiting: number): string | null {
  if (!resultLineEnabled()) return null;
  let ledger = null;
  try {
    ledger = openLedger(stateDir);
    if (!ledger) return null;
    const change = changeId ? ledger.change(changeId) : null;
    const spend = ledger.summary().spend;
    return formatResultLine({
      tests: change?.testCounts ?? null,
      checksPassed: change ? change.failedBeforePass !== null : false,
      stopped: change?.stops.length ?? 0,
      costUsd: change && change.modelCalls > 0 ? change.costUsd : null,
      leftUsd: spend ? spend.leftUsd : null,
      waiting,
    });
  } catch {
    return null;
  } finally {
    ledger?.close();
  }
}
