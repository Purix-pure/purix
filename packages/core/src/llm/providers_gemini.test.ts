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

describe("Gemini adapter goes through the network door", () => {
  it("sends the key in a header, never in the URL, to the documented REST endpoint", async () => {
    process.env.GEMINI_API_KEY = "gk-secret";
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    let seenBody: any = null;
    globalThis.fetch = (async (url: any, init: any) => {
      seenUrl = String(url);
      seenHeaders = init.headers;
      seenBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), { status: 200 });
    });
    await getProvider("gemini").generate("hello", "low", "be brief");
    expect(seenUrl.startsWith("https://generativelanguage.googleapis.com/v1beta/models/")).toBe(true);
    expect(seenUrl.endsWith(":generateContent")).toBe(true);
    expect(seenUrl).not.toContain("gk-secret");
    expect(seenHeaders["x-goog-api-key"]).toBe("gk-secret");
    expect(seenBody.contents[0].parts[0].text).toBe("hello");
    expect(seenBody.systemInstruction.parts[0].text).toBe("be brief");
  });
  it("turns an HTTP error into an error with a status, so retry logic can classify it", async () => {
    process.env.GEMINI_API_KEY = "gk-test";
    globalThis.fetch = (async () => new Response("quota", { status: 429 }));
    const p = getProvider("gemini");
    const err: any = await p.generate("hi", "low").catch((e) => e);
    expect(err.status).toBe(429);
    expect(p.isTransientError(err)).toBe(true);
  });
  it("ignores thought parts and joins the text parts", async () => {
    process.env.GEMINI_API_KEY = "gk-test";
    globalThis.fetch = (async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "hidden", thought: true }, { text: "a" }, { text: "b" }] } }] }), { status: 200 }));
    expect((await getProvider("gemini").generate("hi", "low")).text).toBe("ab");
  });
});
