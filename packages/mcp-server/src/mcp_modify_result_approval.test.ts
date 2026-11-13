// packages/mcp-server/src/mcp_modify_result_approval.test.ts
//
// AI-09 (PURIX-33): over MCP a person approves the RESULT of purix_modify, and the approved call applies exactly
// that stored result with no further model call. The LLM provider is faked at fetch(); nothing touches a network.
// Tested on Linux against simulated payloads (a fake provider and a fake `tsc` that always exits 0).
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createPurixMcpServer, createToolCaller } from "./server";
import { buildModifyResult, parseModifyResultPayload, staleReason, sha256Hex, MAX_MODIFY_PAYLOAD_BYTES } from "./modify_result";
import { closeDb, writeManifest, readManifest } from "@purix/core/manifest/store";
import type { ManifestEntry } from "@purix/core/manifest/schema";
import { decideApproval, peekRequest, loadApprovalForReview } from "@purix/core/approvals/pending";
import { listEvents } from "@purix/core/manifest/events";
import { safeRmSync } from "@purix/core/platform/fs_retry";
import { acquireRepoLock, releaseRepoLock } from "@purix/core/state/repo_lock";

const ORIGINAL = "export const limit = 3;\nexport const name = \"billing\";\n";
const CHANGED = "export const limit = 5;\nexport const name = \"billing\";\n";
const ARGS = { componentId: "billing", instruction: "raise the limit to 5" };
const idOf = (text: string) => /apr-[0-9a-f]{12}/.exec(text)?.[0] ?? "";

const entry = (): ManifestEntry => ({
  component_id: "billing", component_type: "module", current_version: 1, schema_version: 3,
  parts: { tools: [], config: {} }, files: ["billing.ts"], depends_on: [], depended_on_by: [], version_history: [],
  verification_status: "pass", last_synced_hash: "abc", language: "typescript",
});

