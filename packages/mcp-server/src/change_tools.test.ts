// packages/mcp-server/src/change_tools.test.ts
//
// IDEA-078 MCP surface: purix_find, purix_change, dryRun on create/modify,
// tool annotations on every tool, and backup path containment. The LLM
// provider is faked at fetch(); nothing here touches a network.
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPurixMcpServer, TOOL_METADATA } from "./server";
import { closeDb, writeManifest, readManifest } from "@purix/core/manifest/store";
import type { ManifestEntry } from "@purix/core/manifest/schema";
import { safeRmSync } from "@purix/core/platform/fs_retry";

const entry = (id: string, files: string[]): ManifestEntry => ({
  component_id: id, component_type: "module", current_version: 1, schema_version: 3,
  parts: { tools: [], config: {} }, files, depends_on: [], depended_on_by: [], version_history: [],
  verification_status: "pass", last_synced_hash: "abc", language: "typescript",
});

describe("MCP change surface", () => {
  let tmpDir: string;
  let oldCwd: string;
  let originalFetch: typeof fetch;
  let llmBodies: string[];
  let client: Client;

  const call = async (name: string, args: Record<string, unknown>) => {
    try {
      const r: any = await client.callTool({ name, arguments: args });
      return { text: String(r.content?.[0]?.text ?? ""), isError: r.isError === true };
    } catch (err) {
      // The SDK client surfaces a handler `throw` as a rejected call.
      return { text: err instanceof Error ? err.message : String(err), isError: true };
    }
  };

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "purix-mcp-change-"));
    oldCwd = process.cwd();
    process.chdir(tmpDir);
    delete process.env.PURIX_MCP_AUTO_APPROVE; // dry runs must work WITHOUT approval
    process.env.PURIX_LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test_key";
    llmBodies = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (!body) return new Response(JSON.stringify({ objects: [] }), { status: 200 }); // npm registry lookup
      llmBodies.push(body);
      const content = body.includes("PURIX_INTENT_")
        ? { mentions: [] }
        : body.includes("starter_content")
        ? { component_id: "rate-limiter", component_type: "module", files: [{ path: "rate-limiter.ts", purpose: "limit", starter_content: "export const limit = 1;\n" }], depends_on: [] }
        : { operation: "update_prompt_text", contract_changing: false, confidence: 0.9, reasoning: "fixture", edits: [], suspicious_injected_instruction: false, is_new_capability: false };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
    });

    writeFileSync(join(tmpDir, "billing.ts"), "export const a = 1;\n");
    writeManifest(entry("billing-service", ["billing.ts"]));
    writeManifest(entry("invoice-parser", ["src/invoice/parser.ts"]));
    writeManifest(entry("invoice-renderer", ["src/invoice/renderer.ts"]));

    const server = createPurixMcpServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    client = new Client({ name: "t", version: "0" });
    await client.connect(ct);
  });

  afterEach(async () => {
    await client.close();
    closeDb();
    process.chdir(oldCwd);
    safeRmSync(tmpDir);
    globalThis.fetch = originalFetch;
    delete process.env.PURIX_LLM_PROVIDER;
    delete process.env.OPENAI_API_KEY;
  });

  test("every tool lists a title and all four explicit annotation hints, and the table has no strays", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(TOOL_METADATA).sort());
    for (const t of tools) {
      const a: any = t.annotations;
      expect(typeof t.title).toBe("string");
      for (const k of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
        expect([t.name, k, typeof a?.[k]]).toEqual([t.name, k, "boolean"]);
      }
    }
    const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations as any]));
    expect(by.purix_find.readOnlyHint).toBe(true);
    expect(by.purix_status.readOnlyHint).toBe(true);
    expect(by.purix_delete.destructiveHint).toBe(true);
    expect(by.purix_create.destructiveHint).toBe(false);
    expect(by.purix_change.readOnlyHint).toBe(false);
  });

  test("purix_find: single, multiple, none — with no model call", async () => {
    expect(JSON.parse((await call("purix_find", { query: "look at billing-service" })).text)).toMatchObject({ outcome: "single", target: { componentId: "billing-service" } });
    const multi = JSON.parse((await call("purix_find", { query: "invoice" })).text);
    expect(multi.outcome).toBe("multiple");
    expect(multi.candidates.map((c: any) => c.componentId)).toEqual(["invoice-parser", "invoice-renderer"]);
    expect(JSON.parse((await call("purix_find", { query: "payroll" })).text).outcome).toBe("none");
    expect(llmBodies.length).toBe(0);
    expect((await call("purix_find", { query: "  " })).isError).toBe(true);
  });

  test("purix_change with several matches changes nothing and returns candidates without any model call", async () => {
    const r = await call("purix_change", { intent: "tidy the invoice code" });
    expect(JSON.parse(r.text)).toMatchObject({ outcome: "multiple" });
    expect(llmBodies.length).toBe(0);
  });

  test("purix_change validates its inputs", async () => {
    expect((await call("purix_change", { intent: "" })).isError).toBe(true);
    expect((await call("purix_change", { intent: "x".repeat(4001) })).isError).toBe(true);
    expect((await call("purix_change", { intent: "tweak", componentId: "nope" })).isError).toBe(true);
  });

  test("purix_modify dryRun needs no approval and writes nothing", async () => {
    const before = readFileSync(join(tmpDir, "billing.ts"), "utf-8");
    const r = await call("purix_modify", { componentId: "billing-service", instruction: "tweak", dryRun: true });
    expect(r.text).not.toMatch(/rejected|not approved|PURIX_MCP_AUTO_APPROVE/i);
    expect(readFileSync(join(tmpDir, "billing.ts"), "utf-8")).toBe(before);
    expect(readManifest("billing-service")?.current_version).toBe(1);
  });

  test("purix_change dryRun on a resolved target reports the target and writes nothing", async () => {
    const r = await call("purix_change", { intent: "round totals in billing-service", dryRun: true });
    expect(r.text).toContain("Target: billing-service");
    expect(r.text).not.toMatch(/rejected|PURIX_MCP_AUTO_APPROVE/i);
    expect(readManifest("billing-service")?.current_version).toBe(1);
  });

  test("purix_change with no match proposes a new component; dryRun writes nothing and needs no approval", async () => {
    const r = await call("purix_change", { intent: "add a rate limiter for outbound calls", dryRun: true });
    expect(r.text).toContain("proposing a new one");
    expect(r.text).toContain("Dry run — nothing written");
    expect(r.text).toContain("+ export const limit = 1;");
    expect(existsSync(join(tmpDir, "rate-limiter.ts"))).toBe(false);
    expect(readManifest("rate-limiter")).toBeFalsy();
    // the model saw the intent inside an untrusted-content envelope
    expect(llmBodies.some((b) => b.includes("PURIX_INTENT_") && b.includes("add a rate limiter"))).toBe(true);
  });

  test("purix_create dryRun does not overwrite when the planned id collides with an existing component", async () => {
    writeManifest(entry("rate-limiter", ["x.ts"]));
    const r = await call("purix_create", { name: "throttle", dryRun: true });
    expect(r.text).toContain("already exists");
    expect(readManifest("rate-limiter")?.files).toEqual(["x.ts"]);
  });

  test("purix_backup refuses paths outside the project directory", async () => {
    expect((await call("purix_backup", { outFile: "../escape.json" })).isError).toBe(true);
    expect((await call("purix_backup", { outFile: "/tmp/escape-purix.json" })).isError).toBe(true);
    expect((await call("purix_backup", { outFile: "." })).isError).toBe(true);
    expect((await call("purix_backup", { outFile: "backup.json" })).isError).toBe(false);
    expect(existsSync(join(tmpDir, "backup.json"))).toBe(true);
  });
});