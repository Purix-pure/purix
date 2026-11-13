// `purix connect`: naming the agents it can reach, OpenCode, shared config files, and what it does in a folder
// that has no agent files yet (IDEA-090).
import { describe, it } from "node:test";
import { expect } from "expect";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRmSync } from "@purix/core/platform/fs_retry";
import { connectAgent, planConnectTargets, resolveAgentId, supportedAgents } from "./connect_agent.js";

const require = createRequire(import.meta.url);
const tsxLoader = require.resolve("tsx");
const cliEntry = join(import.meta.dirname, "..", "..", "cli.ts");

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runCli(args: string[], cwd: string): { status: number | null; output: string } {
  const home = tmp("purix-conn-home-");
  const r = spawnSync(process.execPath, ["--import", pathToFileURL(tsxLoader).href, cliEntry, ...args], {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local") },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"], // no terminal: nothing can be asked
  });
  safeRmSync(home);
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

describe("supported agents", () => {
  it("includes OpenCode as a project-scoped agent", () => {
    const opencode = supportedAgents().find((a) => a.id === "opencode");
    expect(opencode).toBeDefined();
    expect(opencode?.displayName).toBe("OpenCode");
    expect(opencode?.scope).toBe("project");
  });

  it("every id it reports can be resolved back to itself", () => {
    for (const a of supportedAgents()) expect(resolveAgentId(a.id)).toBe(a.id);
  });
});

describe("resolveAgentId", () => {
  it("ignores case and spaces, and knows the names people actually type", () => {
    expect(resolveAgentId("OpenCode")).toBe("opencode");
    expect(resolveAgentId("open code")).toBe("opencode");
    expect(resolveAgentId("Claude")).toBe("claude-code");
    expect(resolveAgentId("claude code")).toBe("claude-code");
    expect(resolveAgentId("gemini")).toBe("gemini-cli");
    expect(resolveAgentId("copilot")).toBe("github-copilot-cli");
    expect(resolveAgentId("vs code")).toBe("vscode");
  });

  it("returns undefined for a name it does not know", () => {
    expect(resolveAgentId("nonsense")).toBeUndefined();
    expect(resolveAgentId("")).toBeUndefined();
  });
});

describe("planConnectTargets", () => {
  it("writes a shared config file once: Claude Code and Copilot CLI both use .mcp.json", () => {
    const plan = planConnectTargets(["claude-code", "github-copilot-cli", "cursor"], "/p");
    expect(plan.targets).toEqual(["claude-code", "cursor"]);
    expect(plan.sharedWith).toEqual([{ agent: "github-copilot-cli", covered: "claude-code" }]);
  });

  it("keeps agents that have their own file", () => {
    expect(planConnectTargets(["opencode", "cursor"], "/p")).toEqual({ targets: ["opencode", "cursor"], sharedWith: [] });
  });
});

describe("connecting OpenCode", () => {
  it("writes the local-server shape OpenCode expects", () => {
    const dir = tmp("purix-oc-");
    try {
      const { result } = connectAgent("opencode", dir, "opencode");
      expect(result.success).toBe(true);
      const written = JSON.parse(readFileSync(result.path, "utf8"));
      expect(written.mcp.purix.type).toBe("local");
      expect(Array.isArray(written.mcp.purix.command)).toBe(true);
      expect(written.mcp.purix.command).toContain("mcp-serve");
      expect(written.mcp.purix.environment.PURIX_MCP_AGENT_ID).toBe("opencode");
      expect(written.mcp.purix.enabled).toBe(true);
    } finally {
      safeRmSync(dir);
    }
  });

  it("merges into an existing opencode.json instead of creating a second file, and keeps what was there", () => {
    const dir = tmp("purix-oc-existing-");
    try {
      writeFileSync(
        join(dir, "opencode.json"),
        JSON.stringify({ $schema: "https://opencode.ai/config.json", model: "anthropic/claude-sonnet-4", mcp: { other: { type: "remote", url: "https://x.example/mcp" } } }),
      );
      const { result } = connectAgent("opencode", dir, "opencode");
      expect(result.success).toBe(true);
      expect(readdirSync(dir)).toEqual(["opencode.json"]);
      const merged = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
      expect(merged.model).toBe("anthropic/claude-sonnet-4");
      expect(merged.mcp.other.url).toBe("https://x.example/mcp");
      expect(merged.mcp.purix.type).toBe("local");
    } finally {
      safeRmSync(dir);
    }
  });

  it("keeps the comments in an opencode.jsonc", () => {
    const dir = tmp("purix-oc-jsonc-");
    try {
      writeFileSync(join(dir, "opencode.jsonc"), '{\n  // my model\n  "model": "x/y",\n  "mcp": {}\n}\n');
      const { result } = connectAgent("opencode", dir, "opencode");
      expect(result.success).toBe(true);
      expect(readFileSync(join(dir, "opencode.jsonc"), "utf8")).toContain("// my model");
    } finally {
      safeRmSync(dir);
    }
  });
});

