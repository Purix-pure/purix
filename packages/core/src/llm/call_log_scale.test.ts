// Research 15, finding 1 and 4: the call report must stay fast on a large log, and old rows must be removable.
// Before the fix the report copied a whole group's array for every row, so work grew with the square of the row count
// (research 15 measured 20,000 rows at 2.7 to 2.9 s and 50,000 rows at 22 s). The fix keeps the report linear.
import { describe, it } from "node:test";
import { expect } from "expect";
import { getDbCompat } from "../manifest/store.js";
import { buildCallReport, pruneCallLog, recordLlmCall } from "./call_log.js";
import { isolateCwdForFile } from "../test-support/isolated_cwd.js";

isolateCwdForFile();

const DAY = 86_400_000;

function fill(n: number, createdAt: (i: number) => string): void {
  const db = getDbCompat();
  recordLlmCall({ callType: "diff_classification", tier: "low", provider: "openai", model: "m", promptChars: 10, inputTokens: 1, outputTokens: 1, retry: false, latencyMs: 1, costUsd: 0, status: "ok" });
  db.run("DELETE FROM llm_call_log");
  const sql = `INSERT INTO llm_call_log (session_id, created_at, call_type, tier, provider, model, est_input_tokens, input_tokens, output_tokens, retry, latency_ms, cost_usd, status, prompt_chars)
     VALUES ('s', ?, ?, 'low', 'openai', ?, 10, 10, 5, 0, 3, 0.001, 'ok', 40)`;
  db.run("BEGIN");
  try {
    for (let i = 0; i < n; i++) db.run(sql, [createdAt(i), i % 2 === 0 ? "diff_classification" : "repair", `m${i % 3}`]);
    db.run("COMMIT");
  } catch (err) {
    db.run("ROLLBACK");
    throw err;
  }
}

describe("call report at scale (research 15, finding 1)", () => {
  it("builds the report for 60,000 rows in a few seconds, not tens of seconds", () => {
    fill(60_000, () => new Date().toISOString());
    const t0 = Date.now();
    const report = buildCallReport();
    const ms = Date.now() - t0;
    expect(report.totalCalls).toBe(60_000);
    expect(report.byType.reduce((a, r) => a + r.count, 0)).toBe(60_000);
    // Linear work is a few hundred milliseconds. The old quadratic copy needs clearly more than 4 s at this size. 4 s leaves room for a slow box.
    expect(ms).toBeLessThan(4_000);
  });
});

describe("call log retention (research 15, finding 4)", () => {
  it("removes rows older than the limit, keeps newer ones, and reports how many went", () => {
    fill(10, (i) => new Date(Date.now() - (i < 4 ? 400 : 10) * DAY).toISOString());
    expect(pruneCallLog(365)).toBe(4);
    expect(buildCallReport().totalCalls).toBe(6);
    expect(pruneCallLog(365)).toBe(0);
  });

  it("refuses a limit that is not a positive whole number of days, and deletes nothing", () => {
    fill(3, () => new Date(Date.now() - 900 * DAY).toISOString());
    for (const bad of [0, -5, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) expect(pruneCallLog(bad)).toBe(0);
    expect(buildCallReport().totalCalls).toBe(3);
  });
});
