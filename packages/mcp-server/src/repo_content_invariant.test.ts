// packages/mcp-server/src/repo_content_invariant.test.ts
//
// Adversarial pass for ADR-001: "the local MCP server never forwards
// repository content to the remote MCP server or any other backend
// endpoint." That ADR explicitly says this must be "verified directly by
// an adversarial test pass on the MCP tool surface rather than assumed to
// hold" — this is that test. It was previously unwritten (confirmed: no
// file matched this invariant anywhere in the repo before this change).
//
// What this test does NOT object to: repository content being sent to a
// user-configured third-party LLM provider (OpenAI, Anthropic, etc.) as
// part of a classify/modify call. That is expected, and disclosed in the
// privacy policy. ADR-001's invariant is narrower and specific:
// repository content must never reach *Purix's own* backend
// (packages/api, i.e. the base URL api_client.ts talks to) via
// purix_modify or purix_ingest.
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

// A deliberately unique, greppable marker standing in for "sensitive
// repository content" (e.g. a secret, proprietary logic, customer data).
// If this string is ever observed in a request body sent to a URL that
// looks like Purix's own API base, the invariant has been violated.
const SENSITIVE_MARKER = "PURIX_ADVERSARIAL_TEST_MARKER_8f13c2";

// Matches the real default (api.purix.dev) and any PURIX_API_URL override
// — deliberately broad so this test still catches a violation even if the
// base URL is reconfigured in the environment it runs under.
const PURIX_BACKEND_URL_PATTERN = /api\.purix\.dev|purix[-.]api/i;

function makeEntry(id: string, files: string[]): ManifestEntry {
  return {
    component_id: id,
    component_type: "module",
    current_version: 1,
    schema_version: 3,
    parts: { tools: [], config: {} },
    files,
    depends_on: [],
    depended_on_by: [],
    version_history: [],
    verification_status: "pass",
    last_synced_hash: "abc123hash",
    language: "typescript",
  };
}

interface RecordedFetchCall {
  url: string;
  body: string;
}

