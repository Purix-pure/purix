// The Gemini adapter's real generate() path, driven fully offline: the SDK is loaded for real, and its HTTP call is
// answered by a mocked global fetch.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProvider, persistProviderChoice } from "./providers";

let cwd: string;
let tmp: string;
let realFetch: typeof fetch;
let savedKey: string | undefined;

beforeEach(() => {
  cwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "purix-gemini-"));
  process.chdir(tmp);
  realFetch = globalThis.fetch;
  savedKey = process.env.GEMINI_API_KEY;
  persistProviderChoice("gemini"); // resets the cached provider
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = savedKey;
  process.chdir(cwd);
  rmSync(tmp, { recursive: true, force: true });
});

describe("Gemini adapter generate()", () => {
  it("maps the SDK's text and token usage, and caches its client between calls", async () => {
    process.env.GEMINI_API_KEY = "gk-test";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(
        JSON.stringify({
          candidates: [{ content: { role: "model", parts: [{ text: "hello from gemini" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const provider = getProvider("gemini");
    const first = await provider.generate("hi", "low");
    expect(first).toEqual({ text: "hello from gemini", usage: { inputTokens: 7, outputTokens: 4 } });
    const second = await provider.generate("again", "high");
    expect(second.text).toBe("hello from gemini");
    expect(calls).toBe(2);
  });
  it("tolerates a response with no text or usage metadata", async () => {
    process.env.GEMINI_API_KEY = "gk-test";
    globalThis.fetch = (async () => new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [] } }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const out = await getProvider("gemini").generate("hi", "low");
    expect(out.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(typeof out.text).toBe("string");
  });
  it("fails clearly, before any request, when no key is available", async () => {
    delete process.env.GEMINI_API_KEY;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}");
    });
    await expect(getProvider("gemini").generate("hi", "low")).rejects.toThrow(/GEMINI_API_KEY isn't available/);
    expect(called).toBe(false);
  });
});
