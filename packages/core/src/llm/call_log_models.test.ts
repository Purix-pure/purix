// AI-20 measurement: unreadable replies per model, flagged only above 3% on enough calls.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../manifest/store.js";
import { recordLlmCall, buildCallReport, formatCallReport, FORMAT_ERROR_MIN_CALLS, type CallStatus } from "./call_log.js";
import { safeRmSync } from "../platform/fs_retry.js";

let cwd: string, tmp: string;
beforeEach(() => { cwd = process.cwd(); tmp = mkdtempSync(join(tmpdir(), "purix-callmodels-")); process.chdir(tmp); });
afterEach(() => { closeDb(); process.chdir(cwd); safeRmSync(tmp); });

const add = (model: string, status: CallStatus, n = 1) => {
  for (let i = 0; i < n; i++) {
    recordLlmCall({ callType: "change_classification", tier: "low", provider: "openai", model, promptChars: 100, inputTokens: 30, outputTokens: 10, retry: false, latencyMs: 5, costUsd: 0.001, status });
  }
};

describe("byModel in the call report", () => {
  it("flags a model above 3% on enough calls, and does not flag a clean one", () => {
    add("model-a", "ok", 18); add("model-a", "format_error", 2);   // 10% of 20
    add("model-b", "ok", 40);                                       // 0%
    const rep = buildCallReport();
    const a = rep.byModel.find((m) => m.model === "model-a")!;
    const b = rep.byModel.find((m) => m.model === "model-b")!;
    expect(a).toMatchObject({ count: 20, overThreshold: true });
    expect(a.formatErrorShare).toBeCloseTo(0.1, 5);
    expect(b).toMatchObject({ count: 40, overThreshold: false, formatErrorShare: 0 });
    const text = formatCallReport(rep);
    expect(text).toContain("openai/model-a: 10.0% of 20 call(s)  <- over the line");
    expect(text).toContain("openai/model-b: 0.0% of 40 call(s)");
  });

  it("a high share on too few calls is listed as too few to judge, not flagged", () => {
    add("model-c", "format_error", 1);
    add("model-c", "ok", FORMAT_ERROR_MIN_CALLS - 2);                // 19 calls
    const c = buildCallReport().byModel[0]!;
    expect(c.count).toBe(FORMAT_ERROR_MIN_CALLS - 1);
    expect(c.overThreshold).toBe(false);
    expect(formatCallReport(buildCallReport())).toContain("too few calls to judge");
  });

  it("exactly 3% is not over the line", () => {
    add("model-d", "format_error", 1); add("model-d", "ok", 32);     // 1 of 33 = 3.03% -> over
    add("model-e", "format_error", 1); add("model-e", "ok", 33);     // 1 of 34 = 2.94% -> not over
    const rep = buildCallReport();
    expect(rep.byModel.find((m) => m.model === "model-d")!.overThreshold).toBe(true);
    expect(rep.byModel.find((m) => m.model === "model-e")!.overThreshold).toBe(false);
  });

  it("an empty table has no model rows", () => {
    expect(buildCallReport().byModel).toEqual([]);
  });
});
