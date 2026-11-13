// A budget reservation is released whenever an LLM call does not happen, including the two refusals that fire
// after assertBudgetAvailable() has already reserved: an open circuit breaker and an unusable provider.
// Source: beta test report 2026-09-30 (problem 5, "failed calls appear to be charged"); ADR-004, ADR-052.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../manifest/store";
import { persistProviderChoice } from "./providers";
import { callLlm } from "./classify";
import { getBudgetSnapshot } from "./budget";
import { recordCircuitFailure } from "./circuit";
import { safeRmSync } from "../platform/fs_retry.js";

let cwd: string;
let tmp: string;
let realFetch: typeof fetch;
let log: typeof console.log;
let savedKey: string | undefined;

beforeEach(() => {
  cwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "purix-budget-release-"));
  process.chdir(tmp);
  realFetch = globalThis.fetch;
  log = console.log;
  console.log = () => {};
  savedKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test";
  persistProviderChoice("openai");
});
afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = log;
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
  closeDb();
  process.chdir(cwd);
  safeRmSync(tmp);
});

describe("budget reservation is released when no LLM call is made", () => {
  it("a 401 from the provider leaves the running total at zero", async () => {
    globalThis.fetch = (async () => new Response("unauthorized", { status: 401 }));
    for (let i = 0; i < 3; i++) await expect(callLlm("p", "change_classification", "low")).rejects.toThrow();
    expect(getBudgetSnapshot()?.totalSpentUsd ?? 0).toBeCloseTo(0, 6);
  });

  it("an open circuit breaker refuses the call without charging for it", async () => {
    for (let i = 0; i < 5; i++) recordCircuitFailure();
    globalThis.fetch = (async () => {
      throw new Error("fetch must not be reached while the circuit is open");
    });
    for (let i = 0; i < 4; i++) await expect(callLlm("p", "change_classification", "low")).rejects.toThrow(/Circuit breaker open/);
    expect(getBudgetSnapshot()?.totalSpentUsd ?? 0).toBeCloseTo(0, 6);
  });

  it("an unusable provider configuration refuses the call without charging for it", async () => {
    persistProviderChoice("custom");
    for (let i = 0; i < 4; i++) await expect(callLlm("p", "change_classification", "low")).rejects.toThrow(/No custom provider/);
    expect(getBudgetSnapshot()?.totalSpentUsd ?? 0).toBeCloseTo(0, 6);
  });
});
