// src/cli/commands/config.test.ts
//
// NOTE: this file is a duplicate of connect.test.ts's "connectAgent" suite
// (same tests, same describe block) — flagged separately, not something
// this pass changes beyond fixing the import so it doesn't crash the test
// run. Worth deciding whether to delete this file or give it real
// config.ts-specific tests of its own.
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectAgent } from "./connect_agent";
import { agents, getAgentTypes } from "add-mcp";

// add-mcp resolves each agent's global configPath from os.homedir() once,
// at module-evaluation time — so mutating process.env.HOME from inside a
// beforeEach (after add-mcp is already imported and evaluated) has no
// effect on it. There's no supported way to redirect that per-test within
// this process. The antigravity-global-fallback behavior is instead
// exercised in connect.global-fallback.test.ts, run as a separate child
// process spawned with HOME pre-set, so add-mcp never sees the real one.
describe("connectAgent", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "purix-connect-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("registers purix with Claude Code by writing a real project-scoped .mcp.json", () => {
    const { result } = connectAgent("claude-code", cwd, "claude-code");
    expect(result.success).toBe(true);
    expect(result.path).toBe(join(cwd, ".mcp.json"));

    const written = JSON.parse(readFileSync(result.path, "utf-8"));
    expect(written.mcpServers.purix).toEqual({
      command: "purix",
      args: ["mcp-serve"],
      env: { PURIX_MCP_AGENT_ID: "claude-code" },
    });
  });

  test("registers purix with Cursor by writing a real project-scoped .cursor/mcp.json", () => {
    const { result } = connectAgent("cursor", cwd, "cursor");
    expect(result.success).toBe(true);
    expect(existsSync(join(cwd, ".cursor", "mcp.json"))).toBe(true);

    const written = JSON.parse(readFileSync(result.path, "utf-8"));
    expect(written.mcpServers.purix.command).toBe("purix");
    expect(written.mcpServers.purix.args).toEqual(["mcp-serve"]);
  });

  test("registers purix with Codex by writing real project-scoped config.toml (TOML, not JSON)", () => {
    const { result } = connectAgent("codex", cwd, "codex");
    expect(result.success).toBe(true);

    const written = readFileSync(result.path, "utf-8");
    expect(written).toContain("[mcp_servers.purix]");
    expect(written).toContain('command = "purix"');
  });

  test("records the given agentId in PURIX_MCP_AGENT_ID, not a hardcoded value", () => {
    const { result } = connectAgent("claude-code", cwd, "my-custom-id");
    const written = JSON.parse(readFileSync(result.path, "utf-8"));
    expect(written.mcpServers.purix.env.PURIX_MCP_AGENT_ID).toBe("my-custom-id");
  });

  test("is idempotent — connecting twice still succeeds and leaves one entry", () => {
    connectAgent("claude-code", cwd, "claude-code");
    const second = connectAgent("claude-code", cwd, "claude-code");
    expect(second.result.success).toBe(true);

    const written = JSON.parse(readFileSync(second.result.path, "utf-8"));
    expect(Object.keys(written.mcpServers)).toEqual(["purix"]);
  });

  test("merges into an existing project config without dropping other entries", () => {
    const { result: firstPurix } = connectAgent("claude-code", cwd, "claude-code");
    expect(firstPurix.success).toBe(true);
    // A real second server, written the same way another tool would
    const before = JSON.parse(readFileSync(firstPurix.path, "utf-8"));
    before.mcpServers.other = { command: "other-tool" };
    writeFileSync(firstPurix.path, JSON.stringify(before, null, 2), "utf-8");

    const { result: afterReconnect } = connectAgent("claude-code", cwd, "claude-code");
    expect(afterReconnect.success).toBe(true);
    const after = JSON.parse(readFileSync(afterReconnect.path, "utf-8"));
    expect(after.mcpServers.other).toEqual({ command: "other-tool" });
    expect(after.mcpServers.purix).toBeDefined();
  });

  test("agents with no project-level config are identified correctly (fallback path covered in connect.global-fallback.test.ts)", () => {
    // The actual global-scope write for these agents can't be safely
    // exercised in this file — see the module comment above. This just
    // pins down which agents connectAgent's fallback branch applies to,
    // so a future add-mcp upgrade that changes this list is caught here
    // even though the write behavior is tested elsewhere.
    expect(agents["antigravity"]?.localConfigPath).toBeUndefined();
    expect(agents["claude-code"]?.localConfigPath).toBeDefined();
  });

  test("still prefers project scope for agents that support it, even with the fallback in place", () => {
    const { result } = connectAgent("claude-code", cwd, "claude-code");
    expect(result.success).toBe(true);
    expect(result.path).toBe(join(cwd, ".mcp.json"));
  });

  test("every add-mcp-known agent can be targeted without connect.ts crashing on an unknown type", () => {
    // Not asserting file contents per-agent (that's add-mcp's own test suite's
    // job) — just that connectAgent's thin wrapper passes every real agent
    // type through cleanly, since a future add-mcp release could add or
    // rename agents and this would catch a mismatch with our AgentType usage.
    for (const agentType of getAgentTypes()) {
      expect(() => connectAgent(agentType, cwd, agentType)).not.toThrow();
    }
  });
});