// A10c-1 (research 15 findings 7, 8 and 9; D16, first part of D21): a model call that hangs stops at its deadline, a timeout is its
// own failure class (retried with a cap and jitter, counted by the breaker, never charged), and the cost ceiling can be reset
// with a message that says how.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDbCompat } from "../manifest/store";
import { persistProviderChoice } from "./providers";
import { callLlm } from "./classify";
import { ModelCallTimeoutError, isTimeoutError, retryDelayMs, setRetryHooksForTests, TIMEOUT_MAX_RETRIES } from "./call_failure";
import { assertBudgetAvailable, getBudgetSnapshot, resetBudget } from "./budget";
import { getOverrideAudits } from "../security/override_audit";
import { netFetch, llmTimeoutMs } from "../platform/net";
import { safeRmSync } from "../platform/fs_retry.js";

let cwd: string;
let tmp: string;
let realFetch: typeof fetch;
let log: typeof console.log;
const saved: Record<string, string | undefined> = {};
const ENV = ["OPENAI_API_KEY", "PURIX_LLM_TIMEOUT_MS", "PURIX_COST_CEILING_USD"];

beforeEach(() => {
  cwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "purix-reliability-"));
  process.chdir(tmp);
  realFetch = globalThis.fetch;
  log = console.log;
  console.log = () => {};
  for (const k of ENV) saved[k] = process.env[k];
  process.env.OPENAI_API_KEY = "sk-test";
  persistProviderChoice("openai");
  setRetryHooksForTests({ random: () => 0, sleep: async () => {} });
});
afterEach(() => {
  setRetryHooksForTests(undefined);
  globalThis.fetch = realFetch;
  console.log = log;
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  closeDb();
  process.chdir(cwd);
  safeRmSync(tmp);
});

const asError = (r: unknown): Error => (r instanceof Error ? r : new Error(String(r))); // a DOMException TimeoutError is an Error in Node

/** A fetch that never answers; it fails only when its caller's signal fires, with the signal's own reason, as real fetch does. */
const hangingFetch = (counter: { n: number }) => (async (_u: unknown, init?: RequestInit) => {
  counter.n++;
  await new Promise((_, reject) => {
    const s = init?.signal;
    if (!s) return; // no signal, no deadline: hangs for good (the test would time out; that is the bug being tested)
    if (s.aborted) return reject(asError(s.reason));
    // AbortSignal.timeout's own timer is unref'd and a real hung socket keeps the process alive; this stands in for the socket.
    const keepAlive = setInterval(() => {}, 1000);
    s.addEventListener("abort", () => { clearInterval(keepAlive); reject(asError(s.reason)); });
  });
}) as unknown as typeof fetch;

const breakerFailures = (): number => (getDbCompat().query("SELECT consecutive_failures AS n FROM circuit_state WHERE id = 1").get() as { n: number } | null)?.n ?? 0;
const lastStatuses = (): string[] => (getDbCompat().query("SELECT status FROM llm_call_log ORDER BY id").all() as { status: string }[]).map((r) => r.status);

describe("a timeout is recognised", () => {
  it("by the error Node 22 gives, by an abort with a timeout cause, and by the network layer's timeout codes", () => {
    expect(isTimeoutError(new DOMException("The operation was aborted due to timeout", "TimeoutError"))).toBe(true);
    expect(isTimeoutError(Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } }))).toBe(true);
    expect(isTimeoutError(Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_BODY_TIMEOUT" } }))).toBe(true);
    expect(isTimeoutError(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe(true);
  });
  it("and an ordinary failure, a user abort or a 503 is not one", () => {
    expect(isTimeoutError(new Error("OpenAI 401: bad key"))).toBe(false);
    expect(isTimeoutError(Object.assign(new Error("OpenAI 503: unavailable"), { status: 503 }))).toBe(false);
    expect(isTimeoutError(new DOMException("This operation was aborted", "AbortError"))).toBe(false);
    expect(isTimeoutError(undefined)).toBe(false);
  });
});

describe("the deadline", () => {
  it("defaults to well under the old 10 minutes, and PURIX_LLM_TIMEOUT_MS sets it; nonsense falls back to the default", () => {
    delete process.env.PURIX_LLM_TIMEOUT_MS;
    const def = llmTimeoutMs();
    expect(def).toBeLessThan(600_000);
    expect(def).toBeGreaterThanOrEqual(60_000);
    process.env.PURIX_LLM_TIMEOUT_MS = "2500";
    expect(llmTimeoutMs()).toBe(2500);
    for (const bad of ["abc", "-5", "0", ""]) { process.env.PURIX_LLM_TIMEOUT_MS = bad; expect(llmTimeoutMs()).toBe(def); }
  });
  it("a hung server is cut off at the deadline by the real fetch (was: waited for the 10-minute default)", async () => {
    process.env.PURIX_LLM_TIMEOUT_MS = "400";
    const srv: Server = createServer(() => { /* never answers */ });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const port = (srv.address() as { port: number }).port;
      const t0 = Date.now();
      const err = await netFetch("llm-provider", `http://127.0.0.1:${port}/x`, { method: "POST" }).catch((e) => e);
      expect(Date.now() - t0).toBeLessThan(3000);
      expect(isTimeoutError(err)).toBe(true);
    } finally { srv.closeAllConnections(); srv.close(); }
  });
});

