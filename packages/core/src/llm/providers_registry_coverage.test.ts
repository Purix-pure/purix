// src/llm/providers_registry_coverage.test.ts
//
// providers.test.ts only ever exercises getProvider() with "anthropic",
// "custom", "gemini" and "openai". The other 11 REGISTRY entries
// (deepseek, qwen, moonshot, zhipu, yi, mistral, groq, together,
// fireworks, xai, openrouter, perplexity) are all openai_compat — served
// by the SAME buildAdapter()/openAiCompatibleAdapter() code path already
// well-tested via "openai" — but because none of them was ever actually
// passed to getProvider(), their adapter closures (modelFor, generate,
// isTransientError) were never constructed, so node's function-coverage
// counted them as never-covered. This file drives every remaining
// registry id through getProvider() at least once, covering:
//   - construction (buildAdapter -> openAiCompatibleAdapter)
//   - modelFor() (and its env-var override path, for one representative id)
//   - generate() success (hits the shared fetch/parse logic with each
//     id's own baseUrl/keyEnvVar/label substituted in)
//   - isTransientError() true/false
//   - priceFor() for a registry id that has no custom `price` entry
//     (falls back to DEFAULT_PRICE — deepseek/qwen/etc paths differ here)
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProvider, priceFor, listProviders } from "./providers";
import { setSecret, deleteSecret } from "../security/secrets_manager";
import { safeRmSync } from "../platform/fs_retry.js";

// Every openai_compat REGISTRY id NOT already exercised by providers.test.ts
// or providers_gemini.test.ts, paired with its keyEnvVar and baseUrl so we
// can assert generate() actually hit the right endpoint with the right key.
const UNTESTED_OPENAI_COMPAT_PROVIDERS: { id: string; keyEnvVar: string; baseUrl: string }[] = [
  { id: "deepseek", keyEnvVar: "DEEPSEEK_API_KEY", baseUrl: "https://api.deepseek.com/v1" },
  { id: "qwen", keyEnvVar: "QWEN_API_KEY", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { id: "moonshot", keyEnvVar: "MOONSHOT_API_KEY", baseUrl: "https://api.moonshot.cn/v1" },
  { id: "zhipu", keyEnvVar: "ZHIPU_API_KEY", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  { id: "yi", keyEnvVar: "YI_API_KEY", baseUrl: "https://api.01.ai/v1" },
  { id: "mistral", keyEnvVar: "MISTRAL_API_KEY", baseUrl: "https://api.mistral.ai/v1" },
  { id: "groq", keyEnvVar: "GROQ_API_KEY", baseUrl: "https://api.groq.com/openai/v1" },
  { id: "together", keyEnvVar: "TOGETHER_API_KEY", baseUrl: "https://api.together.xyz/v1" },
  { id: "fireworks", keyEnvVar: "FIREWORKS_API_KEY", baseUrl: "https://api.fireworks.ai/inference/v1" },
  { id: "xai", keyEnvVar: "XAI_API_KEY", baseUrl: "https://api.x.ai/v1" },
  { id: "openrouter", keyEnvVar: "OPENROUTER_API_KEY", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "perplexity", keyEnvVar: "PERPLEXITY_API_KEY", baseUrl: "https://api.perplexity.ai" },
];

let tmpDir: string;
let oldCwd: string;
let originalFetch: typeof globalThis.fetch;
const allKeyEnvVars = UNTESTED_OPENAI_COMPAT_PROVIDERS.map((p) => p.keyEnvVar);

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "purix-providers-registry-test-"));
  oldCwd = process.cwd();
  process.chdir(tmpDir);
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  process.chdir(oldCwd);
  safeRmSync(tmpDir);
  globalThis.fetch = originalFetch;
  for (const key of allKeyEnvVars) delete process.env[key];
  delete process.env.PURIX_DEEPSEEK_MODEL_LOW;

  // CROSS-TEST POLLUTION FIX: security/secrets_manager.ts resolves its
  // on-disk store path ONCE at module-import time
  // (`createSecretsStore(join(process.cwd(), ".purix"))`), not per call —
  // so every setSecret()/getSecret() in this whole process, across every
  // test and every provider id, writes to the SAME physical store file on
  // disk, regardless of which temp dir is "current" via chdir(). Without
  // this cleanup, a secret set for one provider in one test (e.g.
  // "deepseek-secret-store-wins") silently persists into a LATER test for
  // a DIFFERENT provider that never called setSecret() at all, making
  // that later test read back the wrong key. Deleting every possible key
  // this file could have set, after every test, keeps tests independent
  // despite that shared-store behavior. deleteSecret() is a safe no-op
  // for a key that was never set.
  for (const key of allKeyEnvVars) deleteSecret(key);
});

