// src/llm/budget.test.ts
//
// Verifies the review finding #3 fix: budget state now lives as a single
// SQLite row instead of a read-mutate-write JSON file. This can't fully
// simulate real concurrent processes in-process, but it does verify the
// atomic-increment arithmetic is correct across repeated calls (the thing
// a read-then-write race would have silently gotten wrong) and that the
// hard ceiling still trips.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../manifest/store";
import { assertBudgetAvailable, recordUsage, getBudgetSnapshot, recordSavings, getSavingsSummary, setBudgetOverride } from "./budget";
import { getOverrideAudits } from "../security/override_audit";
import type { RoutingDecision } from "./router";

let originalCwd: string;
let tmpDir: string;
let originalCeiling: string | undefined;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), "purix-budget-test-"));
  process.chdir(tmpDir);
  originalCeiling = process.env.PURIX_COST_CEILING_USD;
});

afterEach(() => {
  closeDb();
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalCeiling === undefined) delete process.env.PURIX_COST_CEILING_USD;
  else process.env.PURIX_COST_CEILING_USD = originalCeiling;
});

describe("budget state (SQLite-backed)", () => {
  it("starts at zero spend with no prior state", () => {
    const snapshot = getBudgetSnapshot();
    expect(snapshot?.totalSpentUsd).toBe(0);
  });

  it("accumulates cost across sequential recordUsage calls without losing any", () => {
    for (let i = 0; i < 10; i++) {
      recordUsage({ promptTokenCount: 1_000_000, candidatesTokenCount: 1_000_000 }, "low");
    }
    // 10 calls * (0.10 + 0.40) per call = 5.00 — every call's cost must
    // land, which a lost-update race would have silently failed to do.
    const snapshot = getBudgetSnapshot();
    expect(snapshot?.totalSpentUsd).toBeCloseTo(5.0, 5);
  });

  it("trips the hard ceiling once accumulated spend reaches it", () => {
    process.env.PURIX_COST_CEILING_USD = "1.00";
    recordUsage({ promptTokenCount: 10_000_000, candidatesTokenCount: 0 }, "low"); // $1.00 exactly
    expect(() => assertBudgetAvailable()).toThrow(/Cost guardrail tripped/);
  });

  it("does not trip the ceiling while under it", () => {
    process.env.PURIX_COST_CEILING_USD = "5.00";
    recordUsage({ promptTokenCount: 1_000_000, candidatesTokenCount: 0 }, "low"); // $0.10
    expect(() => assertBudgetAvailable()).not.toThrow();
  });

  it("handles invalid or non-positive PURIX_COST_CEILING_USD gracefully", () => {
    process.env.PURIX_COST_CEILING_USD = "invalid";
    expect(() => assertBudgetAvailable(0.01)).not.toThrow();

    process.env.PURIX_COST_CEILING_USD = "-5";
    expect(() => assertBudgetAvailable(0.01)).not.toThrow();
  });
});

