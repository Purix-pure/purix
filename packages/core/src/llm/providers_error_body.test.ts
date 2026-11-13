// src/llm/providers_error_body.test.ts
//
// H3 remainder: a provider's error body is copied into the error message (500 characters). Providers echo the key you sent
// (masked) and sometimes a path or a known token. The message must not carry those, and must keep the status and the useful words.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProvider } from "./providers";
import { safeRmSync } from "../platform/fs_retry.js";

const BODY = '{"error":{"message":"Incorrect API key provided: sk-proj-************************wxyz. Token AKIAIOSFODNN7EXAMPLE seen."}}';

describe("provider error bodies are sanitized before they become an error message", () => {
  let tmpDir: string;
  let oldCwd: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "purix-provider-body-"));
    oldCwd = process.cwd();
    process.chdir(tmpDir);
    originalFetch = globalThis.fetch;
    process.env.OPENAI_API_KEY = "k1";
    process.env.ANTHROPIC_API_KEY = "k2";
    process.env.GEMINI_API_KEY = "k3";
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.chdir(oldCwd);
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    safeRmSync(tmpDir);
  });

  for (const [id, label] of [["openai", "OpenAI 401"], ["anthropic", "Anthropic 401"], ["gemini", "Gemini 401"]] as const) {
    it(`${id}: keeps the status, drops the key fragment and the token`, async () => {
      globalThis.fetch = (async () => new Response(BODY, { status: 401 }));
      const provider = getProvider(id);
      const err = await provider.generate("hi", "low").then(
        () => new Error("did not fail"),
        (e: unknown) => e as Error & { status?: number }
      );
      expect(err.message).toContain(label);
      expect(err.message).toContain("Incorrect API key provided");
      expect(err.message).not.toContain("wxyz");
      expect(err.message).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect((err as { status?: number }).status).toBe(401);
    });
  }

  it("a token that straddles the 500-character cut is still removed", async () => {
    const body = "x".repeat(489) + " AKIAIOSFODNN7EXAMPLE " + "y".repeat(100);
    globalThis.fetch = (async () => new Response(body, { status: 401 }));
    const err = await getProvider("openai").generate("hi", "low").then(
      () => new Error("did not fail"),
      (e: unknown) => e as Error
    );
    expect(err.message).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(err.message).not.toContain("AKIAIOSFO");
  });
});
