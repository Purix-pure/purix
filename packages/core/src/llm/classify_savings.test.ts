// src/llm/classify_savings.test.ts
//
// callLlm()'s success path only calls recordSavings() when a
// savingsContext is passed in — every existing test (classify.test.ts,
// classify_retry.test.ts) calls callLlm() with no third argument, so
// that branch (lines 48-51: `if (savingsContext) { recordSavings(...) }`)
// never actually ran. This drives a real success call WITH a
// savingsContext for a HIGH_ELIGIBLE call type routed to "low" (the one
// combination recordSavings() itself treats as a genuine downgrade worth
// logging), and confirms the savings ledger actually gets a row instead
// of just trusting that the call happened.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../manifest/store";
import { persistProviderChoice } from "./providers";
import { callLlm } from "./classify";
import { getSavingsSummary } from "./budget";
import { safeRmSync } from "../platform/fs_retry.js";

let cwd: string;
let tmp: string;
let realFetch: typeof fetch;
let log: typeof console.log;
let savedKey: string | undefined;

beforeEach(() => {
  cwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "purix-classify-savings-"));
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

describe("callLlm — savingsContext on the success path", () => {
  it("records a savings row when a HIGH_ELIGIBLE call was actually downgraded to low", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "cheaper answer" } }],
          usage: { prompt_tokens: 1000, completion_tokens: 500 },
        }),
        { status: 200 }
      ));

    const result = await callLlm("prompt", "low", 1, {
      call: "intent_refinement",
      decision: { tier: "low", reason: "test downgrade" },
    });

    expect(result).toBe("cheaper answer");
    const summary = getSavingsSummary(30);
    expect(summary.totalSavingsUsd).toBeGreaterThan(0);
  });

  it("does not record savings when savingsContext is omitted (existing default behaviour)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "plain answer" } }],
          usage: { prompt_tokens: 1000, completion_tokens: 500 },
        }),
        { status: 200 }
      ));

    const result = await callLlm("prompt", "low");
    expect(result).toBe("plain answer");
    const summary = getSavingsSummary(30);
    expect(summary.totalSavingsUsd).toBe(0);
  });

  it("does not record savings when savingsContext is present but the call ran at high tier (no real downgrade)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "high tier answer" } }],
          usage: { prompt_tokens: 1000, completion_tokens: 500 },
        }),
        { status: 200 }
      ));

    await callLlm("prompt", "high", 1, {
      call: "intent_refinement",
      decision: { tier: "high", reason: "no downgrade happened" },
    });
    const summary = getSavingsSummary(30);
    expect(summary.totalSavingsUsd).toBe(0);
  });
});