describe("purix connect in a folder with no agent files", () => {
  it("--list names the agents (OpenCode among them), exits 0, and creates nothing", () => {
    const dir = tmp("purix-conn-list-");
    try {
      const r = runCli(["connect", "--list"], dir);
      expect(r.status).toBe(0);
      expect(r.output).toContain("opencode");
      expect(r.output).toContain("claude-code");
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      safeRmSync(dir);
    }
  });

  it("with no terminal it lists the choices, exits non-zero, and creates nothing", () => {
    const dir = tmp("purix-conn-empty-");
    try {
      const r = runCli(["connect"], dir);
      expect(r.status).toBe(1);
      expect(r.output).toContain("Nothing was connected");
      expect(r.output).toContain("purix connect opencode");
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      safeRmSync(dir);
    }
  });

  it("an unknown agent name fails with the list instead of an internal error", () => {
    const dir = tmp("purix-conn-bad-");
    try {
      const r = runCli(["connect", "nonsense"], dir);
      expect(r.status).toBe(1);
      expect(r.output).toContain('"nonsense" is not an agent Purix knows');
      expect(r.output).toContain("opencode");
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      safeRmSync(dir);
    }
  });

  it("`purix connect opencode` writes the agent's config and the instruction note, and no .purix folder", () => {
    const dir = tmp("purix-conn-oc-");
    try {
      const r = runCli(["connect", "opencode"], dir);
      expect(r.status).toBe(0);
      expect(r.output).toContain("Connected purix to OpenCode");
      expect(r.output).toContain("the Purix server starts and answers");
      expect(readdirSync(dir).sort()).toEqual(["AGENTS.md", "opencode.jsonc"]);
    } finally {
      safeRmSync(dir);
    }
  });

  it("--no-instructions and --no-verify leave only the agent's config and skip the server check", () => {
    const dir = tmp("purix-conn-quiet-");
    try {
      const r = runCli(["connect", "opencode", "--no-instructions", "--no-verify", "--no-hooks"], dir);
      expect(r.status).toBe(0);
      expect(r.output).not.toContain("the Purix server starts and answers");
      expect(readdirSync(dir)).toEqual(["opencode.jsonc"]);
    } finally {
      safeRmSync(dir);
    }
  });

  it("re-running connect keeps one instruction block and leaves the person's own text alone", () => {
    const dir = tmp("purix-conn-rerun-");
    try {
      writeFileSync(join(dir, "AGENTS.md"), "# My rules\n\nBe kind.\n");
      runCli(["connect", "opencode", "--no-verify"], dir);
      runCli(["connect", "opencode", "--no-verify"], dir);
      const text = readFileSync(join(dir, "AGENTS.md"), "utf-8");
      expect(text.startsWith("# My rules\n\nBe kind.\n")).toBe(true);
      expect(text.split("purix:begin").length - 1).toBe(1);
    } finally {
      safeRmSync(dir);
    }
  });

  it("--hooks installs the agent's hook without asking, and plain connect does not at a non-terminal", () => {
    const dir = tmp("purix-conn-hooks-");
    try {
      runCli(["connect", "opencode", "--no-verify"], dir);
      expect(existsSync(join(dir, ".opencode", "plugins", "purix-guard.ts"))).toBe(false);
      const r = runCli(["connect", "opencode", "--no-verify", "--hooks"], dir);
      expect(r.output).toContain("Installed the opencode hook");
      expect(existsSync(join(dir, ".opencode", "plugins", "purix-guard.ts"))).toBe(true);
    } finally {
      safeRmSync(dir);
    }
  });

  it("detects an agent already in use and connects that one, once, when two share a file", () => {
    const dir = tmp("purix-conn-shared-");
    try {
      writeFileSync(join(dir, ".mcp.json"), "{}");
      const r = runCli(["connect"], dir);
      expect(r.status).toBe(0);
      expect(r.output).toContain("Connected purix to Claude Code");
      expect(r.output).not.toContain("Connected purix to GitHub Copilot CLI");
      expect(r.output).toContain("reads the same config file");
      const written = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
      expect(written.mcpServers.purix.env.PURIX_MCP_AGENT_ID).toBe("claude-code");
    } finally {
      safeRmSync(dir);
    }
  });
});
