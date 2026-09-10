// src/llm/providers.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import {
  priceFor,
  listProviders,
  getProvider,
  persistProviderChoice,
  persistCustomProvider,
  activeProviderId,
} from "./providers";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { resolveTsxCommand } from "../test-support/real_node_modules";

const tsxCommand = resolveTsxCommand();

describe("LLM Providers & Pricing", () => {
  let tmpDir: string;
  let oldCwd: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "purix-providers-test-"));
    oldCwd = process.cwd();
    process.chdir(tmpDir);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    process.chdir(oldCwd);
    rmSync(tmpDir, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
    delete process.env.PURIX_LLM_PROVIDER;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  it("lists supported providers", () => {
    const providers = listProviders();
    expect(providers.length).toBeGreaterThan(0);
    expect(providers.some((p) => p.id === "anthropic")).toBe(true);
    expect(providers.some((p) => p.id === "openai")).toBe(true);
    expect(providers.some((p) => p.id === "gemini")).toBe(true);
    expect(providers.some((p) => p.id === "custom")).toBe(true);
  });

  it("returns pricing for low and high tiers", () => {
    const lowPrice = priceFor("anthropic", "low");
    expect(lowPrice.input).toBeGreaterThan(0);

    const highPrice = priceFor("anthropic", "high");
    expect(highPrice.input).toBeGreaterThan(lowPrice.input);

    const unknownPrice = priceFor("unknown-provider", "low");
    expect(unknownPrice.input).toBeGreaterThan(0);
  });

  it("gets known providers and exercises all registry adapters and generate methods", async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const providers = listProviders();
    for (const p of providers) {
      if (p.id === "custom") continue;
      process.env[p.keyEnvVar] = "test_key";
      const prov = getProvider(p.id);
      expect(prov.id).toBe(p.id);
      expect(prov.modelFor("low")).toBeTruthy();
      expect(prov.modelFor("high")).toBeTruthy();
      expect(typeof prov.isTransientError({ status: 429 })).toBe("boolean");
      try {
        await prov.generate("hello", "low");
      } catch {}
    }

    expect(() => getProvider("nonexistent")).toThrow(/Unknown LLM provider/);
  });

  it("persists and reads provider choice", () => {
    persistProviderChoice("openai");
    expect(activeProviderId()).toBe("openai");

    expect(() => persistProviderChoice("invalid_prov")).toThrow(/Unknown provider/);
  });

  it("handles custom provider configuration and generation", async () => {
    persistCustomProvider({
      baseUrl: "https://api.custom.com/v1",
      keyEnvVar: "CUSTOM_API_KEY",
      modelLow: "custom-low",
      modelHigh: "custom-high",
      label: "My Custom Provider",
    });

    process.env.CUSTOM_API_KEY = "custom_secret";

    let capturedUrl: string | undefined;
    let capturedHeaders: any;
    let capturedBody: any;

    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init?.headers;
      capturedBody = init?.body ? JSON.parse(init.body as string) : undefined;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "Custom response" } }],
          usage: { prompt_tokens: 3, completion_tokens: 7 },
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const provider = getProvider("custom");
    expect(provider.id).toBe("custom");
    expect(provider.modelFor("low")).toBe("custom-low");

    const result = await provider.generate("test prompt", "low");
    expect(result.text).toBe("Custom response");
    expect(result.usage.inputTokens).toBe(3);
    expect(result.usage.outputTokens).toBe(7);
    expect(capturedUrl).toBe("https://api.custom.com/v1/chat/completions");
    expect(capturedHeaders.Authorization).toBe("Bearer custom_secret");
    expect(capturedBody.model).toBe("custom-low");

    // Test transient error classification
    expect(provider.isTransientError({ status: 429, message: "Rate limit" })).toBe(true);
    expect(provider.isTransientError({ status: 500, message: "Internal Server Error" })).toBe(true);
    expect(provider.isTransientError({ status: 400, message: "Bad request" })).toBe(false);
    expect(provider.isTransientError(new Error("fetch failed"))).toBe(true);
  });

  it("throws when custom provider is used but not configured", () => {
    persistProviderChoice("custom");
    // clear config
    rmSync(join(tmpDir, ".purix"), { recursive: true, force: true });
    expect(() => getProvider("custom")).toThrow(/No custom provider is configured/);
  });

  it("handles OpenAI-compatible adapter non-ok response", async () => {
    process.env.OPENAI_API_KEY = "test_key";
    globalThis.fetch = (async () => {
      return new Response("Unauthorized", { status: 401 });
    }) as typeof fetch;

    const provider = getProvider("openai");
    await expect(provider.generate("prompt", "low")).rejects.toThrow(/OpenAI 401/);
  });

  it("handles Anthropic adapter generate and non-ok response", async () => {
    process.env.ANTHROPIC_API_KEY = "anthropic_key";
    let capturedHeaders: any;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "Anthropic response" }],
          usage: { input_tokens: 12, output_tokens: 15 },
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const provider = getProvider("anthropic");
    const result = await provider.generate("hello", "high");
    expect(result.text).toBe("Anthropic response");
    expect(result.usage.inputTokens).toBe(12);
    expect(capturedHeaders["x-api-key"]).toBe("anthropic_key");
    expect(capturedHeaders["anthropic-version"]).toBe("2023-06-01");

    // Non-ok response
    globalThis.fetch = (async () => new Response("Error", { status: 500 })) as typeof fetch;
    await expect(provider.generate("hello", "high")).rejects.toThrow(/Anthropic 500/);
  });

  it("getProvider('custom') picks up a config rewrite from a SEPARATE OS process without restart (Part 2 hot-reload fix)", async () => {
    // Establish the initial custom config and prime the in-process cache —
    // this simulates a long-lived process (the MCP server) that called
    // getProvider("custom") once at startup and holds onto whatever it got.
    persistCustomProvider({
      baseUrl: "https://api.custom-v1.com/v1",
      keyEnvVar: "CUSTOM_API_KEY",
      modelLow: "custom-low-v1",
      modelHigh: "custom-high-v1",
    });
    const before = getProvider("custom");
    expect(before.modelFor("low")).toBe("custom-low-v1");

    // A genuinely separate OS process rewrites provider-config.json's
    // custom block — NOT persistCustomProvider() called in this process,
    // which would trivially clear the module-level cache itself and prove
    // nothing about cross-process staleness.
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(
        tsxCommand[0]!,
        [
          ...tsxCommand.slice(1),
          join(import.meta.dirname, "providers_custom_config_write_worker.ts"),
          tmpDir,
          "https://api.custom-v2.com/v1",
          "custom-low-v2",
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("exit", (code) => (code === 0 ? resolvePromise() : reject(new Error(stderr))));
    });

    // Same process, same never-recreated getProvider() cache — before the
    // fix this would still return the v1 adapter forever.
    const after = getProvider("custom");
    expect(after.modelFor("low")).toBe("custom-low-v2");

    let capturedUrl: string | undefined;
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: {} }), { status: 200 });
    }) as typeof fetch;
    process.env.CUSTOM_API_KEY = "k";
    await after.generate("hi", "low");
    expect(capturedUrl).toBe("https://api.custom-v2.com/v1/chat/completions");
  });
});