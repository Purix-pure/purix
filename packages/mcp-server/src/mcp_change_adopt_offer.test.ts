// P5 (parity): `purix change "<intent about a file that is indexed but not owned>"` offers to adopt it. `purix_change` used to skip that
// check and propose a brand-new component with a name made up from the sentence (add-retry-...), duplicating a file the project
// already has. It now answers with the same finding and the way forward, makes no model call, and proposes nothing.
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPurixMcpServer } from "./server";
import { closeDb, writeManifest, listManifest } from "@purix/core/manifest/store";
import { CODEBASE_INDEX_COMPONENT_ID } from "@purix/core/manifest/adopt";
import type { ManifestEntry, ComponentRecord } from "@purix/core/manifest/schema";
import { safeRmSync } from "@purix/core/platform/fs_retry";

let tmpDir: string, userDir: string, oldCwd: string;
let savedUserDir: string | undefined;
let originalFetch: typeof fetch;
let fetchCalls: number;

const entry = (o: Partial<ManifestEntry> & { component_id: string }): ManifestEntry => ({
  component_type: "module", current_version: 1, schema_version: 4, parts: { tools: [], config: {} },
  files: [], depends_on: [], depended_on_by: [], version_history: [], verification_status: "pending", last_synced_hash: null, ...o,
});
const rec = (symbol: string, file: string): ComponentRecord => ({
  symbol_name: symbol, file_location: file, signature: `export function ${symbol}`, language: "typescript",
  verification_status: "pass", last_verified_commit_hash: null, reusable: true, rationale: null,
});

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "purix-change-adopt-"));
  userDir = mkdtempSync(join(tmpdir(), "purix-change-adopt-user-"));
  savedUserDir = process.env.PURIX_USER_DIR;
  process.env.PURIX_USER_DIR = userDir;
  oldCwd = process.cwd();
  process.chdir(tmpDir);
  mkdirSync(join(tmpDir, "src"), { recursive: true });
  writeFileSync(join(tmpDir, "src", "api-client.ts"), "export function fetchUser() { return 1; }\n");
  writeManifest(entry({ component_id: CODEBASE_INDEX_COMPONENT_ID, component_type: "codebase_index", files: ["src/api-client.ts"], components: [rec("fetchUser", "src/api-client.ts")] }));
  // Any model call fails the test: the answer must come from exact matching alone.
  fetchCalls = 0;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { fetchCalls++; return new Response("{}", { status: 500 }); }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  closeDb();
  process.chdir(oldCwd);
  safeRmSync(tmpDir);
  safeRmSync(userDir);
  if (savedUserDir === undefined) delete process.env.PURIX_USER_DIR;
  else process.env.PURIX_USER_DIR = savedUserDir;
});

async function change(args: Record<string, unknown>): Promise<string> {
  const server = createPurixMcpServer();
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const r = await client.callTool({ name: "purix_change", arguments: args });
  return (r.content as Array<{ text?: string }>).map((x) => x.text ?? "").join("\n");
}

describe("purix_change with an indexed file nobody owns", () => {
  test("names the file, says how to adopt it, proposes no new component, and makes no model call", async () => {
    const text = await change({ intent: "add retry to src/api-client.ts" });
    const json = JSON.parse(text.slice(0, text.lastIndexOf("}") + 1));
    expect(json.outcome).toBe("adoptable");
    expect(json.file).toBe("src/api-client.ts");
    expect(json.next).toContain('purix_adopt with target "src/api-client.ts"');
    expect(text).not.toContain("proposing a new one");
    expect(fetchCalls).toBe(0);
    expect(listManifest().map((e) => e.component_id)).toEqual([CODEBASE_INDEX_COMPONENT_ID]);
  });

  test("finds it by an exact symbol name in the sentence, and a dry run gets the same answer", async () => {
    const text = await change({ intent: "make fetchUser retry on failure", dryRun: true });
    expect(JSON.parse(text.slice(0, text.lastIndexOf("}") + 1)).file).toBe("src/api-client.ts");
    expect(fetchCalls).toBe(0);
  });
});
