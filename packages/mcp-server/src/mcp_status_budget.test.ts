// AI-14 (PURIX-33): the text an agent pays for is bounded. Tool names, descriptions and schemas stay under a budget, and the
// concise views of purix_status and purix_audit_trail stay under 500 estimated tokens however many components exist.
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPurixMcpServer, createToolCaller } from "./server";
import { closeDb, writeManifest } from "@purix/core/manifest/store";
import type { ManifestEntry } from "@purix/core/manifest/schema";
import type { AuditTrailReport } from "@purix/core/manifest/audit_export";
import { computeSyncHash } from "@purix/core/state/hash";
import { estimateTokens } from "@purix/core/llm/context/tokens";
import { safeRmSync } from "@purix/core/platform/fs_retry";
import { buildConciseStatus, buildConciseAuditTrail, parseDetail, CONCISE_MAX_TOKENS } from "./status_view";

/** What the plan calls the text budget: names, descriptions and input schemas of every listed tool. */
const TOOL_TEXT_BUDGET_TOKENS = 3000;

let tmpDir: string;
let userDir: string;
let oldCwd: string;
let savedUserDir: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "purix-mcp-budget-"));
  userDir = mkdtempSync(join(tmpdir(), "purix-mcp-budget-user-"));
  savedUserDir = process.env.PURIX_USER_DIR;
  process.env.PURIX_USER_DIR = userDir;
  oldCwd = process.cwd();
  process.chdir(tmpDir);
});
afterEach(() => {
  closeDb();
  process.chdir(oldCwd);
  safeRmSync(tmpDir);
  safeRmSync(userDir);
  if (savedUserDir === undefined) delete process.env.PURIX_USER_DIR;
  else process.env.PURIX_USER_DIR = savedUserDir;
});

function comp(i: number, over: Partial<ManifestEntry> = {}): ManifestEntry {
  const id = `component-with-a-fairly-long-name-${String(i).padStart(3, "0")}`;
  return {
    component_id: id, component_type: "module", current_version: 2, schema_version: 4,
    parts: { tools: [], config: {} }, files: [`src/${id}.ts`], depends_on: [], depended_on_by: [],
    version_history: [{ version: 2, operation: "update_prompt_text", patch_ref: "p", contract_changed: false, timestamp: `2026-10-${String(1 + (i % 15)).padStart(2, "0")}T10:00:00.000Z`, provenance: { source_type: "instruction", source_agent: "x" } }],
    verification_status: "pass", last_synced_hash: null, language: "typescript", ...over,
  };
}

describe("tool text budget", () => {
  test("names, descriptions and schemas of every tool stay within the budget, with headroom", async () => {
    const server = createPurixMcpServer();
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    const { tools } = await client.listTools();
    const text = tools.map((t) => JSON.stringify({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema })).join("\n");
    const tokens = estimateTokens(text);
    expect(tools.length).toBeGreaterThan(10);
    expect(tokens).toBeLessThanOrEqual(TOOL_TEXT_BUDGET_TOKENS);
    // Headroom: a budget that is already nearly spent turns the next honest description into a failing test.
    expect(tokens).toBeLessThanOrEqual(TOOL_TEXT_BUDGET_TOKENS * 0.9);
    await client.close();
    await server.close();
  });

  test("status and audit trail declare the detail field", async () => {
    const server = createPurixMcpServer();
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    const { tools } = await client.listTools();
    for (const n of ["purix_status", "purix_audit_trail"]) {
      const t = tools.find((x) => x.name === n)!;
      const detail = (t.inputSchema.properties as Record<string, { enum?: string[] }>).detail;
      expect([n, detail?.enum]).toEqual([n, ["concise", "full"]]);
    }
    await client.close();
    await server.close();
  });
});