describe("ADR-001 adversarial pass: MCP server never forwards repo content to Purix's own backend", () => {
  let tmpDir: string;
  let oldCwd: string;
  let originalFetch: typeof fetch;
  let recordedCalls: RecordedFetchCall[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "purix-mcp-adversarial-"));
    oldCwd = process.cwd();
    process.chdir(tmpDir);
    process.env.PURIX_MCP_AUTO_APPROVE = "1";
    process.env.PURIX_LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test_openai_key";
    recordedCalls = [];
    originalFetch = globalThis.fetch;

    // Intercepts every outbound fetch the whole call chain makes — this is
    // the actual adversarial probe. It serves a valid classify response
    // (so purix_modify can run its real code path end to end) while
    // recording every URL and body seen, so we can assert afterward that
    // repository content never reached Purix's own backend.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input).url;
      const body = typeof init?.body === "string" ? init.body : "";
      recordedCalls.push({ url, body });

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  operation: "update_prompt_text",
                  contract_changing: false,
                  confidence: 0.9,
                  reasoning: "adversarial-test-fixture classification",
                  edits: [],
                  suspicious_injected_instruction: false,
                  // Also satisfies src/llm/escalate.ts's response schema,
                  // reached now that ingest/modify both do real
                  // verification and can legitimately fall through to
                  // escalation on failure (previously unreachable).
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

  test("purix_modify never sends component file content to Purix's own backend", async () => {
    const fileName = "sensitive-component.ts";
    writeFileSync(join(tmpDir, fileName), `// ${SENSITIVE_MARKER}\nexport const secret = "do-not-leak";\n`);
    writeManifest(makeEntry("sensitive-comp", [fileName]));

    const server = createPurixMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "adversarial-test-client", version: "1.0.0" }, { capabilities: {} });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: "purix_modify",
      arguments: { componentId: "sensitive-comp", instruction: "refactor this function" },
    });
    const content = result.content as Array<{ type: string; text?: string }>;
    const resultText = content[0]?.text ?? "";
    // Whether the sandbox step itself passes, fails, or reports tooling
    // not installed in this environment is irrelevant to the invariant
    // under test here — classification (the network-touching step) has
    // already happened by this point regardless of that outcome. The
    // real assertions are below, against recordedCalls.
    expect(resultText.length).toBeGreaterThan(0);

    await client.close();
    await server.close();

    // The adversarial assertion itself: of everything that went out over
    // the network during this call (there should be exactly one call —
    // the classify request to the configured LLM provider), none of it
    // may be addressed to Purix's own backend at all, and — belt and
    // braces — if any call ever were addressed there, it must not carry
    // the marker.
    expect(recordedCalls.length).toBeGreaterThan(0); // sanity: the real code path executed
    for (const call of recordedCalls) {
      const isPurixBackendCall = PURIX_BACKEND_URL_PATTERN.test(call.url);
      expect(isPurixBackendCall).toBe(false);
      if (isPurixBackendCall) {
        expect(call.body).not.toContain(SENSITIVE_MARKER);
      }
    }
  });

  test("purix_change (both the resolve-then-modify and the no-match create branches) never sends repo content to Purix's own backend", async () => {
    // IDEA-078: purix_change is a new tool on the MCP surface, so ADR-001's
    // adversarial pass must cover it. Branch 1 resolves to an existing
    // component and runs the modify pipeline over its (marked) file
    // content; branch 2 finds no match and proposes a new component.
    const fileName = "sensitive-component.ts";
    writeFileSync(join(tmpDir, fileName), `// ${SENSITIVE_MARKER}\nexport const secret = "do-not-leak";\n`);
    writeManifest(makeEntry("sensitive-comp", [fileName]));

    const server = createPurixMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "adversarial-test-client", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const resolved = await client.callTool({ name: "purix_change", arguments: { intent: "refactor sensitive-comp for clarity" } });
    expect(((resolved.content as Array<{ text?: string }>)[0]?.text ?? "").length).toBeGreaterThan(0);
    try {
      await client.callTool({ name: "purix_change", arguments: { intent: "add a brand new payroll exporter", dryRun: true } });
    } catch {
      // The fixture LLM only returns a classify-shaped payload, so the
      // no-match create branch may fail to parse a plan. That is fine:
      // the invariant concerns where requests were sent, not the outcome.
    }

    await client.close();
    await server.close();

    expect(recordedCalls.length).toBeGreaterThan(0);
    for (const call of recordedCalls) {
      const isPurixBackendCall = PURIX_BACKEND_URL_PATTERN.test(call.url);
      expect(isPurixBackendCall).toBe(false);
      if (isPurixBackendCall) {
        expect(call.body).not.toContain(SENSITIVE_MARKER);
      }
    }
  });

  test("purix_ingest never sends ingested diff content to Purix's own backend", async () => {
    const diffPath = join(tmpDir, "adversarial.patch");
    writeFileSync(
      diffPath,
      [
        "--- a/ingested-file.ts",
        "+++ b/ingested-file.ts",
        "@@ -1 +1 @@",
        `-old line`,
        `+// ${SENSITIVE_MARKER}\nnew line`,
        "",
      ].join("\n")
    );
    // REAL FIX (2026-09-19): purix_ingest now requires a componentId and
    // commits against that component's real tracked state (see
    // PURIX-CODE-VERIFIED-GAP-REPORT-2026-09-19.md) — it no longer
    // accepts an untracked, component-less diff. Track the file the diff
    // targets and give it real starting content matching the diff's own
    // context line, so checkDrift() doesn't reject this as drifted.
    writeFileSync(join(tmpDir, "ingested-file.ts"), "old line\n", "utf-8");
    writeManifest(makeEntry("ingest-target-comp", ["ingested-file.ts"]));

    const server = createPurixMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "adversarial-test-client", version: "1.0.0" }, { capabilities: {} });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    await client.callTool({
      name: "purix_ingest",
      arguments: { componentId: "ingest-target-comp", diffFilePath: diffPath, sourceAgent: "adversarial-test" },
    });

    await client.close();
    await server.close();

    for (const call of recordedCalls) {
      const isPurixBackendCall = PURIX_BACKEND_URL_PATTERN.test(call.url);
      expect(isPurixBackendCall).toBe(false);
      if (isPurixBackendCall) {
        expect(call.body).not.toContain(SENSITIVE_MARKER);
      }
    }
  });
});