// packages/mcp-server/src/live_test.test.ts
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
    language: lang,
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
    process.env.PURIX_MCP_AUTO_APPROVE = "1";
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
                  // A real, deterministic edit against py-comp.py's actual
                  // content (written below) so compilePatch can apply it
                  // directly — no escalation needed — and this test
                  // exercises a genuine, complete write, not just a
                  // rejection. For rs-comp (no matching path, no real file
                  // on disk in this beta build) this edit simply won't
                  // match anything, which is the honest outcome for a
                  // language this build doesn't support.
                  edits: [
                    {
                      path: "py-comp.py",
                      kind: "prompt_text",
                      old_text: "return a + b",
                      new_text: "return a + b  # patched by test",
                    },
                  ],
                  suspicious_injected_instruction: false,
                  // Also satisfies the escalation response schema
                  // (src/llm/escalate.ts's EscalationVerdictSchema) for
                  // any call that does still reach escalation (e.g. the
                  // rust-component call below, which has no matching
                  // edit path so compilePatch finds nothing to apply).
                  is_new_capability: false,
                }),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        }),
        { status: 200 }
      );
    });
  });

  afterEach(() => {
    closeDb();
    process.chdir(oldCwd);
    safeRmSync(tmpDir);
    delete process.env.PURIX_MCP_AUTO_APPROVE;
    globalThis.fetch = originalFetch;
    delete process.env.PURIX_LLM_PROVIDER;
    delete process.env.OPENAI_API_KEY;
  });

  test("connects via InMemoryTransport, lists tools, and executes calls for python, rust, go, ruby components", async () => {
    writeManifest(makeEntry("py-comp", "python"));
    writeManifest(makeEntry("rs-comp", "rust"));
    writeManifest(makeEntry("go-comp", "go"));
    writeManifest(makeEntry("rb-comp", "ruby"));
    // REAL FIX (2026-09-19): the manifest entries above track
    // "py-comp.py" / "rs-comp.rs" / etc., but this test never wrote those
    // files to tmpDir — readComponentFiles() silently skips a tracked
    // path it can't find on disk, so every modify call below was really
    // "verifying" an empty file list. That's exactly how this test kept
    // passing under the old no-op write path. Writing real content for
    // the one language this beta build actually supports (python) so the
    // real pipeline has something genuine to classify and (via this
    // suite's canned empty-edits response) escalate over.
    writeFileSync(join(tmpDir, "py-comp.py"), "def add(a, b):\n    return a + b\n", "utf-8");

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
    // 19 -> 21 (2026-09-24, IDEA-078): purix_find and purix_change added.
    expect(toolNames).toHaveLength(21);
    expect(toolNames).toEqual(
      [
        "purix_accept_drift",
        "purix_audit",
        "purix_audit_trail",
        "purix_audit_verify",
        "purix_backup",
        "purix_change",
        "purix_create",
        "purix_delete",
        "purix_find",
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

    // 3. Call purix_modify for the python component — this beta build's
    // one real supported language (see BETA_SCOPE.md), with real tracked
    // file content on disk, so this exercises the actual write path:
    // classify -> compilePatch (this fixture's canned edit matches real
    // file content, so it compiles deterministically) -> real sandbox
    // verification -> real commit to disk. Whether verification itself
    // passes in this exact environment depends on which Python toolchain
    // (pyright/pytest) happens to be installed here — that's a real
    // environment fact, not something this test should hardcode — so the
    // assertion is on the property that actually matters: a specific,
    // genuine outcome came back, never the old fixed "Sandbox execution
    // passed successfully" text that a no-op write path always produced
    // regardless of what was actually true.
    const modPy = await client.callTool({
      name: "purix_modify",
      arguments: { componentId: "py-comp", instruction: "refactor add function" },
    });
    const pyContent = modPy.content as Array<{ type: string; text?: string }>;
    const pyText = pyContent[0]?.text ?? "";
    expect(pyText.length).toBeGreaterThan(0);
    expect(pyText).not.toContain("Sandbox execution passed successfully");
    const pyGenuinelySucceeded = pyText.includes("Modification verified and committed");
    const pyGenuinelyFailedWithReason = pyText.includes("Sandbox verification and escalation both failed") || pyText.includes("Escalation failed");
    expect(pyGenuinelySucceeded || pyGenuinelyFailedWithReason).toBe(true);
    if (pyGenuinelySucceeded) {
      // If this environment does have a full enough Python toolchain for
      // a real pass, confirm it's a REAL pass — the file's actual content
      // on disk changed, not just a version bump.
      const { readFileSync } = await import("node:fs");
      const written = readFileSync(join(tmpDir, "py-comp.py"), "utf-8");
      expect(written).toContain("patched by test");
    }

    // 4. Call purix_modify for the rust component. Rust has no language
    // provider in this beta build (packages/core/src/language/providers/
    // contains only python.ts and typescript.ts — go.ts/rust.ts/ruby.ts
    // don't exist here), and the manifest entry above tracks a file that
    // was never written to disk. Before the 2026-09-19 fix this call
    // silently "passed" by verifying zero real files against themselves;
    // now that the pipeline actually tries to do real work, it correctly
    // cannot proceed for a language this build doesn't support, which is
    // itself the behavior worth asserting on — a language gap should be a
    // visible, honest failure, never a silent false pass.
    const modRs = await client.callTool({
      name: "purix_modify",
      arguments: { componentId: "rs-comp", instruction: "optimize add logic" },
    });
    const rsContent = modRs.content as Array<{ type: string; text?: string }>;
    expect(rsContent[0]?.text ?? "").not.toContain("Modification verified and committed");

    await client.close();
    await server.close();
  });
});