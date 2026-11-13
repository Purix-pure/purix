// src/ingest_not_tested.test.ts
//
// C3 item 5 / decision D-c (plan v4): after an MCP diff-ingest, the untested files must still be on the record.
// Reading the code showed resolveVerification records a verification_pass event WITH not_tested, and then purix_ingest recorded a
// second verification_pass WITHOUT it; `purix check`, the evidence bundle and `purix status` read the latest pass per component,
// so the second event erased the first. This test drives the real server over an in-memory transport with a project whose
// component has no test, so its file is "not tested", and reads the events back.
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { cpSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPurixMcpServer } from "./server";
import { closeDb, writeManifest } from "@purix/core/manifest/store";
import { listEvents } from "@purix/core/manifest/events";
import { latestNotTestedByComponent } from "@purix/core/manifest/not_tested";
import { safeRmSync } from "@purix/core/platform/fs_retry";
import { acquireRepoLock, releaseRepoLock } from "@purix/core/state/repo_lock";

const require = createRequire(import.meta.url);

describe("purix_ingest keeps the not-tested record (D-c)", () => {
  let dir: string;
  let cwd: string;
  let realFetch: typeof fetch;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    cwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "purix-mcp-ingest-nt-"));
    process.chdir(dir);
    for (const k of ["PURIX_MCP_AUTO_APPROVE", "PURIX_LLM_PROVIDER", "OPENAI_API_KEY", "PURIX_USER_DIR"]) saved[k] = process.env[k];
    process.env.PURIX_MCP_AUTO_APPROVE = "1";
    process.env.PURIX_LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test_openai_key";
    process.env.PURIX_USER_DIR = mkdtempSync(join(tmpdir(), "purix-mcp-ingest-user-"));
    realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ operation: "modify_code", contract_changing: false, confidence: 0.97, reasoning: "one-line body change", suspicious_injected_instruction: false }) } }],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        }),
        { status: 200 }
      ));
  });
  afterEach(() => {
    try { releaseRepoLock(dir); } catch { /* not held in this test */ }
    closeDb();
    process.chdir(cwd);
    safeRmSync(dir);
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  test("a component with no related test is still listed as not tested after the ingest lands", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "proj", version: "1.0.0", type: "module" }));
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true, types: [] }, include: ["*.ts"] }));
    writeFileSync(join(dir, "greet.ts"), 'export function greet(name: string): string {\n  return "hello " + name;\n}\n');
    cpSync(realpathSync(dirname(require.resolve("typescript/package.json"))), join(dir, "node_modules", "typescript"), { recursive: true });
    writeFileSync(join(dir, ".gitignore"), "node_modules\n");
    writeFileSync(
      join(dir, "greet.diff"),
      ["--- a/greet.ts", "+++ b/greet.ts", "@@ -1,3 +1,3 @@", " export function greet(name: string): string {", '-  return "hello " + name;', '+  return "hi " + name;', " }", ""].join("\n")
    );
    writeManifest({
      component_id: "greet", component_type: "module", current_version: 1, schema_version: 4, parts: { tools: [], config: {} },
      files: ["greet.ts"], depends_on: [], depended_on_by: [], version_history: [], verification_status: "pass", last_synced_hash: null, language: "typescript",
    });

    acquireRepoLock(dir); // the CLI takes this at start-up for the server process; the other MCP tests take it by hand too
    const server = createPurixMcpServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const res = await client.callTool({ name: "purix_ingest", arguments: { componentId: "greet", diffFilePath: join(dir, "greet.diff") } });
    const text = (res.content as Array<{ text?: string }>)[0]?.text ?? "";
    // The ingest must have landed, or this test says nothing about the record that follows it.
    expect(text).toMatch(/ingested and committed|committed/i);

    const passes = listEvents({ kind: "verification_pass" }).filter((e) => e.component_id === "greet");
    expect(passes.length).toBeGreaterThan(0);
    const latest = passes[passes.length - 1]!;
    expect(JSON.stringify(latest.detail)).toContain("greet.ts");
    expect(JSON.stringify(latest.detail.not_tested ?? null)).toContain("greet.ts");
    // and the reader that `purix check`, status and evidence rely on agrees
    const byComponent = latestNotTestedByComponent();
    expect(JSON.stringify(byComponent.get("greet") ?? null)).toContain("greet.ts");
  });
});
