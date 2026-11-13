// H1: a provider's reply is data from outside. A wrong shape must give an empty reply and zero usage (what a missing field already gave),
// never a TypeError, a non-string text or a non-number token count. Before this, a `null` body threw in all three adapters, a content
// object or a null block threw in the Anthropic one, a parts string threw in the Gemini one, an OpenAI content list came back as a list,
// and token counts such as "5", {} or -3 went straight into the cost figures.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProvider, persistProviderChoice, activeProviderId, projectCustomProvider } from "./providers.js";
import { safeRmSync } from "../platform/fs_retry.js";

const KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "PURIX_LLM_PROVIDER"];
let tmp: string;
let cwd: string;
let realFetch: typeof fetch;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  cwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "purix-malformed-"));
  process.chdir(tmp);
  realFetch = globalThis.fetch;
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]) process.env[k] = "test-key";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  process.chdir(cwd);
  safeRmSync(tmp, { recursive: true, force: true });
});

function reply(body: unknown): void {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 }));
}
async function ask(id: string) {
  persistProviderChoice(id);
  return getProvider(id).generate("p", "high", undefined);
}

const WRONG_SHAPES: [string, unknown][] = [
  ["null", null],
  ["a number", 7],
  ["a string", "hi"],
  ["an array", []],
  ["an empty object", {}],
];

describe("H1: provider replies of the wrong shape", () => {
  for (const id of ["openai", "anthropic", "gemini"]) {
    for (const [name, body] of WRONG_SHAPES) {
      it(`${id}: ${name} gives an empty reply, no throw`, async () => {
        reply(body);
        const r = await ask(id);
        expect(r.text).toBe("");
        expect(r.usage.inputTokens).toBe(0);
        expect(r.usage.outputTokens).toBe(0);
      });
    }
  }

  it("openai: a content list of text parts is joined into one string", async () => {
    reply({ choices: [{ message: { content: [{ type: "text", text: "he" }, { type: "image", text: "no" }, { text: "llo" }] } }] });
    expect((await ask("openai")).text).toBe("hello");
  });

  it("openai: content that is neither a string nor a list is empty", async () => {
    reply({ choices: [{ message: { content: { a: 1 } } }] });
    expect((await ask("openai")).text).toBe("");
  });

  it("anthropic: content that is an object, and a null block among real ones, do not throw", async () => {
    reply({ content: { type: "text", text: "x" } });
    expect((await ask("anthropic")).text).toBe("");
    reply({ content: [null, 3, { type: "text", text: "ok" }, { type: "tool_use" }] });
    expect((await ask("anthropic")).text).toBe("ok");
  });

  it("gemini: parts that is a string does not throw; a null part among real ones is skipped; thought parts stay out", async () => {
    reply({ candidates: [{ content: { parts: "abc" } }] });
    expect((await ask("gemini")).text).toBe("");
    reply({ candidates: [{ content: { parts: [null, { text: "a", thought: true }, { text: "ok" }] } }] });
    expect((await ask("gemini")).text).toBe("ok");
  });

  it("token counts that are not finite non-negative numbers become 0, in every adapter", async () => {
    reply({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: "5", completion_tokens: -3, prompt_tokens_details: { cached_tokens: "x" } } });
    const o = await ask("openai");
    expect(o.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    reply({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: {}, output_tokens: null } });
    expect((await ask("anthropic")).usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    reply({ candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: { promptTokenCount: Infinity, candidatesTokenCount: "9" } });
    expect((await ask("gemini")).usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("real counts still pass through", async () => {
    reply({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } } });
    expect((await ask("openai")).usage).toEqual({ inputTokens: 12, outputTokens: 3, cachedInputTokens: 4 });
  });

  it("an HTTP error still carries its status for the retry rule", async () => {
    globalThis.fetch = (async () => new Response("slow down", { status: 429 }));
    persistProviderChoice("openai");
    const p = getProvider("openai");
    const err = await p.generate("p", "high", undefined).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(p.isTransientError(err)).toBe(true);
    expect(p.isTransientError(null)).toBe(false);
    expect(p.isTransientError("text")).toBe(false);
  });
});

describe("H1: the persisted provider file may hold anything", () => {
  function writeConfig(text: string): void {
    mkdirSync(join(tmp, ".purix"), { recursive: true });
    writeFileSync(join(tmp, ".purix", "provider-config.json"), text);
  }
  it("a file that is not an object, or has no text provider, is read as absent: the clear 'no provider' message, not a crash or an undefined id", () => {
    for (const text of ["null", "7", '"x"', "[]", '{"provider": 5}', "{not json"]) {
      writeConfig(text);
      expect(() => activeProviderId()).toThrow(/No LLM provider is configured/);
    }
  });
  it("a custom block missing any of its four text fields is dropped, never half-used", () => {
    writeConfig(JSON.stringify({ provider: "custom", custom: { baseUrl: "https://example.test/v1", keyEnvVar: "MY_KEY", modelLow: "a" } }));
    expect(activeProviderId()).toBe("custom");
    expect(projectCustomProvider(tmp)).toBeUndefined();
  });
});
