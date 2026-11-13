// packages/core/src/usage/summary.test.ts
import { describe, test } from "node:test";
import { expect } from "expect";
import { formatUsageSummary } from "./summary";
import type { UsageEvent } from "./schema";

const now = new Date("2026-10-08T12:00:00Z");
const ev = (day: string, dimension: string, count = 1): UsageEvent => ({ day, event: "command_run", dimension, count });

describe("usage summary", () => {
  test("empty ledger prints nothing", () => {
    expect(formatUsageSummary([], now)).toEqual([]);
  });

  test("counts runs and failures per command, newest 30 days only", () => {
    const lines = formatUsageSummary(
      [
        ev("2026-10-07", "check:ok:lt_1s", 3),
        ev("2026-10-07", "check:check_failed:lt_1s", 1),
        ev("2026-10-06", "change:ok:5_30s", 2),
        ev("2026-08-01", "old:ok:lt_1s", 9), // outside the window
      ],
      now,
    );
    expect(lines[0]).toContain("last 30 days");
    expect(lines[1]).toContain("6 command runs, 1 did not finish ok");
    expect(lines).toContain("  check: 4 (1 not ok)");
    expect(lines).toContain("  change: 2");
    expect(lines.join("\n")).not.toContain("old");
  });
});
