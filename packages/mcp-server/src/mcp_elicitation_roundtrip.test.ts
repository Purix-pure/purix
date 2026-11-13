// packages/mcp-server/src/mcp_elicitation_roundtrip.test.ts
//
// The same approval flow, but through a real MCP client and the real server over the SDK's
// in-memory transport, so the capability negotiation and the elicitation request itself are
// the SDK's, not a stand-in.
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createPurixMcpServer } from "./server";
import { closeDb } from "@purix/core/manifest/store";
import { decideApproval } from "@purix/core/approvals/pending";
import { safeRmSync } from "@purix/core/platform/fs_retry";

async function connect(withElicitation: boolean, answer: (message: string) => { action: "accept" | "decline" | "cancel"; content?: Record<string, boolean> }) {
  const server = createPurixMcpServer();
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: withElicitation ? { elicitation: { form: {} } } : {} });
  const asked: string[] = [];
  if (withElicitation) {
    client.setRequestHandler(ElicitRequestSchema, (req) => {
      asked.push(req.params.message);
      return answer(req.params.message);
    });
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, server, asked };
}

describe("approval through a real MCP client", () => {
  let tmpDir: string;
  let userDir: string;
  let oldCwd: string;
  let savedUserDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "purix-mcp-roundtrip-"));
    userDir = mkdtempSync(join(tmpdir(), "purix-mcp-roundtrip-user-"));
    savedUserDir = process.env.PURIX_USER_DIR;
    process.env.PURIX_USER_DIR = userDir;
    oldCwd = process.cwd();
    process.chdir(tmpDir);
    delete process.env.PURIX_MCP_AUTO_APPROVE;
  });

  afterEach(() => {
    closeDb();
    process.chdir(oldCwd);
    safeRmSync(tmpDir);
    safeRmSync(userDir);
    if (savedUserDir === undefined) delete process.env.PURIX_USER_DIR;
    else process.env.PURIX_USER_DIR = savedUserDir;
  });

  test("the server advertises its instructions and a tool-surface fingerprint", async () => {
    const { client, server } = await connect(false, () => ({ action: "decline" }));
    expect(client.getInstructions()).toContain("does not mean the code is correct or safe");
    const listed = await client.listTools();
    const meta = (listed as { _meta?: Record<string, unknown> })._meta;
    expect(String(meta?.["purix/tool_surface_fingerprint"])).toMatch(/^[0-9a-f]{16}$/);
    await client.close();
    await server.close();
  });

  test("a client that supports elicitation is asked, and a yes lets the action run", async () => {
    const { client, server, asked } = await connect(true, () => ({ action: "accept", content: { approve: true } }));
    const res = (await client.callTool({ name: "purix_index", arguments: { full: true } })) as { content: { text: string }[] };
    expect(asked.length).toBe(1);
    expect(asked[0]).toContain("full codebase re-index");
    expect(res.content[0]!.text).toContain("fileCount");
    await client.close();
    await server.close();
  });

  test("a no from the person stops the action", async () => {
    const { client, server } = await connect(true, () => ({ action: "decline" }));
    const res = (await client.callTool({ name: "purix_index", arguments: { full: true } })) as { content: { text: string }[] };
    expect(res.content[0]!.text).toContain("you declined it");
    expect(res.content[0]!.text).not.toContain("fileCount");
    await client.close();
    await server.close();
  });

  test("a client without elicitation gets a pending request; a person's approval lets one call through", async () => {
    const { client, server, asked } = await connect(false, () => ({ action: "accept", content: { approve: true } }));
    const first = (await client.callTool({ name: "purix_index", arguments: { full: true } })) as { content: { text: string }[] };
    expect(asked.length).toBe(0);
    expect(first.content[0]!.text).toContain("needs a person's approval");
    expect(first.content[0]!.text).not.toContain("fileCount");
    const id = /apr-[0-9a-f]{12}/.exec(first.content[0]!.text)![0];

    const stillPending = (await client.callTool({ name: "purix_approval_status", arguments: { id } })) as { content: { text: string }[] };
    expect(JSON.parse(stillPending.content[0]!.text).state).toBe("pending");

    expect(decideApproval(tmpDir, id, "approved").ok).toBe(true);
    const second = (await client.callTool({ name: "purix_index", arguments: { full: true } })) as { content: { text: string }[] };
    expect(second.content[0]!.text).toContain("fileCount");
    await client.close();
    await server.close();
  });
});
