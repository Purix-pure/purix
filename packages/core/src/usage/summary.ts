// packages/core/src/usage/summary.ts
//
// Turns the local usage ledger into the short block `purix stats` prints.
// Reads local data only. Nothing here is uploaded.
import { aggregate, readLedger, utcDay } from "./ledger.js";
import type { UsageEvent } from "./schema.js";

export function formatUsageSummary(events: UsageEvent[], now: Date = new Date(), days = 30): string[] {
  const cutoff = utcDay(new Date(now.getTime() - days * 86_400_000));
  const runs = aggregate(events).filter((e) => e.event === "command_run" && e.day >= cutoff);
  if (runs.length === 0) return [];

  const perCommand = new Map<string, { total: number; failed: number }>();
  let total = 0;
  let failed = 0;
  for (const r of runs) {
    const [command = "unknown", exitWord = "ok"] = r.dimension.split(":");
    const row = perCommand.get(command) ?? { total: 0, failed: 0 };
    row.total += r.count;
    total += r.count;
    if (exitWord !== "ok") {
      row.failed += r.count;
      failed += r.count;
    }
    perCommand.set(command, row);
  }
  const top = [...perCommand.entries()].sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0])).slice(0, 5);
  return [
    `Your usage on this machine, last ${days} days (local only):`,
    `  ${total} command run${total === 1 ? "" : "s"}, ${failed} did not finish ok`,
    ...top.map(([name, v]) => `  ${name}: ${v.total}${v.failed ? ` (${v.failed} not ok)` : ""}`),
  ];
}

export function usageSummaryLines(now: Date = new Date()): string[] {
  return formatUsageSummary(readLedger(), now);
}
