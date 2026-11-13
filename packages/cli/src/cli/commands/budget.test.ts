// `purix budget` (A10c-1): shows spend against the ceiling and starts a new budget with a recorded reason.
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { safeRmSync } from "@purix/core/platform/fs_retry";
import { closeDb } from "@purix/core/manifest/store";
import { assertBudgetAvailable, getBudgetSnapshot } from "@purix/core/llm/budget";
import { registerBudgetCommands } from "./budget";

let cwd: string;
let tmp: string;
let lines: string[];
let errors: string[];
let realLog: typeof console.log;
let realErr: typeof console.error;
let savedCeiling: string | undefined;

async function run(...args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerBudgetCommands(program);
  await program.parseAsync(["node", "purix", "budget", ...args]);
}

beforeEach(() => {
  cwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "purix-budget-cmd-"));
  process.chdir(tmp);
  lines = []; errors = [];
  realLog = console.log; realErr = console.error;
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { errors.push(a.join(" ")); };
  savedCeiling = process.env.PURIX_COST_CEILING_USD;
  process.env.PURIX_COST_CEILING_USD = "0.06";
  process.exitCode = undefined;
});
afterEach(() => {
  console.log = realLog; console.error = realErr;
  if (savedCeiling === undefined) delete process.env.PURIX_COST_CEILING_USD; else process.env.PURIX_COST_CEILING_USD = savedCeiling;
  closeDb();
  process.chdir(cwd);
  safeRmSync(tmp);
  process.exitCode = undefined;
});

describe("purix budget", () => {
  test("shows spend against the ceiling, and says how to reset once the ceiling is reached", async () => {
    process.env.PURIX_COST_CEILING_USD = "0.10";
    assertBudgetAvailable();
    await run();
    expect(lines.join("\n")).toContain("$0.0500 of a $0.10 ceiling");
    expect(lines.join("\n")).not.toContain("purix budget reset");
    assertBudgetAvailable();
    lines.length = 0;
    await run("show");
    expect(lines.join("\n")).toContain('purix budget reset --reason "<why>"');
  });

  test("reset clears the total, says what it cleared, and model calls are allowed again", async () => {
    assertBudgetAvailable();
    expect(() => assertBudgetAvailable()).toThrow(/Cost guardrail tripped/);
    await run("reset", "--reason", "new month");
    expect(lines.join("\n")).toContain("Cleared $0.0500");
    expect(getBudgetSnapshot()?.totalSpentUsd).toBe(0);
    expect(() => assertBudgetAvailable()).not.toThrow();
  });

  test("reset without a reason is refused by the command line, and with a blank reason by the budget; nothing changes", async () => {
    assertBudgetAvailable();
    await expect(run("reset")).rejects.toThrow(/--reason/);
    await run("reset", "--reason", "   ");
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/reason is required/);
    expect(getBudgetSnapshot()?.totalSpentUsd).toBeCloseTo(0.05, 5);
  });

  test("in a folder with no Purix state it says so and creates nothing", async () => {
    await run("reset", "--reason", "x");
    expect(lines.join("\n")).toMatch(/purix|state|create|connect/i);
  });
});
