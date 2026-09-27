// callLlm()'s transient-error retry: the first request fails with a 503, the back-off wait (1s, real) elapses, the
// second attempt succeeds. The existing tests skip the wait by starting at attempt 5; this one runs it once.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../manifest/store";
import { persistProviderChoice } from "./providers";
import { callLlm } from "./classify";
import { safeRmSync } from "../platform/fs_retry.js";

let cwd: string;
let tmp: string;
let realFetch: typeof fetch;
let log: typeof console.log;
let savedKey: string | undefined;

beforeEach(() => {
  cwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "purix-retry-"));
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
  // LIFECYCLE FIX: same closeDb()-then-delete Windows EPERM race as
  // budget_edges.test.ts — safeRmSync retries with backoff instead of
  // failing hard on a transient file-lock.
  closeDb();
  process.chdir(cwd);
  safeRmSync(tmp);
});

describe("callLlm transient retry", () => {
  it("retries once after a 503 and returns the second attempt's text", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return new Response("Service Unavailable", { status: 503 });
      return new Response(JSON.stringify({ choices: [{ message: { content: "recovered" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
    });
    const started = Date.now();
    await expect(callLlm("prompt", "low")).resolves.toBe("recovered");
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900); // the real 1s back-off ran
  });
});
