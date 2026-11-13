// src/cli/commands/connect.process.test.ts
//
// `purix connect` run as a real process, with HOME and the user folder pointed at throwaway directories. Same reason as
// connect.global-fallback.test.ts: add-mcp resolves each agent's per-user config path from os.homedir() when it is first
// imported, so HOME has to be set before the process starts. These cover what a person sees and what lands on disk:
//  - `--user` writes only the agent's per-user file (nothing in the project), and a second run reuses the recorded identity;
//  - two agents found in one folder: both connected, the server check printed once, hooks installed per agent;
//  - `connect` never leaves Purix state in the project or in the person's own ~/.purix.
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRmSync } from "@purix/core/platform/fs_retry";

const require = createRequire(import.meta.url);
const tsxLoader = pathToFileURL(require.resolve("tsx")).href;
const cliEntry = join(import.meta.dirname, "..", "..", "cli.ts");

let cwd: string;
let home: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "purix-connect-proc-project-"));
  home = mkdtempSync(join(tmpdir(), "purix-connect-proc-home-"));
});
afterEach(() => {
  safeRmSync(cwd);
  safeRmSync(home);
});

function connect(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CI;
  delete env.PURIX_USER_DIR;
  const proc = spawnSync(process.execPath, ["--import", tsxLoader, cliEntry, "connect", ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: proc.status, out: `${proc.stdout}${proc.stderr}` };
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("purix connect as a process", () => {
  test("--user writes the per-user config only; the project stays empty; a second run reuses the identity", () => {
    const first = connect(["claude-code", "--user", "--no-verify", "--no-hooks", "--agent-id", "my-claude"]);
    expect(first.status).toBe(0);
    expect(first.out).toContain("per-user config");
    expect(readdirSync(cwd)).toEqual([]);
    const file = join(home, ".claude.json");
    expect(existsSync(file)).toBe(true);
    const written = JSON.parse(readFileSync(file, "utf-8"));
    expect(written.mcpServers.purix.env.PURIX_MCP_AGENT_ID).toBe("my-claude");

    const second = connect(["claude-code", "--user", "--no-verify", "--no-hooks"]);
    expect(second.status).toBe(0);
    expect(second.out).toContain("Audit identity: my-claude");
    expect(readdirSync(cwd)).toEqual([]);
  });

  test("--user skips the project instruction note, because the connection applies to every project", () => {
    const r = connect(["claude-code", "--user", "--no-verify", "--no-hooks"]);
    expect(r.status).toBe(0);
    expect(r.out).not.toContain("how to use Purix");
    expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(false);
  });

  test("two agents in one folder: both connected, one server check, a hook per agent, no Purix state left behind", () => {
    mkdirSync(join(cwd, ".claude"));
    mkdirSync(join(cwd, ".cursor"));
    const r = connect(["--hooks"]);
    expect(r.status).toBe(0);
    expect(count(r.out, "✅ Connected purix to")).toBe(2);
    expect(r.out).toContain("Claude Code (claude-code)");
    expect(r.out).toContain("Cursor (cursor)");
    // The check runs once, after the loop, not once per agent.
    expect(count(r.out, "Checked on this machine")).toBe(1);
    expect(count(r.out, "✅ Installed the")).toBe(2);
    expect(existsSync(join(cwd, ".mcp.json"))).toBe(true);
    expect(existsSync(join(cwd, ".cursor", "mcp.json"))).toBe(true);
    expect(existsSync(join(cwd, ".claude", "settings.local.json"))).toBe(true);
    expect(existsSync(join(cwd, ".cursor", "hooks.json"))).toBe(true);
    // Nothing of Purix's own state: not in the project, and not in the person's home (the server check used to write a usage row there).
    expect(existsSync(join(cwd, ".purix"))).toBe(false);
    expect(existsSync(join(home, ".purix"))).toBe(false);
  });

  test("with no terminal and no flag it connects, installs no hook, and says how to add one", () => {
    mkdirSync(join(cwd, ".claude"));
    const r = connect(["--no-verify"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("Hooks are not installed");
    expect(existsSync(join(cwd, ".claude", "settings.local.json"))).toBe(false);
  });

  test("with nothing found and no terminal it exits 1, lists the agents, and creates nothing", () => {
    const r = connect([]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("No coding agent was found");
    expect(r.out).toContain("purix connect opencode");
    expect(readdirSync(cwd)).toEqual([]);
    expect(existsSync(join(home, ".purix"))).toBe(false);
  });
});
