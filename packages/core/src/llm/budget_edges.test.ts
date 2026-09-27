// Default-parameter, optional-chain and env-parsing branches of budget.ts that the main budget tests do not reach.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../manifest/store";
import { assertBudgetAvailable, recordUsage, recordProviderUsage, getBudgetSnapshot } from "./budget";
import { safeRmSync } from "../platform/fs_retry.js";

let cwd: string;
let tmp: string;
let ceiling: string | undefined;
let log: typeof console.log;

beforeEach(() => {
  cwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "purix-budget-edges-"));
  process.chdir(tmp);
  ceiling = process.env.PURIX_COST_CEILING_USD;
  delete process.env.PURIX_COST_CEILING_USD;
  log = console.log;
  console.log = () => {}; // recordProviderUsage prints a cost line
});
afterEach(() => {
  console.log = log;
  // LIFECYCLE FIX: closeDb() releases this test's SQLite handle on tmp
  // BEFORE cleanup, same ordering budget_worktree.test.ts already relies
  // on. But closing a handle doesn't guarantee Windows has released the
  // underlying file lock the instant close() returns — deleting the
  // directory immediately after, with a bare rmSync, races that release
  // and intermittently throws EPERM (observed directly in CI on Windows:
  // "EPERM, Permission denied ... rmSync ... purix-budget-edges-...").
  // safeRmSync retries with backoff for exactly this class of transient
  // Windows file-lock race — same helper budget_worktree.test.ts already
  // uses for its own temp-dir teardown — instead of a raw rmSync that
  // fails hard the moment it loses the race.
  closeDb();
  process.chdir(cwd);
  safeRmSync(tmp);
  if (ceiling === undefined) delete process.env.PURIX_COST_CEILING_USD;
  else process.env.PURIX_COST_CEILING_USD = ceiling;
});

const spent = () => getBudgetSnapshot()!.totalSpentUsd;

describe("recordUsage — defaults and optional fields", () => {
  it("accepts undefined usage and costs nothing", () => {
    recordUsage(undefined);
    expect(spent()).toBe(0);
  });
  it("defaults to the low tier and counts input and output tokens separately", () => {
    recordUsage({ promptTokenCount: 1_000_000 });
    const afterInput = spent();
    expect(afterInput).toBeGreaterThan(0);
    recordUsage({ candidatesTokenCount: 1_000_000 });
    expect(spent()).toBeGreaterThan(afterInput);
  });
  it("prices the high tier higher than the low tier", () => {
    recordUsage({ promptTokenCount: 1_000_000 }, "low");
    const low = spent();
    recordUsage({ promptTokenCount: 1_000_000 }, "high");
    expect(spent() - low).toBeGreaterThan(low);
  });
  it("settles a reservation by applying only the difference from the reserved cost", () => {
    const reserved = assertBudgetAvailable(0.01);
    expect(reserved).toBe(0.01);
    recordUsage({ promptTokenCount: 1000 }, "low", reserved);
    expect(spent()).toBeGreaterThan(0);
    expect(spent()).toBeLessThan(0.01);
  });
});

describe("recordProviderUsage", () => {
  it("prices by provider with a default tier, and falls back to the default price for an unknown provider", () => {
    recordProviderUsage({ inputTokens: 1_000_000, outputTokens: 0 }, "anthropic");
    const known = spent();
    expect(known).toBeGreaterThan(0);
    recordProviderUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, "no-such-provider", "high");
    expect(spent()).toBeGreaterThan(known);
  });
  it("settles against a reservation", () => {
    const reserved = assertBudgetAvailable(0.02);
    recordProviderUsage({ inputTokens: 10, outputTokens: 10 }, "openai", "low", reserved);
    expect(spent()).toBeLessThan(0.02);
  });
});

describe("cost ceiling parsing", () => {
  it("uses the documented default when the env var is unset, empty or not a number", () => {
    const defaultCeiling = getBudgetSnapshot()!.ceiling;
    expect(defaultCeiling).toBe(5);
    for (const bad of ["", "abc"]) {
      process.env.PURIX_COST_CEILING_USD = bad;
      expect(getBudgetSnapshot()!.ceiling).toBe(defaultCeiling);
    }
  });
  it("honours a valid override and refuses to reserve past it", () => {
    process.env.PURIX_COST_CEILING_USD = "0.02";
    expect(getBudgetSnapshot()!.ceiling).toBe(0.02);
    assertBudgetAvailable(0.015);
    expect(() => assertBudgetAvailable(0.015)).toThrow(/Cost guardrail tripped/);
  });
});
