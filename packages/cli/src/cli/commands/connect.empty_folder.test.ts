// src/cli/commands/connect.empty_folder.test.ts
//
// C-12 (PURIX-36): `purix connect <agent>` run as a real process in an EMPTY folder, with HOME pointed at a throwaway
// directory. This file is named in the plan so the same checks run on Windows and macOS as part of the normal suite
// (os-smoke runs the full package tests on both), not only on Linux. What it pins:
//  - exactly the agent's own config file and the instruction note are written, nothing else;
//  - no `.purix` folder appears in the project or in the person's home (connect never creates Purix state);
//  - the launcher written into the config is the one for THIS platform (`cmd /c purix mcp-serve` on win32);
//  - a run that connects nothing exits non-zero and leaves the folder empty;
//  - all of the above also hold in a folder whose name has spaces and non-ASCII characters.
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRmSync } from "@purix/core/platform/fs_retry";

const require = createRequire(import.meta.url);
const tsxLoader = pathToFileURL(require.resolve("tsx")).href;
const cliEntry = join(import.meta.dirname, "..", "..", "cli.ts");

let base: string;
let home: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "purix-connect-empty-"));
  home = mkdtempSync(join(tmpdir(), "purix-connect-empty-home-"));
});
afterEach(() => {
  safeRmSync(base);
  safeRmSync(home);
});

function emptyFolder(name: string): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function connect(cwd: string, args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local") };
  delete env.CI;
  delete env.PURIX_USER_DIR;
  const proc = spawnSync(process.execPath, ["--import", tsxLoader, cliEntry, "connect", ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 90_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: proc.status, out: `${proc.stdout}${proc.stderr}` };
}

const expectedLauncher = process.platform === "win32" ? { command: "cmd", args: ["/c", "purix", "mcp-serve"] } : { command: "purix", args: ["mcp-serve"] };

describe("purix connect in an empty folder", () => {
  for (const folder of ["plain", "name with spaces", "ünï-çødé 日本"]) {
    test(`claude-code in "${folder}": only the agent file and the note are written, no Purix state anywhere`, () => {
      const cwd = emptyFolder(folder);
      const r = connect(cwd, ["claude-code", "--no-hooks"]);
      expect(r.out).toContain("Connected purix to Claude Code");
      expect(r.status).toBe(0);
      expect(readdirSync(cwd).sort()).toEqual([".mcp.json", "CLAUDE.md"]);
      expect(existsSync(join(cwd, ".purix"))).toBe(false);
      expect(existsSync(join(home, ".purix"))).toBe(false);
      const written = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf-8"));
      expect(written.mcpServers.purix.command).toBe(expectedLauncher.command);
      expect(written.mcpServers.purix.args).toEqual(expectedLauncher.args);
      expect(written.mcpServers.purix.env.PURIX_MCP_AGENT_ID).toBe("claude-code");
    });
  }

  test("opencode: in a folder with neither file it creates opencode.jsonc (the add-mcp default), plus the AGENTS.md note, and no Purix state", () => {
    const cwd = emptyFolder("opencode");
    const r = connect(cwd, ["opencode", "--no-hooks", "--no-verify"]);
    expect(r.status).toBe(0);
    expect(readdirSync(cwd).sort()).toEqual(["AGENTS.md", "opencode.jsonc"]);
    expect(existsSync(join(home, ".purix"))).toBe(false);
  });

  test("opencode: with an existing opencode.json it adds to that file and a plain re-run keeps a chosen audit identity", () => {
    const cwd = emptyFolder("opencode-existing");
    writeFileSync(join(cwd, "opencode.json"), JSON.stringify({ model: "x/y" }));
    const first = connect(cwd, ["opencode", "--no-hooks", "--no-verify", "--agent-id", "my-opencode"]);
    expect(first.status).toBe(0);
    expect(readdirSync(cwd).sort()).toEqual(["AGENTS.md", "opencode.json"]);
    const second = connect(cwd, ["opencode", "--no-hooks", "--no-verify"]);
    expect(second.status).toBe(0);
    expect(second.out).toContain("Audit identity: my-opencode");
    const written = JSON.parse(readFileSync(join(cwd, "opencode.json"), "utf-8"));
    expect(written.mcp.purix.environment.PURIX_MCP_AGENT_ID).toBe("my-opencode");
    expect(written.model).toBe("x/y");
  });

  test("an agent Purix does not know exits 1, says so, and creates nothing", () => {
    const cwd = emptyFolder("unknown-agent");
    const r = connect(cwd, ["nonesuch-agent"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("is not an agent Purix knows how to connect to");
    expect(readdirSync(cwd)).toEqual([]);
    expect(existsSync(join(home, ".purix"))).toBe(false);
  });

  test("with nothing connectable and no terminal it exits 1 and the folder stays empty", () => {
    const cwd = emptyFolder("nothing");
    const r = connect(cwd, []);
    expect(r.status).toBe(1);
    expect(readdirSync(cwd)).toEqual([]);
    expect(existsSync(join(home, ".purix"))).toBe(false);
  });
});
