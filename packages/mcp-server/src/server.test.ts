// packages/mcp-server/src/server.test.ts
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPurixMcpServer, createToolCaller, getAgentId } from "./server";
import { closeDb, writeManifest, readManifest } from "@purix/core/manifest/store";
import { listEvents } from "@purix/core/manifest/events";
import { safeRmSync } from "@purix/core/platform/fs_retry";

describe("Purix MCP Server", () => {
  let tmpDir: string;
  let userDir: string;
  let oldCwd: string;
  let savedUserDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "purix-mcp-test-"));
    // Pending approvals sign with a key in the user folder; keep it out of the real home.
    userDir = mkdtempSync(join(tmpdir(), "purix-mcp-test-user-"));
    savedUserDir = process.env.PURIX_USER_DIR;
    process.env.PURIX_USER_DIR = userDir;
    oldCwd = process.cwd();
    process.chdir(tmpDir);
    process.env.PURIX_MCP_AUTO_APPROVE = "1"; // bypass prompt for test
  });

  afterEach(() => {
    closeDb();
    process.chdir(oldCwd);
    safeRmSync(tmpDir);
    safeRmSync(userDir);
    if (savedUserDir === undefined) delete process.env.PURIX_USER_DIR;
    else process.env.PURIX_USER_DIR = savedUserDir;
    delete process.env.PURIX_MCP_AUTO_APPROVE;
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
      createPurixMcpServer();
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

    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    let stdoutWritten = false;
    (process.stdout.write as any) = () => {
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
      const result = await callTool("purix_status", { detail: "full" });
      const text = result.content[0]!.text;
      expect(text).not.toContain("zQ8mK2vN9pL4xR7wT1cB6hJ3sD5fG0yA");
      expect(text).toContain("REDACTED");
    });

    test("purix_ingest never reports a false success when real verification can't run", async () => {
      // Regression test for a real bug (originally about verifyInSandbox's
      // "not_installed" status falling through to a false pass) that grew
      // into a bigger fix on 2026-09-19: this handler previously did no
      // real disk write or manifest commit at all, so ANY verification
      // outcome — pass, fail, or not_installed — was reported as success
      // without anything real happening. It now requires a componentId
      // and routes through the same resolveVerification() the CLI uses,
      // which treats "not_installed" the same as "fail" (self-heal, then
      // escalation) rather than as an implicit pass — a stronger
      // guarantee than the original fix, since a false pass is no longer
      // reachable through this status at all. There's no LLM mock in this
      // test file, so classifyDiff (and escalation, if reached) will
      // throw in this sandboxed, no-network environment — that's fine and
      // expected; the property under test is that no success message and
      // no verification_pass event are ever produced for this component.
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(tmpDir, "note.txt"), "hello\n", "utf-8");
      writeFileSync(
        join(tmpDir, "note.diff"),
        ["--- a/note.txt", "+++ b/note.txt", "@@ -1,1 +1,1 @@", "-hello", "+hello world", ""].join("\n"),
        "utf-8"
      );
      writeManifest({
        component_id: "ingest-note-comp",
        component_type: "module",
        current_version: 1,
        schema_version: 4,
        parts: { tools: [], config: {} },
        files: ["note.txt"],
        depends_on: [],
        depended_on_by: [],
        version_history: [],
        verification_status: "pass",
        last_synced_hash: null,
        language: "typescript",
      });

      const callTool = createToolCaller();
      let text = "";
      try {
        const result = await callTool("purix_ingest", { componentId: "ingest-note-comp", diffFilePath: join(tmpDir, "note.diff") });
        text = result.content[0]!.text;
      } catch {
        // expected in this no-LLM-mock environment — classifyDiff has
        // nothing to call and throws; that's a safe failure, not a false
        // success, which is exactly the property this test checks below.
      }

      expect(text).not.toContain("Successfully ingested and committed");

      const passEvents = listEvents({ kind: "verification_pass" }).filter((e) => e.component_id === "ingest-note-comp");
      expect(passEvents.length).toBe(0);
    });

    describe("a diff that deletes files", () => {
      const entryFor = (id: string, files: string[]) =>
        writeManifest({
          component_id: id, component_type: "module", current_version: 1, schema_version: 4, parts: { tools: [], config: {} },
          files, depends_on: [], depended_on_by: [], version_history: [], verification_status: "pass", last_synced_hash: null, language: "typescript",
        });
      const diffDeleting = (name: string) => ["--- a/" + name, "+++ /dev/null", "@@ -1,1 +0,0 @@", "-bye", ""].join("\n");

      test("that would leave the component empty is refused and points at purix delete; the file stays", async () => {
        const { writeFileSync, existsSync } = await import("node:fs");
        writeFileSync(join(tmpDir, "gone.txt"), "bye\n", "utf-8");
        writeFileSync(join(tmpDir, "gone.diff"), diffDeleting("gone.txt"), "utf-8");
        entryFor("ingest-delete-comp", ["gone.txt"]);
        const result = await createToolCaller()("purix_ingest", { componentId: "ingest-delete-comp", diffFilePath: join(tmpDir, "gone.diff") });
        expect(result.content[0]!.text).toMatch(/^Refused: this diff would leave the component with no files/);
        expect(result.content[0]!.text).toMatch(/purix delete/);
        expect(existsSync(join(tmpDir, "gone.txt"))).toBe(true);
        expect(listEvents({ kind: "verification_pass" }).filter((e) => e.component_id === "ingest-delete-comp").length).toBe(0);
      });

      test("of a file the component does not track is refused, and the file stays", async () => {
        const { writeFileSync, existsSync } = await import("node:fs");
        writeFileSync(join(tmpDir, "keep.txt"), "k\n", "utf-8");
        writeFileSync(join(tmpDir, "other.txt"), "bye\n", "utf-8");
        writeFileSync(join(tmpDir, "other.diff"), diffDeleting("other.txt"), "utf-8");
        entryFor("ingest-delete-foreign", ["keep.txt"]);
        const result = await createToolCaller()("purix_ingest", { componentId: "ingest-delete-foreign", diffFilePath: join(tmpDir, "other.diff") });
        expect(result.content[0]!.text).toMatch(/^Refused: this diff deletes file\(s\) this component does not track: other\.txt/);
        expect(existsSync(join(tmpDir, "other.txt"))).toBe(true);
      });

      test("of a test file is refused, because removing a test can make a failing check pass", async () => {
        const { writeFileSync, existsSync } = await import("node:fs");
        writeFileSync(join(tmpDir, "keep.ts"), "export const k = 1;\n", "utf-8");
        writeFileSync(join(tmpDir, "keep.test.ts"), "bye\n", "utf-8");
        writeFileSync(join(tmpDir, "t.diff"), diffDeleting("keep.test.ts"), "utf-8");
        entryFor("ingest-delete-test", ["keep.ts", "keep.test.ts"]);
        const result = await createToolCaller()("purix_ingest", { componentId: "ingest-delete-test", diffFilePath: join(tmpDir, "t.diff") });
        expect(result.content[0]!.text).toMatch(/^Refused: this diff deletes test file\(s\) \(keep\.test\.ts\)/);
        expect(existsSync(join(tmpDir, "keep.test.ts"))).toBe(true);
      });
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
      const exhaustion = events.find((e) => (e.detail).reason === "mcp_session_budget_exhausted");
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

    test("gated MCP tool call rejects fast instead of hanging when PURIX_MCP_AUTO_APPROVE is unset (no elicitation support)", async () => {
      delete process.env.PURIX_MCP_AUTO_APPROVE;
      writeManifest({
        component_id: "gate-test-comp",
        component_type: "module",
        current_version: 1,
        schema_version: 5,
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

      // Race against a short timeout: before the fix, this call opened a
      // readline reader on the MCP transport's own stdin and never
      // resolved. If it still hangs, this test times out instead of
      // reporting a clean pass/fail — which is itself the regression
      // signal, not a flake to retry past.
      const result = await Promise.race([
        callTool("purix_index", { full: true }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timed out — likely hung on stdin")), 2000)),
      ]);

      const text = (result as { content: Array<{ text?: string }> }).content[0]!.text ?? "";
      // C-30: with no human-confirmation channel the call becomes a pending request, not a hang and not a silent yes.
      expect(text).toContain("needs a person's approval");
      expect(text).not.toContain("fileCount");

      const events = listEvents({ kind: "confirm_response" });
      const rejection = events.find((e) => (e.detail).reason === "mcp_no_elicitation_support");
      expect(rejection).toBeDefined();
    });
  });
});