describe("purix_modify: approve the result, apply the stored result (AI-09)", () => {
  let tmpDir: string;
  let userDir: string;
  let oldCwd: string;
  let savedUserDir: string | undefined;
  let originalFetch: typeof fetch;
  let modelCalls: number;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "purix-mcp-result-"));
    userDir = mkdtempSync(join(tmpdir(), "purix-mcp-result-user-"));
    savedUserDir = process.env.PURIX_USER_DIR;
    process.env.PURIX_USER_DIR = userDir;
    oldCwd = process.cwd();
    process.chdir(tmpDir);
    // In production `purix mcp-serve` takes the repository lock before it serves anything (cli.ts pre-action step), and the writer
    // refuses to write without it (A3-1), so a test that applies a change holds it too.
    acquireRepoLock(tmpDir);
    delete process.env.PURIX_MCP_AUTO_APPROVE;
    process.env.PURIX_LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test_key";
    // Verification refuses a TypeScript change in a project with no compiler; a fake one that passes stands in.
    mkdirSync(join(tmpDir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(tmpDir, "node_modules", ".bin", "tsc"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(tmpDir, "node_modules", ".bin", "tsc.cmd"), "@echo off\r\nexit /b 0\r\n");
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ devDependencies: { "@types/node": "*" } }));
    writeFileSync(join(tmpDir, "billing.ts"), ORIGINAL);
    writeManifest(entry());
    modelCalls = 0;
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (!body) return new Response(JSON.stringify({ objects: [] }), { status: 200 });
      modelCalls++;
      const verdict = {
        operation: "update_config_value", contract_changing: false, confidence: 0.95, reasoning: "fixture",
        edits: [{ path: "billing.ts", kind: "config_value", key: "limit", old_value: "3", new_value: "5" }],
        suspicious_injected_instruction: false, is_new_capability: false,
      };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdict) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
    });
  });

  afterEach(() => {
    releaseRepoLock(tmpDir);
    closeDb();
    process.chdir(oldCwd);
    safeRmSync(tmpDir);
    safeRmSync(userDir);
    globalThis.fetch = originalFetch;
    if (savedUserDir === undefined) delete process.env.PURIX_USER_DIR;
    else process.env.PURIX_USER_DIR = savedUserDir;
    for (const k of ["PURIX_MCP_AUTO_APPROVE", "PURIX_LLM_PROVIDER", "OPENAI_API_KEY"]) delete process.env[k];
  });

  const disk = () => readFileSync(join(tmpDir, "billing.ts"), "utf-8");
  const noElicit = () => createToolCaller(() => Promise.resolve("unsupported"));

  test("(1) the first call does the work once, writes nothing, and returns a request id with the summary", async () => {
    const call = noElicit();
    const text = (await call("purix_modify", ARGS)).content[0]!.text;
    expect(modelCalls).toBe(1);
    expect(disk()).toBe(ORIGINAL);
    expect(readManifest("billing")?.current_version).toBe(1);
    const id = idOf(text);
    expect(id).not.toBe("");
    expect(text).toContain("needs a person's approval");
    expect(text).toContain("billing.ts (+1 / -1)");
    expect(text).toContain("TrustGate:");
    expect(text).toContain("Verification:");
    expect(text).toContain("Diff hash:");
    // What the person reads holds the diff itself.
    const record = loadApprovalForReview(tmpDir, id)!;
    expect(record.message).toContain("- export const limit = 3;");
    expect(record.message).toContain("+ export const limit = 5;");
  });

  test("(2) a second call while the request is pending makes no model call and files no second request", async () => {
    const call = noElicit();
    const first = idOf((await call("purix_modify", ARGS)).content[0]!.text);
    const callsAfterFirst = modelCalls;
    const again = (await call("purix_modify", ARGS)).content[0]!.text;
    expect(modelCalls).toBe(callsAfterFirst);
    expect(idOf(again)).toBe(first);
    expect(again).toContain("waiting for a person's approval");
    expect(disk()).toBe(ORIGINAL);
  });

  test("(3) after approval the applying call makes no model call, writes exactly the stored files, and the event carries the diff hash", async () => {
    const call = noElicit();
    const id = idOf((await call("purix_modify", ARGS)).content[0]!.text);
    const stored = loadApprovalForReview(tmpDir, id)!.payload as { diffHash: string };
    const callsBefore = modelCalls;
    expect(decideApproval(tmpDir, id, "approved").ok).toBe(true);

    const out = (await call("purix_modify", ARGS)).content[0]!.text;
    expect(modelCalls).toBe(callsBefore);
    expect(out).toContain("verified and committed");
    expect(disk()).toBe(CHANGED);
    expect(readManifest("billing")?.current_version).toBe(2);
    const ev = listEvents({ kind: "confirm_response" }).find((e) => e.detail.reason === "pending_request_consumed");
    expect(ev?.detail.request_id).toBe(id);
    expect(ev?.detail.diff_hash).toBe(stored.diffHash);
    expect(peekRequest(tmpDir, { tool: "purix_modify", checkpointKind: "mcp_modify", componentId: "billing", args: ARGS })).toBeNull();
  });

  test("(4) a denial returns the do-not-retry message and writes nothing", async () => {
    const call = noElicit();
    const id = idOf((await call("purix_modify", ARGS)).content[0]!.text);
    decideApproval(tmpDir, id, "denied");
    const callsBefore = modelCalls;
    const out = (await call("purix_modify", ARGS)).content[0]!.text;
    expect(out).toContain("denied");
    expect(out).toContain("Do not retry");
    expect(modelCalls).toBe(callsBefore);
    expect(disk()).toBe(ORIGINAL);
  });

  test("(5) a file edited between request and apply is refused with nothing written, and a fresh request can follow", async () => {
    const call = noElicit();
    const id = idOf((await call("purix_modify", ARGS)).content[0]!.text);
    decideApproval(tmpDir, id, "approved");
    const moved = `${ORIGINAL}// someone else edited this\n`;
    writeFileSync(join(tmpDir, "billing.ts"), moved);

    const out = (await call("purix_modify", ARGS)).content[0]!.text;
    expect(out).toContain("Refused");
    expect(out).toContain("billing.ts changed after the result was built");
    expect(disk()).toBe(moved);
    expect(readManifest("billing")?.current_version).toBe(1);
    expect(listEvents({ kind: "verification_failure" }).some((e) => e.detail.reason === "stored_result_stale")).toBe(true);

    // The approval was used up by the refusal, so starting over builds a new result for the moved file.
    const next = (await call("purix_modify", ARGS)).content[0]!.text;
    expect(idOf(next)).not.toBe("");
    expect(idOf(next)).not.toBe(id);
  });

  test("an approval does not cover a different instruction", async () => {
    const call = noElicit();
    const id = idOf((await call("purix_modify", ARGS)).content[0]!.text);
    decideApproval(tmpDir, id, "approved");
    const other = (await call("purix_modify", { componentId: "billing", instruction: "something else" })).content[0]!.text;
    expect(other).toContain("needs a person's approval");
    expect(disk()).toBe(ORIGINAL);
  });

  test("a result that fails verification files no request at all", async () => {
    writeFileSync(join(tmpDir, "node_modules", ".bin", "tsc"), "#!/bin/sh\necho 'billing.ts(1,1): error TS2322: bad'\nexit 1\n", { mode: 0o755 });
    // On Windows the project-local binary that gets run is the .cmd shim, so it has to fail too.
    writeFileSync(join(tmpDir, "node_modules", ".bin", "tsc.cmd"), "@echo off\r\necho billing.ts(1,1): error TS2322: bad\r\nexit /b 1\r\n");
    const out = (await noElicit()("purix_modify", ARGS)).content[0]!.text;
    expect(out).not.toContain("apr-");
    expect(disk()).toBe(ORIGINAL);
  });

  test("an oversized result is refused with a pointer to the CLI and files no request", async () => {
    const big = "x".repeat(MAX_MODIFY_PAYLOAD_BYTES);
    writeFileSync(join(tmpDir, "billing.ts"), `export const limit = 3;\n// ${big}\n`);
    const out = (await noElicit()("purix_modify", ARGS)).content[0]!.text;
    expect(out).toContain("too large to file for approval over MCP");
    expect(out).toContain("purix modify billing");
    expect(out).not.toContain("apr-");
  });

  test("PURIX_MCP_AUTO_APPROVE=1 still applies in one call and keeps its auto audit tag", async () => {
    process.env.PURIX_MCP_AUTO_APPROVE = "1";
    const out = (await noElicit()("purix_modify", ARGS)).content[0]!.text;
    expect(out).toContain("verified and committed");
    expect(disk()).toBe(CHANGED);
    const ev = listEvents({ kind: "confirm_response" }).find((e) => e.detail.reason === "mcp_auto_approve_session");
    expect(ev?.detail.auto_confirmed).toBe(true);
    expect(typeof ev?.detail.diff_hash).toBe("string");
  });

  test("dryRun still previews without filing a request", async () => {
    const out = (await noElicit()("purix_modify", { ...ARGS, dryRun: true })).content[0]!.text;
    expect(out).toContain("Dry run");
    expect(out).not.toContain("apr-");
    expect(disk()).toBe(ORIGINAL);
  });

  test("(6) a fake elicitation client: accept applies in the same call, decline writes nothing", async () => {
    const asked: string[] = [];
    const accepting = createToolCaller((m) => { asked.push(m); return Promise.resolve("accept"); });
    const done = (await accepting("purix_modify", ARGS)).content[0]!.text;
    expect(asked.length).toBe(1);
    expect(asked[0]).toContain("+ export const limit = 5;");
    expect(done).toContain("verified and committed");
    expect(disk()).toBe(CHANGED);
    const ev = listEvents({ kind: "confirm_response" }).find((e) => e.detail.reason === "mcp_elicitation_accepted");
    expect(typeof ev?.detail.diff_hash).toBe("string");

    writeFileSync(join(tmpDir, "billing.ts"), ORIGINAL);
    const e = entry();
    e.current_version = 2;
    writeManifest(e);
    const declining = createToolCaller(() => Promise.resolve("decline"));
    const refused = (await declining("purix_modify", { componentId: "billing", instruction: "raise the limit again" })).content[0]!.text;
    expect(refused).toContain("you declined it");
    expect(disk()).toBe(ORIGINAL);
  });

  test("(6) through a real MCP client with elicitation: the prompt shows the diff and accepting lands the change", async () => {
    const server = createPurixMcpServer();
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: { elicitation: { form: {} } } });
    const asked: string[] = [];
    client.setRequestHandler(ElicitRequestSchema, (req) => { asked.push(req.params.message); return { action: "accept", content: { approve: true } }; });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    const res = (await client.callTool({ name: "purix_modify", arguments: ARGS })) as { content: { text: string }[] };
    expect(asked[0]).toContain("Apply exactly this change");
    expect(res.content[0]!.text).toContain("verified and committed");
    expect(disk()).toBe(CHANGED);
    await client.close();
    await server.close();
  });

  test("purix_change reaches the same flow: the first call files a result, the second applies it", async () => {
    const call = noElicit();
    const first = (await call("purix_change", { intent: "raise the limit to 5 in billing", componentId: "billing" })).content[0]!.text;
    const id = idOf(first);
    expect(id).not.toBe("");
    expect(first).toContain("Target: billing");
    decideApproval(tmpDir, id, "approved");
    const calls = modelCalls;
    const second = (await call("purix_change", { intent: "raise the limit to 5 in billing", componentId: "billing" })).content[0]!.text;
    expect(second).toContain("verified and committed");
    expect(modelCalls).toBe(calls);
    expect(disk()).toBe(CHANGED);
  });
});