describe("openai_compat registry providers — full roster", () => {
  for (const { id, keyEnvVar, baseUrl } of UNTESTED_OPENAI_COMPAT_PROVIDERS) {
    it(`builds, prices, and generates successfully for "${id}"`, async () => {
      process.env[keyEnvVar] = `${id}-test-key`;
      let capturedUrl: string | undefined;
      let capturedAuth: string | undefined;
      let capturedBody: any;
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedAuth = (init?.headers as Record<string, string> | undefined)?.Authorization;
        capturedBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: `hello from ${id}` } }],
            usage: { prompt_tokens: 11, completion_tokens: 22 },
          }),
          { status: 200 }
        );
      }) as typeof fetch;

      const provider = getProvider(id);
      expect(provider.id).toBe(id);

      const result = await provider.generate("test prompt", "low");
      expect(result.text).toBe(`hello from ${id}`);
      expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 22 });

      // Hits the shared baseUrl.replace(/\/$/, "") + "/chat/completions" line.
      expect(capturedUrl).toBe(`${baseUrl.replace(/\/$/, "")}/chat/completions`);
      expect(capturedAuth).toBe(`Bearer ${id}-test-key`);
      expect(capturedBody.messages).toEqual([{ role: "user", content: "test prompt" }]);
    });

    it(`isTransientError() classifies every branch — status codes, quota text, network errors, and the false fallthrough — for "${id}"`, async () => {
      process.env[keyEnvVar] = `${id}-test-key`;
      const provider = getProvider(id);
      // Branch 1: status === 429 (true side) / not-429 (covered by the
      // other branches below reaching their own true sides instead).
      expect(provider.isTransientError({ status: 429, message: "rate limited" })).toBe(true);
      // Branch 2: 500 <= status < 600 (true side), plus its own boundary:
      // 600 is NOT transient by this check (false side of the range test,
      // distinct from "no branches matched at all").
      expect(provider.isTransientError({ status: 503, message: "unavailable" })).toBe(true);
      expect(provider.isTransientError({ status: 600, message: "weird upstream code" })).toBe(false);
      // Branch 3: /quota/i on the message, independent of status (true
      // side) — status is undefined here, so this also covers the
      // `typeof status === "number"` false side of branch 2's guard.
      expect(provider.isTransientError({ status: undefined, message: "Quota exceeded for this key" })).toBe(true);
      // Branch 4: the network-error regex, each alternative at least once
      // (true side for the whole alternation).
      expect(provider.isTransientError({ status: undefined, message: "ECONNRESET" })).toBe(true);
      expect(provider.isTransientError({ status: undefined, message: "fetch failed" })).toBe(true);
      // False side: none of the four branches match anything in a plain
      // 400 with an unrelated message — the only way to reach `return false`.
      expect(provider.isTransientError({ status: 400, message: "bad request" })).toBe(false);
    });

    it(`priceFor("${id}") returns a positive price table`, () => {
      const low = priceFor(id, "low");
      const high = priceFor(id, "high");
      expect(low.input).toBeGreaterThan(0);
      expect(high.input).toBeGreaterThan(0);
    });

    it(`resolveKey() throws an actionable error for "${id}" when its key is missing`, async () => {
      delete process.env[keyEnvVar];
      const provider = getProvider(id);
      await expect(provider.generate("hi", "low")).rejects.toThrow(
        new RegExp(`${keyEnvVar} isn't available`)
      );
    });

    it(`resolveKey() uses the encrypted secrets store when no env var is set, for "${id}"`, async () => {
      delete process.env[keyEnvVar];
      setSecret(keyEnvVar, `${id}-secret-store-key`);
      let capturedAuth: string | undefined;
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        capturedAuth = (init?.headers as Record<string, string> | undefined)?.Authorization;
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: {} }), { status: 200 });
      }) as typeof fetch;

      const provider = getProvider(id);
      await provider.generate("hi", "low");
      expect(capturedAuth).toBe(`Bearer ${id}-secret-store-key`);
    });

    it(`resolveKey() prefers the encrypted secrets store over a plain env var when both are set, for "${id}"`, async () => {
      process.env[keyEnvVar] = "plain-env-key-should-lose";
      setSecret(keyEnvVar, `${id}-secret-store-wins`);
      let capturedAuth: string | undefined;
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        capturedAuth = (init?.headers as Record<string, string> | undefined)?.Authorization;
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: {} }), { status: 200 });
      }) as typeof fetch;

      const provider = getProvider(id);
      await provider.generate("hi", "low");
      expect(capturedAuth).toBe(`Bearer ${id}-secret-store-wins`);
    });

    it(`generate() falls back to empty text and zero usage when the response omits them, for "${id}"`, async () => {
      process.env[keyEnvVar] = `${id}-test-key`;
      // No `choices` array at all, and no `usage` object at all — exercises
      // the `??` fallback side of every optional-chained field, not just
      // the happy path where every field is present.
      globalThis.fetch = async () => new Response(JSON.stringify({}), { status: 200 });
      const provider = getProvider(id);
      const result = await provider.generate("hi", "low");
      expect(result.text).toBe("");
      expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    });

    it(`handles a non-ok HTTP response for "${id}"`, async () => {
      process.env[keyEnvVar] = `${id}-test-key`;
      globalThis.fetch = async () => new Response("rate limit exceeded", { status: 429 });
      const provider = getProvider(id);
      await expect(provider.generate("hi", "low")).rejects.toThrow(/429/);
    });

    it(`handles a non-ok HTTP response whose body can't even be read, for "${id}"`, async () => {
      // Covers the `.text().catch(() => "")` fallback side — a response
      // whose body stream throws when read, not just one with a normal
      // error body string.
      process.env[keyEnvVar] = `${id}-test-key`;
      const brokenRes = new Response("irrelevant", { status: 500 });
      Object.defineProperty(brokenRes, "text", {
        value: async () => {
          throw new Error("stream already consumed");
        },
      });
      globalThis.fetch = async () => brokenRes;
      const provider = getProvider(id);
      await expect(provider.generate("hi", "low")).rejects.toThrow(/500/);
    });
  }

  it("modelOverride() — env var present overrides the registry default; env var absent falls back to it (same provider, both sides)", async () => {
    process.env.DEEPSEEK_API_KEY = "k";
    const provider = getProvider("deepseek");

    // False side first: no override env var set yet -> registry default.
    delete process.env.PURIX_DEEPSEEK_MODEL_LOW;
    expect(provider.modelFor("low")).toBe("deepseek-chat");

    // True side: override env var set -> it wins over the registry default.
    process.env.PURIX_DEEPSEEK_MODEL_LOW = "deepseek-custom-override";
    expect(provider.modelFor("low")).toBe("deepseek-custom-override");

    let capturedModel: string | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedModel = JSON.parse(typeof init?.body === "string" ? init.body : "{}").model;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: {} }), { status: 200 });
    }) as typeof fetch;
    await provider.generate("hi", "low");
    expect(capturedModel).toBe("deepseek-custom-override");
  });

  it("listProviders() includes every registry id plus the custom escape hatch, in order", () => {
    const ids = listProviders().map((p) => p.id);
    for (const { id } of UNTESTED_OPENAI_COMPAT_PROVIDERS) {
      expect(ids).toContain(id);
    }
    expect(ids[ids.length - 1]).toBe("custom");
  });

  it("priceFor() — a registry id with its own price table uses it; one without falls back to DEFAULT_PRICE (both sides)", () => {
    // True side: deepseek defines its own `price` in REGISTRY, so priceFor
    // must return THAT, not the default.
    const deepseekLow = priceFor("deepseek", "low");
    expect(deepseekLow).toEqual({ input: 0.07, output: 0.28 });

    // False side: qwen has no `price` field in REGISTRY at all — priceFor
    // must hit the `def?.price?.[tier] ?? DEFAULT_PRICE[tier]` fallback.
    const qwenLow = priceFor("qwen", "low");
    const qwenHigh = priceFor("qwen", "high");
    expect(qwenLow).toEqual({ input: 0.20, output: 0.60 });
    expect(qwenHigh).toEqual({ input: 1.50, output: 6.00 });

    // Sanity: the two really are different tables, proving the branch
    // actually switched rather than both coincidentally matching DEFAULT_PRICE.
    expect(deepseekLow).not.toEqual(qwenLow);
  });
});