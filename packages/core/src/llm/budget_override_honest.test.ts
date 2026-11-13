// src/llm/budget_override_honest.test.ts
//
// F03-09 follow-up. An armed budget override used to be spent on the FIRST model call of a run, whether or not the ceiling had
// been reached, and it wrote an audit row saying "Budget exceeded" every time. A row that says a gate was overridden when
// nothing was in the way is a false record, and the chain keeps it for good. The override is now used only when the guard would
// really have refused the call.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../manifest/store";
import { safeRmSync } from "../platform/fs_retry";
import { assertBudgetAvailable, getBudgetSnapshot, setBudgetOverride } from "./budget";
import { getOverrideAudits } from "../security/override_audit";

let originalCwd: string;
let tmpDir: string;
let originalCeiling: string | undefined;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), "purix-budget-honest-"));
  process.chdir(tmpDir);
  originalCeiling = process.env.PURIX_COST_CEILING_USD;
});

afterEach(() => {
  setBudgetOverride(undefined);
  closeDb();
  process.chdir(originalCwd);
  safeRmSync(tmpDir);
  if (originalCeiling === undefined) delete process.env.PURIX_COST_CEILING_USD;
  else process.env.PURIX_COST_CEILING_USD = originalCeiling;
});

const budgetRows = () => getOverrideAudits().filter((a) => a.gate_name === "BudgetGate");

describe("budget override is used only when the guard would have refused", () => {
  it("under the ceiling: reserves the cost like any call and writes no audit row", () => {
    process.env.PURIX_COST_CEILING_USD = "5.00";
    setBudgetOverride("armed but not needed");
    const reserved = assertBudgetAvailable(0.05);
    expect(reserved).toBe(0.05);
    expect(getBudgetSnapshot()!.totalSpentUsd).toBeCloseTo(0.05, 6);
    expect(budgetRows()).toEqual([]);
  });

  it("under the ceiling: the override stays armed and covers a later call that does trip", () => {
    process.env.PURIX_COST_CEILING_USD = "0.08";
    setBudgetOverride("release hotfix");
    expect(assertBudgetAvailable(0.05)).toBe(0.05); // fits, override untouched
    expect(budgetRows()).toEqual([]);
    expect(assertBudgetAvailable(0.05)).toBe(0); // would exceed 0.08, so the override is used here
    const rows = budgetRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe("release hotfix");
    expect(rows[0]!.finding).toMatch(/Budget exceeded/);
  });

  it("once used it is spent: the next call over the ceiling is refused again", () => {
    process.env.PURIX_COST_CEILING_USD = "0.01";
    setBudgetOverride("one call only");
    expect(assertBudgetAvailable(0.05)).toBe(0);
    expect(() => assertBudgetAvailable(0.05)).toThrow(/Cost guardrail tripped/);
    expect(budgetRows()).toHaveLength(1);
  });

  it("over the ceiling with an empty reason still refuses to record", () => {
    process.env.PURIX_COST_CEILING_USD = "0.01";
    setBudgetOverride("");
    expect(() => assertBudgetAvailable(0.05)).toThrow(/reason cannot be empty/);
  });

  it("no override: an over-ceiling call is refused and nothing is recorded", () => {
    process.env.PURIX_COST_CEILING_USD = "0.01";
    expect(() => assertBudgetAvailable(0.05)).toThrow(/Cost guardrail tripped/);
    expect(budgetRows()).toEqual([]);
  });
});
