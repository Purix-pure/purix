// P7 (first slice): when purix_change finds no exact match and is about to propose a NEW component, it names the existing components the
// request resembles (a partial-word overlap exact matching does not catch: "payments" against payment-gateway), so an agent does not create `add-retry-api-client` next to `api-client`. It suggests only; nothing is chosen for it.
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPurixMcpServer } from "./server";
import { closeDb, writeManifest } from "@purix/core/manifest/store";
import type { ManifestEntry } from "@purix/core/manifest/schema";
import { safeRmSync } from "@purix/core/platform/fs_retry";

let tmpDir: string, userDir: string, oldCwd: string, originalFetch: typeof fetch;
const comp = (id: string): ManifestEntry => ({
  component_id: id, component_type: "module", current_version: 1, schema_version: 4, parts: { tools: [], config: {} },
  files: [`${id}.ts`], depends_on: [], depended_on_by: [], version_history: [], verification_status: "pass", last_synced_hash: null,
});

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "purix-similar-"));
  userDir = mkdtempSync(join(tmpdir(), "purix-similar-user-"));
  process.env.PURIX_USER_DIR = userDir;
  process.env.PURIX_LLM_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "k";
  oldCwd = process.cwd();
  process.chdir(tmpDir);
  writeFileSync(join(tmpDir, "payment-gateway.ts"), "export const a = 1;\n");
  writeManifest(comp("payment-gateway"));
  originalFetch = globalThis.fetch;
  // The model-assisted mention step finds nothing; that is what sends the request to the new-component path.
  globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body !== "string" || !init.body) return new Response("{}", { status: 200 });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ mentions: [] }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  closeDb();
  process.chdir(oldCwd);
  safeRmSync(tmpDir);
  safeRmSync(userDir);
  for (const k of ["PURIX_USER_DIR", "PURIX_LLM_PROVIDER", "OPENAI_API_KEY"]) delete process.env[k];
});

async function change(args: Record<string, unknown>): Promise<string> {
  const server = createPurixMcpServer();
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const r = await client.callTool({ name: "purix_change", arguments: args });
  return (r.content as Array<{ text?: string }>).map((x) => x.text ?? "").join("\n");
}

describe("purix_change proposing a new component", () => {
  test("names the existing component the request resembles, and how to change it instead", async () => {
    const text = await change({ intent: "handle refunds for the payments", dryRun: true });
    expect(text).toContain("proposing a new one");
    expect(text).toContain("Similar existing component(s): payment-gateway");
    expect(text).toContain("componentId");
  });
  test("says nothing extra when nothing resembles the request", async () => {
    const text = await change({ intent: "build a calendar", dryRun: true });
    expect(text).toContain("proposing a new one");
    expect(text).not.toContain("Similar existing component");
  });
});