describe("callLlm and a call that hangs", () => {
  it("retries a timeout up to the cap, then fails with a clear error that says it is the provider or network", async () => {
    process.env.PURIX_LLM_TIMEOUT_MS = "100";
    const c = { n: 0 };
    globalThis.fetch = hangingFetch(c);
    const err = await callLlm("prompt", "change_classification", "low").catch((e) => e);
    expect(c.n).toBe(TIMEOUT_MAX_RETRIES + 1);
    expect(err).toBeInstanceOf(ModelCallTimeoutError);
    expect(err.message).toMatch(/timed out/i);
    expect(err.message).toContain("PURIX_LLM_TIMEOUT_MS");
    expect(err.message).toMatch(/provider|network/i);
    expect(err.attempts).toBe(TIMEOUT_MAX_RETRIES + 1);
  });
  it("counts each timed-out attempt for the breaker, logs it as a timeout, and charges nothing", async () => {
    process.env.PURIX_LLM_TIMEOUT_MS = "100";
    globalThis.fetch = hangingFetch({ n: 0 });
    await callLlm("prompt", "change_classification", "low").catch(() => {});
    expect(breakerFailures()).toBe(TIMEOUT_MAX_RETRIES + 1);
    expect(lastStatuses()).toEqual(Array(TIMEOUT_MAX_RETRIES + 1).fill("timeout"));
    expect(getBudgetSnapshot()?.totalSpentUsd).toBe(0);
  });
  it("a call that times out once and then answers returns the answer", async () => {
    process.env.PURIX_LLM_TIMEOUT_MS = "100";
    let n = 0;
    const hang = hangingFetch({ n: 0 });
    globalThis.fetch = (async (u: unknown, init?: RequestInit) => {
      if (++n === 1) return hang(u as string, init);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
    });
    await expect(callLlm("prompt", "change_classification", "low")).resolves.toBe("ok");
    expect(n).toBe(2);
    expect(breakerFailures()).toBe(0);
  });
  it("other transient errors keep their four retries", async () => {
    let n = 0;
    globalThis.fetch = (async () => { n++; return new Response("Service Unavailable", { status: 503 }); });
    await callLlm("prompt", "change_classification", "low").catch(() => {});
    expect(n).toBe(5);
  });
  it("a plain 401 is not retried", async () => {
    let n = 0;
    globalThis.fetch = (async () => { n++; return new Response("bad key", { status: 401 }); });
    await callLlm("prompt", "change_classification", "low").catch(() => {});
    expect(n).toBe(1);
  });
});

describe("retry waits", () => {
  it("grow 1, 2, 4, 8 seconds with up to half again added at random, so clients on one key do not retry in step", () => {
    expect([1, 2, 3, 4].map((a) => retryDelayMs(a, () => 0))).toEqual([1000, 2000, 4000, 8000]);
    expect([1, 2, 3, 4].map((a) => retryDelayMs(a, () => 0.999999))).toEqual([1499, 2999, 5999, 11999]);
    setRetryHooksForTests(undefined);
    const seen = new Set(Array.from({ length: 50 }, () => retryDelayMs(3)));
    expect(seen.size).toBeGreaterThan(10);
  });
  it("callLlm sleeps the computed wait between attempts", async () => {
    const waits: number[] = [];
    setRetryHooksForTests({ random: () => 0.5, sleep: async (ms) => { waits.push(ms); } });
    globalThis.fetch = (async () => new Response("Service Unavailable", { status: 503 }));
    await callLlm("prompt", "change_classification", "low").catch(() => {});
    expect(waits).toEqual([1250, 2500, 5000, 10000]);
  });
});

describe("the cost ceiling", () => {
  it("the refusal says how to start a new budget and how to raise the ceiling, and still starts with the old words", () => {
    process.env.PURIX_COST_CEILING_USD = "0.06";
    assertBudgetAvailable();
    let msg = "";
    try { assertBudgetAvailable(); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/^Cost guardrail tripped/);
    expect(msg).toContain("purix budget reset");
    expect(msg).toContain("PURIX_COST_CEILING_USD");
    expect(msg).toMatch(/this repository/i);
  });
  it("resetBudget starts the total again, keeps a record of who reset it and why, and calls work again", () => {
    process.env.PURIX_COST_CEILING_USD = "0.06";
    assertBudgetAvailable();
    expect(() => assertBudgetAvailable()).toThrow(/Cost guardrail tripped/);
    const r = resetBudget("end of the experiment");
    expect(r.previousTotalUsd).toBeCloseTo(0.05, 5);
    expect(getBudgetSnapshot()?.totalSpentUsd).toBe(0);
    expect(() => assertBudgetAvailable()).not.toThrow();
    const audits = getOverrideAudits().filter((a) => a.gate_name === "BudgetReset");
    expect(audits.length).toBe(1);
    expect(audits[0]!.reason).toBe("end of the experiment");
    expect(audits[0]!.finding).toContain("0.05");
  });
  it("resetBudget needs a reason and changes nothing without one", () => {
    process.env.PURIX_COST_CEILING_USD = "0.06";
    assertBudgetAvailable();
    expect(() => resetBudget("   ")).toThrow(/reason/i);
    expect(getBudgetSnapshot()?.totalSpentUsd).toBeCloseTo(0.05, 5);
    expect(getOverrideAudits().filter((a) => a.gate_name === "BudgetReset")).toEqual([]);
  });
});