describe("purix_status detail", () => {
  test("concise is the default and stays under the cap on a 100-component fixture", async () => {
    for (let i = 0; i < 100; i++) {
      writeManifest(comp(i, i % 7 === 0 ? { verification_status: "fail" } : i % 5 === 0 ? { verification_status: "pending" } : {}));
    }
    const call = createToolCaller();
    const concise = (await call("purix_status", {})).content[0]!.text;
    expect(estimateTokens(concise)).toBeLessThanOrEqual(CONCISE_MAX_TOKENS);
    expect(concise).toContain("100 components");
    expect(concise).toContain("more not shown");
    expect(concise).toContain('detail "full"');
    // Failing components come first.
    const firstListed = concise.split("\n").find((l) => l.startsWith("- "))!;
    expect(firstListed).toContain("fail");

    const full = (await call("purix_status", { detail: "full" })).content[0]!.text;
    // The full view is the whole manifest. On 100 components it is far larger than the concise view (and the existing
    // result cap in finalizeToolResult cuts it, which is exactly the cost the concise default avoids).
    expect(estimateTokens(full)).toBeGreaterThan(CONCISE_MAX_TOKENS * 10);
    expect(full.startsWith("[")).toBe(true);
    expect(full).toContain('"component_id"');
  });

  test("drift and a missing test file are reported without writing anything", async () => {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src/a.ts"), "export const a = 1;\n");
    writeFileSync(join(tmpDir, "src/a.test.ts"), "// t\n");
    writeFileSync(join(tmpDir, "src/b.ts"), "export const b = 1;\n");
    const hashA = computeSyncHash([{ path: "src/a.ts", content: "export const a = 1;\n" }, { path: "src/a.test.ts", content: "// t\n" }]);
    writeManifest({ ...comp(1), component_id: "clean", files: ["src/a.ts", "src/a.test.ts"], last_synced_hash: hashA });
    writeManifest({ ...comp(2), component_id: "moved", files: ["src/b.ts"], last_synced_hash: "0".repeat(64) });
    const text = (await createToolCaller()("purix_status", {})).content[0]!.text;
    expect(text).toContain("2 components");
    expect(text).toContain("Drifted 1");
    expect(text).toContain("No test file 1");
    expect(text).toContain("- moved: drift, no tests");
    expect(text).not.toContain("- clean:");
  });

  test("an all-clear project says so in one line", async () => {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src/a.ts"), "x\n");
    writeFileSync(join(tmpDir, "src/a.test.ts"), "y\n");
    const h = computeSyncHash([{ path: "src/a.ts", content: "x\n" }, { path: "src/a.test.ts", content: "y\n" }]);
    writeManifest({ ...comp(1), component_id: "ok", files: ["src/a.ts", "src/a.test.ts"], last_synced_hash: h });
    const text = (await createToolCaller()("purix_status", {})).content[0]!.text;
    expect(text).toContain("Nothing needs attention");
  });

  test("an empty project names the next call", () => {
    expect(buildConciseStatus([])).toContain("purix_index");
  });

  test("a bad detail value is refused with the field and the next call", async () => {
    const text = (await createToolCaller()("purix_status", { detail: "everything" })).content[0]!.text;
    expect(text).toContain('"detail"');
    expect(text).toContain("Call purix_status again");
    expect(parseDetail(undefined, "purix_status")).toEqual({ ok: true, detail: "concise" });
    expect(parseDetail("full", "purix_audit_trail")).toEqual({ ok: true, detail: "full" });
    const bad = parseDetail(5, "purix_audit_trail");
    expect(bad.ok).toBe(false);
  });

  test("a bad detail value on the audit trail is refused before the entitlement check", async () => {
    const text = (await createToolCaller()("purix_audit_trail", { detail: "x" })).content[0]!.text;
    expect(text).toContain("Call purix_audit_trail again");
  });
});

describe("audit trail concise view", () => {
  function report(n: number): AuditTrailReport {
    return {
      generated_at: "2026-10-16T00:00:00.000Z", component_filter: null, since: null, note: "Covers landed commits only.", overrides_not_attached: [],
      entries: Array.from({ length: n }, (_, i) => ({
        component_id: `component-with-a-fairly-long-name-${i % 40}`, version: i + 1, operation: "update_prompt_text", patch_ref: "p",
        contract_changed: i % 9 === 0, timestamp: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(), provenance: { source_type: "instruction" as const, source_agent: "claude-code" },
        gate_evidence: { confidence: 0.9, contract_changing_reported: false, test_integrity_flagged: false, coverage_flagged: false, escalation_involved: i % 11 === 0, overrides: [], approvals: i % 3 === 0 ? [] : [{ checkpoint_kind: "mcp_modify", approved: i % 4 !== 0, timestamp: "2026-10-01T00:00:00.000Z" }] },
      })),
    };
  }

  test("stays under the cap with 300 landed commits and says how to get the rest", () => {
    const { text, json } = buildConciseAuditTrail(report(300));
    expect(estimateTokens(text)).toBeLessThanOrEqual(CONCISE_MAX_TOKENS);
    expect(text).toContain("300 landed commits");
    expect(text).toContain('detail "full"');
    expect(text.indexOf("v300")).toBeGreaterThan(-1); // newest first
    expect(estimateTokens(JSON.stringify(json, null, 2))).toBeLessThanOrEqual(CONCISE_MAX_TOKENS * 2);
    expect((json.not_shown as number)).toBeGreaterThan(0);
  });

  test("an empty report says so", () => {
    expect(buildConciseAuditTrail(report(0)).text).toContain("No matching landed commits");
  });
});
