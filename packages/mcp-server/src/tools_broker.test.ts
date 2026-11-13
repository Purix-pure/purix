// packages/mcp-server/src/tools_broker.test.ts
//
// ADR-060 D6: an agent can PLAN and can REQUEST an install; it cannot cause one. These tests drive the
// real MCP server in memory.
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPurixMcpServer, TOOL_METADATA } from "./server";
import { closeDb } from "@purix/core/manifest/store";
import { safeRmSync } from "@purix/core/platform/fs_retry";
import { pendingDir, toolDir } from "@purix/core/tools/state";

describe("MCP tools broker surface", () => {
  let tmpDir: string;
  let oldCwd: string;
  let client: Client;

  const call = async (name: string, args: Record<string, unknown>) => {
    try {
      const r: any = await client.callTool({ name, arguments: args });
      return { text: String(r.content?.[0]?.text ?? ""), isError: r.isError === true };
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), isError: true };
    }
  };

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "purix-mcp-tools-"));
    oldCwd = process.cwd();
    process.chdir(tmpDir);
    const server = createPurixMcpServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    client = new Client({ name: "t", version: "0" });
    await client.connect(ct);
  });

  afterEach(async () => {
    await client.close();
    closeDb();
    process.chdir(oldCwd);
    safeRmSync(tmpDir);
  });

  test("both tools are listed with annotations; plan is read-only, request is not destructive", async () => {
    const tools = (await client.listTools()).tools;
    const plan = tools.find((t) => t.name === "purix_tools_plan")!;
    const req = tools.find((t) => t.name === "purix_tools_request_install")!;
    expect(plan.annotations?.readOnlyHint).toBe(true);
    expect(req.annotations?.readOnlyHint).toBe(false);
    expect(req.annotations?.destructiveHint).toBe(false);
    expect(TOOL_METADATA.purix_tools?.title).toMatch(/catalog/i);
    expect(TOOL_METADATA.purix_tools?.openWorld).toBe(false);
  });

  test("purix_tools answers from the catalog, offline, tells an agent to ask (not install), and creates nothing", async () => {
    const r = await call("purix_tools", { purpose: "run tests" });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/Tools in the Purix catalog for "run tests"/);
    expect(r.text).toMatch(/purix_tools_request_install \(toolId: pytest\)/);
    expect(r.text).not.toMatch(/purix tools install/);
    expect(r.text).not.toMatch(/npm|UNVERIFIED/i);
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  test("purix_tools says so when nothing in the catalog fits", async () => {
    const r = await call("purix_tools", { purpose: "mypy" });
    expect(r.text).toMatch(/Nothing in the Purix catalog matches "mypy"/);
  });

  test("plan creates nothing in a folder with no Purix state, and says what is missing", async () => {
    const r = await call("purix_tools_plan", { languages: ["python"] });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/python\/lint: ruff@0\.8\.4 — missing/);
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  test("request_install records a pending request, installs nothing, and tells the agent a human must approve", async () => {
    const r = await call("purix_tools_request_install", { toolId: "ruff", reason: "need lint\u0000 for the change" });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/Nothing was installed/);
    const id = /req-[0-9a-f]{12}/.exec(r.text)![0];
    expect(r.text).toContain(`purix tools approve ${id}`);
    expect(existsSync(toolDir(tmpDir, "ruff"))).toBe(false);
    const pending = JSON.parse(readFileSync(join(pendingDir(tmpDir), `${id}.json`), "utf-8"));
    expect(pending).toMatchObject({ toolId: "ruff", origin: "agent", reason: "need lint for the change" });
  });

  test("an unknown tool name cannot be requested", async () => {
    const r = await call("purix_tools_request_install", { toolId: "left-pad" });
    expect(r.text).toMatch(/unknown-tool/);
    expect(existsSync(pendingDir(tmpDir))).toBe(false);
  });

  test("a path-like or oversized tool id is rejected before reaching the broker", async () => {
    expect((await call("purix_tools_request_install", { toolId: "../../etc" })).text).toMatch(/unknown-tool/);
    expect((await call("purix_tools_request_install", { toolId: "x".repeat(200) })).isError).toBe(true);
  });

  test("the server imports only the read-only and ask-only parts of the broker, and nothing from the human gate", () => {
    const src = readFileSync(fileURLToPath(new URL("./server.ts", import.meta.url)), "utf-8");
    const m = /import\s*\{([^}]*)\}\s*from\s*"@purix\/core\/tools\/broker"/.exec(src);
    expect(m).not.toBeNull();
    const imported = m![1]!.split(",").map((x) => x.trim()).filter(Boolean).sort();
    expect(imported).toEqual(["detectLanguages", "formatPurposeResult", "listCatalog", "planForLanguages", "requestInstall", "searchPurpose"]);
    expect(src).not.toMatch(/@purix\/core\/tools\/(consent|installer)/);
  });
});
