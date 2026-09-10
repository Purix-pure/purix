// packages/mcp-server/src/live_test.test.ts
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPurixMcpServer } from "./server";
import { closeDb, writeManifest } from "@purix/core/manifest/store";
import type { ManifestEntry } from "@purix/core/manifest/schema";

function makeEntry(id: string, lang: string, opts: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    component_id: id,
    component_type: "module",
    current_version: 1,
    schema_version: 3,
    parts: { tools: [], config: {} },
    files: [`${id}.${lang === "python" ? "py" : lang === "rust" ? "rs" : lang === "go" ? "go" : lang === "ruby" ? "rb" : "ts"}`],
    depends_on: [],
    depended_on_by: [],
    version_history: [],
    verification_status: "pass",
    last_synced_hash: "abc123hash",
    language: lang as any,
    ...opts,
  };
}

describe("MCP Server Live Protocol Test across Languages", () => {
  let tmpDir: string;
  let oldCwd: string;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "purix-mcp-live-"));
    oldCwd = process.cwd();
    process.chdir(tmpDir);
    process.env.AUTO_CONFIRM = "1";
    process.env.PURIX_LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test_openai_key";
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  operation: "update_prompt_text",
                  contract_changing: false,
                  confidence: 0.9,
                  reasoning: "test-fixture classification",
                  edits: [],
                  suspicious_injected_instruction: false,
                }),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        }),
        { status: 200 }
      );
    }) as typeof fetch;
  });

  afterEach(() => {
    closeDb();
    process.chdir(oldCwd);
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.AUTO_CONFIRM;
    globalThis.fetch = originalFetch;
    delete process.env.PURIX_LLM_PROVIDER;
    delete process.env.OPENAI_API_KEY;
  });

  test("connects via InMemoryTransport, lists tools, and executes calls for python, rust, go, ruby components", async () => {
    writeManifest(makeEntry("py-comp", "python"));
    writeManifest(makeEntry("rs-comp", "rust"));
    writeManifest(makeEntry("go-comp", "go"));
    writeManifest(makeEntry("rb-comp", "ruby"));

    const server = createPurixMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} }
    );

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    // 1. List tools
    // Updated for the coding-agent command-surface expansion (2026-09-08):
    // was a fixed length-4/positional check pinned to the original
    // purix_status/modify/index/ingest set. The server now exposes the
    // rest of the CLI's coding-work surface too (create/delete, drift,
    // migrations, observability, memory, tools, backup, reconcile) — see
    // server.ts's own header comment for the full list and for what was
    // deliberately left out. Checking by name/presence rather than
    // position + exact count keeps this from going stale again the next
    // time a tool is added.
    const toolsResult = await client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name).sort();
    expect(toolNames).toHaveLength(19);
    expect(toolNames).toEqual(
      [
        "purix_accept_drift",
        "purix_audit",
        "purix_audit_trail",
        "purix_audit_verify",
        "purix_backup",
        "purix_create",
        "purix_delete",
        "purix_ingest",
        "purix_index",
        "purix_library",
        "purix_migration_activate",
        "purix_migration_rollback",
        "purix_migrations_list",
        "purix_modify",
        "purix_reconcile",
        "purix_remember",
        "purix_stats",
        "purix_status",
        "purix_tools",
      ].sort()
    );

    // 2. Call purix_status
    const statusResult = await client.callTool({ name: "purix_status", arguments: {} });
    const statusContent = statusResult.content as Array<{ type: string; text?: string }>;
    const statusText = statusContent[0]?.text ?? "";
    const components = JSON.parse(statusText);
    expect(components.length).toBe(4);
    expect(components.map((c: any) => c.component_id).sort()).toEqual(["go-comp", "py-comp", "rb-comp", "rs-comp"]);

    // 3. Call purix_modify for python component
    const modPy = await client.callTool({
      name: "purix_modify",
      arguments: { componentId: "py-comp", instruction: "refactor add function" },
    });
    const pyContent = modPy.content as Array<{ type: string; text?: string }>;
    expect(pyContent[0]?.text ?? "").toContain("Sandbox execution");

    // 4. Call purix_modify for rust component
    const modRs = await client.callTool({
      name: "purix_modify",
      arguments: { componentId: "rs-comp", instruction: "optimize add logic" },
    });
    const rsContent = modRs.content as Array<{ type: string; text?: string }>;
    expect(rsContent[0]?.text ?? "").toContain("Sandbox execution");

    await client.close();
    await server.close();
  });
});