describe("modify_result helpers", () => {
  const input = (over: Partial<Parameters<typeof buildModifyResult>[0]> = {}) => ({
    agentId: "a", componentId: "billing", instruction: "i", baseVersion: 1, operation: "update_config_value",
    contractChanged: false, fromEscalation: false, isolation: "container" as string | undefined, notTested: ["x.ts"] as string[] | undefined, hasCoverage: true,
    decision: { action: "human_confirm" as const, reason: "r" },
    originalFiles: [{ path: "billing.ts", content: ORIGINAL }],
    finalFiles: [{ path: "billing.ts", new_content: CHANGED }],
    ...over,
  });

  test("the message cuts the diff at 120 lines and names the CLI for the rest; the payload keeps all of it", () => {
    const before = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const after = before.replace(/line/g, "LINE");
    const r = buildModifyResult(input({ originalFiles: [{ path: "billing.ts", content: before }], finalFiles: [{ path: "billing.ts", new_content: after }] }));
    expect(r.message).toContain('first 120 of');
    expect(r.message).toContain("purix approve --show");
    expect(r.message.split("\n").length).toBeLessThan(160);
    expect(r.payload.diff.split("\n").length).toBeGreaterThan(400);
    expect(r.payload.diffHash).toBe(sha256Hex(r.payload.diff));
  });

  test("what verification covered is stated, including isolation none, untested files and missing coverage", () => {
    const r = buildModifyResult(input({ isolation: "none", hasCoverage: false }));
    expect(r.summary).toContain("isolation: none");
    expect(r.summary).toContain("without sandbox containment");
    expect(r.summary).toContain("no test is related to x.ts");
    expect(r.summary).toContain("No test coverage was found");
    expect(buildModifyResult(input({ isolation: undefined, notTested: undefined })).summary).toContain("no sandbox result was recorded");
  });

  test("a new file is labelled and counted", () => {
    const r = buildModifyResult(input({ finalFiles: [{ path: "billing.ts", new_content: CHANGED }, { path: "extra.ts", new_content: "a\nb\n" }] }));
    expect(r.summary).toContain("extra.ts (new file, +2 / -0)");
  });

  test("parseModifyResultPayload rejects anything that is not the exact stored shape or whose diff hash is wrong", () => {
    const good = buildModifyResult(input()).payload;
    expect(parseModifyResultPayload(JSON.parse(JSON.stringify(good)))).not.toBeNull();
    expect(parseModifyResultPayload(null)).toBeNull();
    expect(parseModifyResultPayload({ ...good, diff: "tampered" })).toBeNull();
    expect(parseModifyResultPayload({ ...good, v: 2 })).toBeNull();
    expect(parseModifyResultPayload({ ...good, finalFiles: [] })).toBeNull();
    expect(parseModifyResultPayload({ ...good, decision: { action: "abort", reason: "x" } })).toBeNull();
  });

  test("staleReason: version, changed hash, missing file and a created path that now exists", () => {
    const p = buildModifyResult(input()).payload;
    const now = [{ path: "billing.ts", content: ORIGINAL }];
    expect(staleReason(p, 1, now, () => false)).toBeNull();
    expect(staleReason(p, 2, now, () => false)).toContain("now at v2");
    expect(staleReason(p, 1, [{ path: "billing.ts", content: "other" }], () => false)).toContain("changed after");
    expect(staleReason(p, 1, [], () => false)).toContain("no longer on disk");
    const created = buildModifyResult(input({ finalFiles: [{ path: "billing.ts", new_content: CHANGED }, { path: "new.ts", new_content: "x\n" }] })).payload;
    expect(staleReason(created, 1, now, (path) => path === "new.ts")).toContain("new.ts now exists");
  });
});
