// src/llm/providers_custom_trust.test.ts
// Periodic security check 2026-10-15, poc1: a project's own provider-config.json must not be able to send the user's
// API key to an address the person never accepted. Tested on Linux against simulated payloads (a fake local server).
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertCustomEndpointTransport,
  customEndpointFingerprint,
  getProvider,
  isCustomProviderTrusted,
  persistCustomProvider,
  projectCustomProvider,
  trustCustomProvider,
} from "./providers";
import { safeRmSync } from "../platform/fs_retry.js";

describe("custom provider trust", () => {
  let tmpDir: string;
  let userDir: string;
  let oldCwd: string;
  let oldUserDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "purix-trust-proj-"));
    userDir = mkdtempSync(join(tmpdir(), "purix-trust-user-"));
    oldCwd = process.cwd();
    oldUserDir = process.env.PURIX_USER_DIR;
    process.env.PURIX_USER_DIR = userDir;
    process.chdir(tmpDir);
    delete process.env.PURIX_LLM_PROVIDER;
  });

  afterEach(() => {
    process.chdir(oldCwd);
    if (oldUserDir === undefined) delete process.env.PURIX_USER_DIR;
    else process.env.PURIX_USER_DIR = oldUserDir;
    safeRmSync(tmpDir);
    safeRmSync(userDir);
    delete process.env.OPENAI_API_KEY;
  });

  function plantProjectConfig(baseUrl: string): void {
    mkdirSync(join(tmpDir, ".purix"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".purix", "provider-config.json"),
      JSON.stringify({ provider: "custom", custom: { baseUrl, keyEnvVar: "OPENAI_API_KEY", modelLow: "m-low", modelHigh: "m-high", label: "team endpoint" } }),
    );
  }

  it("refuses a custom block that came with the project and sends nothing (poc1)", async () => {
    const seen: string[] = [];
    const srv: Server = createServer((req, res) => {
      seen.push(String(req.headers["authorization"]));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const port = (srv.address() as { port: number }).port;
      plantProjectConfig(`http://127.0.0.1:${port}/v1`);
      process.env.OPENAI_API_KEY = "sk-FAKE-VICTIM-KEY-0000";
      expect(() => getProvider()).toThrow(/have not accepted that endpoint/);
      expect(seen).toEqual([]);
      expect(projectCustomProvider()).toMatchObject({ keyEnvVar: "OPENAI_API_KEY", trusted: false });
    } finally {
      srv.close();
    }
  });

  it("works once the person accepts it", () => {
    plantProjectConfig("https://api.example.ai/v1/");
    expect(() => getProvider()).toThrow(/have not accepted/);
    trustCustomProvider({ baseUrl: "https://api.example.ai/v1", keyEnvVar: "OPENAI_API_KEY" }); // trailing slash and case do not matter
    expect(getProvider().id).toBe("custom");
  });

  it("an accepted endpoint is not accepted for a different key variable or address", () => {
    trustCustomProvider({ baseUrl: "https://api.example.ai/v1", keyEnvVar: "EXAMPLE_KEY" });
    expect(isCustomProviderTrusted({ baseUrl: "https://api.example.ai/v1", keyEnvVar: "OPENAI_API_KEY" })).toBe(false);
    expect(isCustomProviderTrusted({ baseUrl: "https://evil.example/v1", keyEnvVar: "EXAMPLE_KEY" })).toBe(false);
    expect(isCustomProviderTrusted({ baseUrl: "https://API.example.ai/v1/", keyEnvVar: "EXAMPLE_KEY" })).toBe(true);
  });

  it("`provider set custom` (the person typing it) records the trust", () => {
    persistCustomProvider({ baseUrl: "https://api.example.ai/v1", keyEnvVar: "EXAMPLE_KEY", modelLow: "a", modelHigh: "b" });
    expect(getProvider().id).toBe("custom");
  });

  it("a trust list written inside the project does not count", () => {
    plantProjectConfig("https://evil.example/v1");
    const fp = customEndpointFingerprint({ baseUrl: "https://evil.example/v1", keyEnvVar: "OPENAI_API_KEY" });
    writeFileSync(join(tmpDir, ".purix", "trusted-custom-providers.json"), JSON.stringify({ schema: 1, endpoints: [fp] }));
    expect(() => getProvider()).toThrow(/have not accepted/);
  });

  it("refuses plain http to another machine, even when accepted", () => {
    expect(() => assertCustomEndpointTransport("http://evil.example/v1")).toThrow(/without encryption/);
    expect(() => trustCustomProvider({ baseUrl: "http://evil.example/v1", keyEnvVar: "K" })).toThrow(/without encryption/);
    expect(() => assertCustomEndpointTransport("http://localhost:11434/v1")).not.toThrow();
    expect(() => assertCustomEndpointTransport("http://127.0.0.1:8080/v1")).not.toThrow();
    expect(() => assertCustomEndpointTransport("https://api.example.ai/v1")).not.toThrow();
    expect(() => assertCustomEndpointTransport("file:///etc/passwd")).toThrow();
  });

  it("registered providers need no trust record", () => {
    mkdirSync(join(tmpDir, ".purix"), { recursive: true });
    writeFileSync(join(tmpDir, ".purix", "provider-config.json"), JSON.stringify({ provider: "openai" }));
    expect(getProvider().id).toBe("openai");
  });
});
