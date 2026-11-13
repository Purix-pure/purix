// src/llm/budget_refusal_ways_out.test.ts
//
// C3 item 6 / decision D10 (plan v4): a budget refusal must name the two ways out, and an override must say it covers one model call.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../manifest/store";
import { safeRmSync } from "../platform/fs_retry";
import { assertBudgetAvailable, setBudgetOverride } from "./budget";

let cwd: string;
let dir: string;
let ceiling: string | undefined;
beforeEach(() => { cwd = process.cwd(); dir = mkdtempSync(join(tmpdir(), "purix-budget-out-")); process.chdir(dir); ceiling = process.env.PURIX_COST_CEILING_USD; process.env.PURIX_COST_CEILING_USD = "0.05"; });
afterEach(() => { setBudgetOverride(undefined); closeDb(); process.chdir(cwd); safeRmSync(dir); if (ceiling === undefined) delete process.env.PURIX_COST_CEILING_USD; else process.env.PURIX_COST_CEILING_USD = ceiling; });

describe("budget refusal and override wording", () => {
  it("the refusal names both ways out", () => {
    assertBudgetAvailable(0.04);
    let msg = "";
    try { assertBudgetAvailable(0.04); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/purix budget reset --reason/);
    expect(msg).toMatch(/PURIX_COST_CEILING_USD/);
  });

  it("the override line says it covers this one model call, not the run", () => {
    assertBudgetAvailable(0.04);
    setBudgetOverride("release hotfix");
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
    try { assertBudgetAvailable(0.04); } finally { console.log = orig; }
    expect(lines.join("\n")).toMatch(/this one model call/);
  });
});
