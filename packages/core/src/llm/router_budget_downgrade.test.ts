// src/llm/router_budget_downgrade.test.ts
//
// routeTier()'s budget-pressure downgrade branch (a call that would
// normally get the "high" tier gets pushed to "low" once less than 15%
// of the cost ceiling remains) was never exercised — router.test.ts only
// ever calls routeTier() with no real budget state on disk, so
// getBudgetSnapshot() there reflects a fresh/empty budget (0% spent,
// nowhere near the threshold). This file drives real spend into the
// budget DB via recordUsage() first, then checks routeTier()'s decision
// against it, covering both sides of the LOW_BUDGET_DOWNGRADE_THRESHOLD
// boundary and the reason string's interpolated percentage.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../manifest/store";
import { safeRmSync } from "../platform/fs_retry.js";
import { recordUsage } from "./budget";
import { routeTier } from "./router";

let originalCwd: string;
let tmpDir: string;
let originalCeiling: string | undefined;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), "purix-router-budget-test-"));
  process.chdir(tmpDir);
  originalCeiling = process.env.PURIX_COST_CEILING_USD;
  process.env.PURIX_COST_CEILING_USD = "1.00";
});

afterEach(() => {
  closeDb();
  process.chdir(originalCwd);
  safeRmSync(tmpDir);
  if (originalCeiling === undefined) delete process.env.PURIX_COST_CEILING_USD;
  else process.env.PURIX_COST_CEILING_USD = originalCeiling;
});

describe("routeTier — budget-pressure downgrade", () => {
  it("downgrades a normally-high call to low once fewer than 15% of the ceiling remains", () => {
    // Ceiling is $1.00; low-tier input is $0.10/1M tokens, so 9,000,000
    // input tokens costs exactly $0.90 — 10% of the ceiling remains,
    // under the 15% floor.
    recordUsage({ promptTokenCount: 9_000_000, candidatesTokenCount: 0 }, "low");

    const decision = routeTier("intent_refinement");

    expect(decision.tier).toBe("low");
    expect(decision.reason).toMatch(/would normally use the high tier/);
    expect(decision.reason).toMatch(/% of the cost ceiling remains/);
    expect(decision.reason).toMatch(/10% of the cost ceiling remains/);
  });

  it("keeps the high tier when well over 15% of the ceiling remains", () => {
    recordUsage({ promptTokenCount: 1000, candidatesTokenCount: 1000 }, "low"); // trivially small spend
    const decision = routeTier("escalation");
    expect(decision.tier).toBe("high");
    expect(decision.reason).toMatch(/frontier tier/);
  });

  it("never downgrades a call that is already low-tier by default, regardless of budget pressure", () => {
    recordUsage({ promptTokenCount: 9_000_000, candidatesTokenCount: 0 }, "low");
    const decision = routeTier("change_classification");
    expect(decision.tier).toBe("low");
    expect(decision.reason).toMatch(/small\/bounded call/);
  });

  it("stays high comfortably above the threshold and flips to low once comfortably below it", () => {
    // 8,000,000 tokens @ $0.10/1M = $0.80 spent -> 20% remaining, clearly
    // above the 15% floor. (Landing a test exactly on 15.000...% is not
    // reliable here: routeTier's remainingFraction is a plain floating-
    // point division, e.g. 1 - 0.85/1.00 evaluates to
    // 0.14999999999999991 rather than exactly 0.15, so a test aimed at
    // the literal boundary would be asserting on float rounding rather
    // than on routeTier's actual threshold logic. Testing clearly-above
    // and clearly-below instead exercises the same branch without that
    // trap.)
    recordUsage({ promptTokenCount: 8_000_000, candidatesTokenCount: 0 }, "low");
    const aboveThreshold = routeTier("intent_refinement");
    expect(aboveThreshold.tier).toBe("high");

    // Spend up to $0.90 total -> 10% remaining, clearly under the floor.
    recordUsage({ promptTokenCount: 1_000_000, candidatesTokenCount: 0 }, "low");
    const belowThreshold = routeTier("intent_refinement");
    expect(belowThreshold.tier).toBe("low");
  });

  it("does not downgrade when getBudgetSnapshot returns null (no budget state resolvable)", () => {
    // Forces the real false side of `if (snapshot && snapshot.ceiling > 0)`
    // by making getBudgetSnapshot() genuinely throw internally and return
    // null: resolveSharedStateDir() falls back to "<cwd>/.purix" when
    // there's no .git ancestry (true here, in a fresh tmp dir), and
    // getDb() does `mkdirSync(dirname(dbPath), { recursive: true })`
    // against that path. Pre-creating a plain FILE named ".purix" makes
    // that mkdirSync throw ENOTDIR — a real, reachable failure mode
    // (a stray file where the state dir should be), not a mock.
    writeFileSync(join(tmpDir, ".purix"), "not a directory");

    const decision = routeTier("intent_refinement");
    expect(decision.tier).toBe("high");
    expect(decision.reason).toMatch(/frontier tier/);
  });
});