describe("savings ledger", () => {
  const downgraded: RoutingDecision = {
    tier: "low",
    reason: '"escalation" would normally use the high tier, but downgraded to low tier to stay under budget',
  };
  const notDowngraded: RoutingDecision = {
    tier: "high",
    reason: '"escalation" is one of the two calls Section 29 recommends the frontier tier for',
  };

  it("records a genuine delta for a high-eligible call that was actually downgraded to low", () => {
    recordSavings("escalation", downgraded, { inputTokens: 1_000_000, outputTokens: 1_000_000 }, "fake-provider");
    const summary = getSavingsSummary(7);
    expect(summary.callCount).toBe(1);
    // fake-provider falls back to DEFAULT_PRICE: low {0.20,0.60}, high {1.50,6.00}
    // actual = 0.20 + 0.60 = 0.80; counterfactual = 1.50 + 6.00 = 7.50; delta = 6.70
    expect(summary.totalSavingsUsd).toBeCloseTo(6.70, 5);
  });

  it("does not record anything for a high-eligible call that ran at high tier (no downgrade, nothing was actually saved)", () => {
    recordSavings("escalation", notDowngraded, { inputTokens: 1_000_000, outputTokens: 1_000_000 }, "fake-provider");
    const summary = getSavingsSummary(7);
    expect(summary.callCount).toBe(0);
    expect(summary.totalSavingsUsd).toBe(0);
  });

  it("does not record anything for a call type that never touches the high tier, even if passed tier: low", () => {
    // change_classification/repair/greenfield_plan are always "low" — there
    // is no real counterfactual for them, so even calling recordSavings
    // with a low-tier decision for one of these must be a no-op.
    recordSavings(
      "change_classification",
      { tier: "low", reason: '"change_classification" is a small/bounded call per Section 3 — low tier by default' },
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      "fake-provider"
    );
    const summary = getSavingsSummary(7);
    expect(summary.callCount).toBe(0);
    expect(summary.totalSavingsUsd).toBe(0);
  });

  it("does not record anything for intent_refinement run at high tier either", () => {
    recordSavings(
      "intent_refinement",
      { tier: "high", reason: "high tier, no downgrade" },
      { inputTokens: 500_000, outputTokens: 500_000 },
      "fake-provider"
    );
    expect(getSavingsSummary(7).callCount).toBe(0);
  });

  it("accumulates across multiple genuine downgrades", () => {
    recordSavings("escalation", downgraded, { inputTokens: 1_000_000, outputTokens: 0 }, "fake-provider");
    recordSavings("intent_refinement", downgraded, { inputTokens: 1_000_000, outputTokens: 0 }, "fake-provider");
    const summary = getSavingsSummary(7);
    expect(summary.callCount).toBe(2);
    // each: actual = 0.20, counterfactual = 1.50, delta = 1.30 -> total 2.60
    expect(summary.totalSavingsUsd).toBeCloseTo(2.60, 5);
  });

  it("getSavingsSummary respects the requested window and excludes older rows", () => {
    recordSavings("escalation", downgraded, { inputTokens: 1_000_000, outputTokens: 1_000_000 }, "fake-provider");
    // A window of 0 days means "since right now" — the row just inserted
    // has a created_at timestamp at or before now, so it should still be
    // included by >= ; but a window that couldn't possibly include any
    // past timestamp (negative) must exclude everything.
    const negativeWindow = getSavingsSummary(-1);
    expect(negativeWindow.callCount).toBe(0);
  });
});

describe("budget override with audit", () => {
  it("blocks when over ceiling with no override", () => {
    process.env.PURIX_COST_CEILING_USD = "1.00";
    recordUsage({ promptTokenCount: 10_000_000, candidatesTokenCount: 0 }, "low");
    expect(() => assertBudgetAvailable()).toThrow(/Cost guardrail tripped/);
  });

  it("proceeds and records override audit when override is present with a real reason", () => {
    process.env.PURIX_COST_CEILING_USD = "1.00";
    recordUsage({ promptTokenCount: 10_000_000, candidatesTokenCount: 0 }, "low");
    setBudgetOverride("Emergency budget override for hotfix");
    expect(() => assertBudgetAvailable()).not.toThrow();

    const audits = getOverrideAudits();
    const budgetAudit = audits.find(a => a.gate_name === "BudgetGate");
    expect(budgetAudit).toBeTruthy();
    expect(budgetAudit?.reason).toBe("Emergency budget override for hotfix");
  });

  it("rejects an empty-string override reason", () => {
    process.env.PURIX_COST_CEILING_USD = "1.00";
    recordUsage({ promptTokenCount: 10_000_000, candidatesTokenCount: 0 }, "low");
    setBudgetOverride("");
    expect(() => assertBudgetAvailable()).toThrow(/reason cannot be empty/);
  });

  it("concurrency reservation: two calls when remaining budget fits only one ensure only one succeeds", () => {
    process.env.PURIX_COST_CEILING_USD = "0.10";
    let results: string[] = [];
    try {
      assertBudgetAvailable(0.08);
      results.push("success-1");
    } catch {
      results.push("fail-1");
    }

    try {
      assertBudgetAvailable(0.08);
      results.push("success-2");
    } catch {
      results.push("fail-2");
    }

    expect(results).toContain("success-1");
    expect(results).toContain("fail-2");
  });
});
