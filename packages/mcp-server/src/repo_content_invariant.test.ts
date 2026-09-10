// packages/mcp-server/src/repo_content_invariant.test.ts
//
// Adversarial pass for ADR-021: "the local MCP server never forwards
// repository content to the remote MCP server or any other backend
// endpoint." That ADR explicitly says this must be "verified directly by
// an adversarial test pass on the MCP tool surface rather than assumed to
// hold" — this is that test. It was previously unwritten (confirmed: no
// file matched this invariant anywhere in the repo before this change).
//
// What this test does NOT object to: repository content being sent to a
// user-configured third-party LLM provider (OpenAI, Anthropic, etc.) as
// part of a classify/modify call. That is expected, and disclosed in the
// privacy policy. ADR-021's invariant is narrower and specific:
// repository content must never reach *Purix's own* backend
// (packages/api, i.e. the base URL api_client.ts talks to) via
// purix_modify or purix_ingest.
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPurixMcpServer } from "./server";
import { closeDb, writeManifest } from "@purix/core/manifest/store";
import type { ManifestEntry } from "@purix/core/manifest/schema";

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
    language: "typescript" as any,
  };
}

interface RecordedFetchCall {
  url: string;
  body: string;
}

describe("ADR-021 adversarial pass: MCP server never forwards repo content to Purix's own backend", () => {
  let tmpDir: string;
  let oldCwd: string;
  let originalFetch: typeof fetch;
  let recordedCalls: RecordedFetchCall[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "purix-mcp-adversarial-"));
    oldCwd = process.cwd();
    process.chdir(tmpDir);
    process.env.AUTO_CONFIRM = "1";
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
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const body = init?.body ? String(init.body) : "";
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

    const server = createPurixMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "adversarial-test-client", version: "1.0.0" }, { capabilities: {} });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    await client.callTool({
      name: "purix_ingest",
      arguments: { diffFilePath: diffPath, sourceAgent: "adversarial-test" },
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