// Coverage for the provider adapters, registry selection and persisted config. Every network call goes
// through a mocked global fetch — nothing here touches the network.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getProvider,
  activeProviderId,
  persistProviderChoice,
  persistCustomProvider,
  listProviders,
  priceFor,
} from "./providers";

const ENV_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "MY_KEY", "PURIX_LLM_PROVIDER", "PURIX_OPENAI_MODEL_HIGH"];
type Call = { url: string; init: any };

let tmp: string;
let oldCwd: string;
let realFetch: typeof fetch;
let saved: Record<string, string | undefined>;
let calls: Call[];

function mockFetch(build: (call: Call) => Response) {
  globalThis.fetch = (async (url: any, init: any) => {
    const call = { url: String(url), init };
    calls.push(call);
    return build(call);
  }) as typeof fetch;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("LLM provider adapters and selection", () => {
  beforeEach(() => {
    oldCwd = process.cwd();
    tmp = mkdtempSync(join(tmpdir(), "purix-adapters-"));
    process.chdir(tmp);
    realFetch = globalThis.fetch;
    calls = [];
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    persistProviderChoice("openai"); // also resets the module's cached provider between tests
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    process.chdir(oldCwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("OpenAI-compatible adapter", () => {
    it("sends a bearer-authenticated chat completion and maps text and usage", async () => {
      process.env.OPENAI_API_KEY = "sk-test";
      mockFetch(() => json({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 3, completion_tokens: 5 } }));
      const provider = getProvider("openai");
      expect(await provider.generate("hello", "low")).toEqual({ text: "hi", usage: { inputTokens: 3, outputTokens: 5 } });
      expect(calls[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
      expect(calls[0]!.init.headers.Authorization).toBe("Bearer sk-test");
      expect(JSON.parse(calls[0]!.init.body)).toEqual({ model: "gpt-4.1-mini", messages: [{ role: "user", content: "hello" }] });
    });
    it("tolerates a bare response (no choices, no usage)", async () => {
      process.env.OPENAI_API_KEY = "sk-test";
      mockFetch(() => json({}));
      expect(await getProvider("openai").generate("x", "high")).toEqual({ text: "", usage: { inputTokens: 0, outputTokens: 0 } });
    });
    it("explains how to supply a key when none is available", async () => {
      await expect(getProvider("openai").generate("x", "low")).rejects.toThrow(/OPENAI_API_KEY isn't available/);
    });
    it("turns a non-2xx reply into an Error carrying the status", async () => {
      process.env.OPENAI_API_KEY = "sk-test";
      mockFetch(() => new Response("slow down", { status: 429 }));
      const err: any = await getProvider("openai").generate("x", "low").catch((e) => e);
      expect(err.status).toBe(429);
      expect(err.message).toContain("OpenAI 429: slow down");
    });
    it("honours a PURIX_<ID>_MODEL_<TIER> override", () => {
      process.env.PURIX_OPENAI_MODEL_HIGH = "gpt-custom";
      expect(getProvider("openai").modelFor("high")).toBe("gpt-custom");
      expect(getProvider("openai").modelFor("low")).toBe("gpt-4.1-mini");
    });
    it("classifies transient errors (429, 5xx, quota, network) but not client errors", () => {
      const provider = getProvider("openai");
      expect(provider.isTransientError({ status: 429, message: "" })).toBe(true);
      expect(provider.isTransientError({ status: 503, message: "" })).toBe(true);
      expect(provider.isTransientError({ message: "Quota exceeded" })).toBe(true);
      expect(provider.isTransientError({ message: "read ECONNRESET" })).toBe(true);
      expect(provider.isTransientError({ message: "fetch failed" })).toBe(true);
      expect(provider.isTransientError({ status: 400, message: "bad request" })).toBe(false);
      expect(provider.isTransientError(undefined)).toBe(false);
    });
  });

  describe("Anthropic adapter", () => {
    it("joins only the text blocks and sends the api-key header", async () => {
      process.env.ANTHROPIC_API_KEY = "ak-test";
      mockFetch(() => json({ content: [{ type: "text", text: "a" }, { type: "tool_use" }, { type: "text", text: "b" }], usage: { input_tokens: 1, output_tokens: 2 } }));
      const out = await getProvider("anthropic").generate("p", "low");
      expect(out).toEqual({ text: "ab", usage: { inputTokens: 1, outputTokens: 2 } });
      expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
      expect(calls[0]!.init.headers["x-api-key"]).toBe("ak-test");
    });
    it("tolerates a bare response and reports HTTP failures with the status", async () => {
      process.env.ANTHROPIC_API_KEY = "ak-test";
      mockFetch(() => json({}));
      expect(await getProvider("anthropic").generate("p", "high")).toEqual({ text: "", usage: { inputTokens: 0, outputTokens: 0 } });
      mockFetch(() => new Response("overloaded", { status: 529 }));
      const err: any = await getProvider("anthropic").generate("p", "low").catch((e) => e);
      expect(err.status).toBe(529);
      expect(err.message).toContain("Anthropic 529");
    });
    it("fails clearly without a key", async () => {
      await expect(getProvider("anthropic").generate("p", "low")).rejects.toThrow(/ANTHROPIC_API_KEY isn't available/);
    });
  });

  describe("Gemini adapter (construction only — its SDK call is not exercised)", () => {
    it("builds a provider with model lookup and transient-error classification", () => {
      const provider = getProvider("gemini");
      expect(provider.id).toBe("gemini");
      expect(typeof provider.modelFor("low")).toBe("string");
      expect(provider.isTransientError({ status: 500, message: "" })).toBe(true);
    });
  });

  describe("custom provider and persisted config", () => {
    const cfg = { baseUrl: "http://127.0.0.1:1/v1/", keyEnvVar: "MY_KEY", modelLow: "small", modelHigh: "large", label: "Mine" };

    it("builds from persisted config, strips the trailing slash, and caches until the file changes", async () => {
      persistCustomProvider(cfg);
      process.env.MY_KEY = "k";
      mockFetch(() => json({ choices: [{ message: { content: "ok" } }] }));
      const first = getProvider("custom");
      expect((await first.generate("p", "low")).text).toBe("ok");
      expect(calls[0]!.url).toBe("http://127.0.0.1:1/v1/chat/completions");
      expect(JSON.parse(calls[0]!.init.body).model).toBe("small");
      expect(getProvider("custom")).toBe(first);

      persistCustomProvider({ ...cfg, modelLow: "smaller" });
      const future = new Date(Date.now() + 10_000);
      utimesSync(join(tmp, ".purix", "provider-config.json"), future, future);
      const rebuilt = getProvider("custom");
      expect(rebuilt).not.toBe(first);
      expect(rebuilt.modelFor("low")).toBe("smaller");
    });
    it("rejects a missing or incomplete custom config", () => {
      persistProviderChoice("custom");
      expect(() => getProvider("custom")).toThrow(/No custom provider is configured/);
      persistCustomProvider({ ...cfg, baseUrl: "" });
      expect(() => getProvider("custom")).toThrow(/missing a baseUrl/);
    });
    it("rejects unknown ids and caches registry providers", () => {
      expect(() => getProvider("no-such-provider")).toThrow(/Unknown LLM provider/);
      expect(getProvider("openai")).toBe(getProvider("openai"));
    });
    it("persistProviderChoice validates the id and keeps an existing custom block", () => {
      expect(() => persistProviderChoice("no-such-provider")).toThrow(/Unknown provider/);
      persistCustomProvider(cfg);
      persistProviderChoice("openai");
      const saved = JSON.parse(readFileSync(join(tmp, ".purix", "provider-config.json"), "utf8"));
      expect(saved.provider).toBe("openai");
      expect(saved.custom.keyEnvVar).toBe("MY_KEY");
    });
    it("activeProviderId prefers the env var, then the file, and explains when neither exists", () => {
      expect(activeProviderId()).toBe("openai");
      process.env.PURIX_LLM_PROVIDER = "groq";
      expect(activeProviderId()).toBe("groq");
      delete process.env.PURIX_LLM_PROVIDER;
      writeFileSync(join(tmp, ".purix", "provider-config.json"), "{ not json");
      expect(() => activeProviderId()).toThrow(/No LLM provider is configured/);
      rmSync(join(tmp, ".purix"), { recursive: true, force: true });
      expect(() => activeProviderId()).toThrow(/No LLM provider is configured/);
      mkdirSync(join(tmp, ".purix"));
    });
    it("getProvider() with no argument follows the active provider", () => {
      persistProviderChoice("groq");
      expect(getProvider().id).toBe("groq");
    });
  });

  describe("registry helpers", () => {
    it("listProviders ends with the custom escape hatch", () => {
      const all = listProviders();
      expect(all.map((p) => p.id)).toEqual(expect.arrayContaining(["openai", "anthropic", "gemini", "custom"]));
      expect(all[all.length - 1]!.id).toBe("custom");
    });
    it("priceFor uses the registry price, else the default", () => {
      expect(priceFor("anthropic", "low")).toEqual({ input: 0.8, output: 4 });
      expect(priceFor("no-such-provider", "high")).toEqual(priceFor("qwen", "high"));
    });
  });
});
