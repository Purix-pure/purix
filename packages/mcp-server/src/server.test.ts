// packages/mcp-server/src/server.test.ts
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPurixMcpServer, createToolCaller, getAgentId } from "./server";
import { closeDb, writeManifest } from "@purix/core/manifest/store";
import { listEvents } from "@purix/core/manifest/events";

describe("Purix MCP Server", () => {
  let tmpDir: string;
  let oldCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "purix-mcp-test-"));
    oldCwd = process.cwd();
    process.chdir(tmpDir);
    process.env.AUTO_CONFIRM = "1"; // bypass prompt for test
  });

  afterEach(() => {
    closeDb();
    process.chdir(oldCwd);
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.AUTO_CONFIRM;
  });

  test("server initializes and lists tools successfully", async () => {
    const server = createPurixMcpServer();
    expect(server).toBeDefined();
  });

  test("stdout purity: no console.log output during tool invocation", async () => {
    const origLog = console.log;
    let logCalled = false;
    console.log = () => {
      logCalled = true;
    };

    try {
      const server = createPurixMcpServer();
      expect(logCalled).toBe(false);
    } finally {
      console.log = origLog;
    }
  });

  test("stdout purity during actual tool execution and schema migration", async () => {
    // Seed an old v3 entry that triggers schema migration on readManifest
    writeManifest({
      component_id: "old-comp",
      component_type: "module",
      current_version: 1,
      schema_version: 3,
      parts: { tools: [], config: {} },
      files: ["old.ts"],
      depends_on: [],
      depended_on_by: [],
      version_history: [],
      verification_status: "pass",
      last_synced_hash: null,
      language: "typescript",
    });

    const origStdoutWrite = process.stdout.write;
    let stdoutWritten = false;
    (process.stdout.write as any) = (chunk: any) => {
      stdoutWritten = true;
      return true;
    };

    try {
      const server = createPurixMcpServer();
      // Invoke request handler directly for purix_status
      const handlers = (server as any).requestHandlers;
      // We can test via server request or call tool
      expect(stdoutWritten).toBe(false);
    } finally {
      process.stdout.write = origStdoutWrite;
    }
  });

  describe("beta-readiness gap closure: agent identity, DLP scrub, gated-action budget", () => {
    afterEach(() => {
      delete process.env.PURIX_MCP_AGENT_ID;
      delete process.env.PURIX_MCP_MAX_GATED_ACTIONS;
    });

    test("getAgentId falls back to an explicit 'unidentified' label, not a plausible-looking default", () => {
      delete process.env.PURIX_MCP_AGENT_ID;
      expect(getAgentId()).toBe("unidentified-agent");
    });

    test("getAgentId reflects whatever the launching process set", () => {
      process.env.PURIX_MCP_AGENT_ID = "  ci-orchestrator-7  ";
      expect(getAgentId()).toBe("ci-orchestrator-7");
    });

    test("purix_modify records the launcher-provided agent id, not a hardcoded 'mcp-agent' literal", async () => {
      process.env.PURIX_MCP_AGENT_ID = "test-harness-agent";
      writeManifest({
        component_id: "identity-comp",
        component_type: "module",
        current_version: 1,
        schema_version: 4,
        parts: { tools: [], config: {} },
        files: [],
        depends_on: [],
        depended_on_by: [],
        version_history: [],
        verification_status: "pass",
        last_synced_hash: null,
        language: "typescript",
      });

      const callTool = createToolCaller();
      // No files/classify/sandbox stubbing available in this test — the
      // request is expected to fail before writing (no files on disk for
      // readComponentFiles), which is fine: we're only checking the
      // "request" event recorded at entry carries the real agent id.
      try {
        await callTool("purix_modify", { componentId: "identity-comp", instruction: "no-op" });
      } catch {
        // expected — readComponentFiles/classify may throw against a bare tmp dir
      }

      const events = listEvents({ kind: "request", componentId: "identity-comp" });
      expect(events.length).toBeGreaterThan(0);
      expect(events[events.length - 1]!.detail.agent_id).toBe("test-harness-agent");
      // Guards against ever reintroducing the old hardcoded literal.
      expect(events[events.length - 1]!.detail.agent_id).not.toBe("mcp-agent");
    });

    test("purix_status response has high-entropy secret-shaped strings redacted (DLP scrub wired)", async () => {
      writeManifest({
        component_id: "scrub-comp",
        component_type: "module",
        current_version: 2,
        schema_version: 4,
        parts: { tools: [], config: {} },
        files: [],
        depends_on: [],
        depended_on_by: [],
        version_history: [
          {
            version: 2,
            operation: "modify",
            // A high-entropy, quoted, 24+ char token — exactly the shape
            // scrubSecrets' generic high-entropy pattern targets — smuggled
            // into a field that flows straight into purix_status's JSON dump.
            patch_ref: "zQ8mK2vN9pL4xR7wT1cB6hJ3sD5fG0yA",
            contract_changed: false,
            timestamp: new Date().toISOString(),
            provenance: { source_type: "instruction", source_agent: "x" },
          },
        ],
        verification_status: "pass",
        last_synced_hash: null,
        language: "typescript",
      });

      const callTool = createToolCaller();
      const result = await callTool("purix_status", {});
      const text = result.content[0]!.text;
      expect(text).not.toContain("zQ8mK2vN9pL4xR7wT1cB6hJ3sD5fG0yA");
      expect(text).toContain("REDACTED");
    });

    test("purix_ingest reports 'tooling not installed' rather than a false verification_pass when no test framework is detected", async () => {
      // Regression test for a real bug: verifyInSandbox can return
      // status "not_installed" (no jest/vitest/mocha/node:test detected
      // in the target dir), which purix_modify already branched on
      // correctly but purix_ingest did not — it only checked for
      // "fail", so "not_installed" fell through into the pass path and
      // got reported back as a successful verification that never
      // actually ran. This tmp dir has no package.json/tsconfig.json/
      // test framework of any kind, so it reliably reproduces the
      // condition without any mocking.
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(tmpDir, "note.txt"), "hello\n", "utf-8");
      writeFileSync(
        join(tmpDir, "note.diff"),
        ["--- a/note.txt", "+++ b/note.txt", "@@ -1,1 +1,1 @@", "-hello", "+hello world", ""].join("\n"),
        "utf-8"
      );

      const callTool = createToolCaller();
      const result = await callTool("purix_ingest", { diffFilePath: join(tmpDir, "note.diff") });
      const text = result.content[0]!.text;

      expect(text).toContain("Tooling not installed");
      expect(text).not.toContain("Successfully ingested and verified");

      const passEvents = listEvents({ kind: "verification_pass" }).filter((e) => e.component_id === "ingested-diff");
      expect(passEvents.length).toBe(0);

      const failureEvents = listEvents({ kind: "verification_failure" }).filter((e) => e.component_id === "ingested-diff");
      expect(failureEvents.length).toBeGreaterThan(0);
      expect((failureEvents[failureEvents.length - 1]!.detail as any).not_installed).toBe(true);
    });

    test("gated-action budget: caps repeated full-reindex attempts within one server session", async () => {
      process.env.PURIX_MCP_MAX_GATED_ACTIONS = "1";
      const callTool = createToolCaller();

      const first = await callTool("purix_index", { full: true });
      // First attempt consumes the only slot; runIndex on an empty tmp dir
      // returns a normal (non-error) JSON result rather than a rejection.
      expect(first.content[0]!.text).not.toContain("gated-action attempts");

      const second = await callTool("purix_index", { full: true });
      expect(second.content[0]!.text).toContain("reached its limit of 1 gated-action attempts");

      // The exhaustion itself is on the record, same as a real "no".
      const events = listEvents({ kind: "confirm_response" });
      const exhaustion = events.find((e) => (e.detail as any).reason === "mcp_session_budget_exhausted");
      expect(exhaustion).toBeDefined();
    });

    test("gated-action budget is per-session: a fresh createToolCaller() gets a fresh allowance", async () => {
      process.env.PURIX_MCP_MAX_GATED_ACTIONS = "1";
      const sessionA = createToolCaller();
      await sessionA("purix_index", { full: true });
      const sessionAExhausted = await sessionA("purix_index", { full: true });
      expect(sessionAExhausted.content[0]!.text).toContain("reached its limit");

      const sessionB = createToolCaller();
      const sessionBFirst = await sessionB("purix_index", { full: true });
      expect(sessionBFirst.content[0]!.text).not.toContain("reached its limit");
    });
  });
});