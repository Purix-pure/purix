// src/cli/commands/connect.global-fallback.test.ts
//
// Exercises connectAgent's global-scope fallback (for agents like antigravity
// that have no project-level config format) as a real file write. This has
// to run in its own child process with HOME set before add-mcp is ever
// imported: add-mcp resolves each agent's global configPath from
// os.homedir() once, at module-evaluation time, so setting process.env.HOME
// from inside a running test (after add-mcp is already loaded) has no
// effect on it. See connect.test.ts for the rest of connectAgent's coverage.
import { describe, test } from "node:test";
import { expect } from "expect";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const tsxLoader = require.resolve("tsx");

describe("connectAgent global-scope fallback (child process, isolated HOME)", () => {
  test("registers purix globally for an agent with no project-level config (Antigravity)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "purix-connect-project-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "purix-connect-fakehome-"));
    try {
      const script = `
        import { connectAgent } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "connect_agent.ts")).href)};
        const { result } = connectAgent("antigravity", ${JSON.stringify(cwd)}, "antigravity");
        console.log(JSON.stringify(result));
      `;
      const scriptPath = join(fakeHome, "run.mts");
      require("node:fs").writeFileSync(scriptPath, script, "utf-8");

      const proc = spawnSync(
        process.execPath,
        ["--import", pathToFileURL(tsxLoader).href, scriptPath],
        {
          env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
          encoding: "utf8",
          timeout: 30_000,
        }
      );

      expect(proc.status).toBe(0);
      const result = JSON.parse(proc.stdout.trim().split("\n").pop()!);
      expect(result.success).toBe(true);
      // Written under fakeHome, not the project cwd — confirms this took
      // the global-scope branch, not a silently-failed local one.
      expect(result.path.startsWith(cwd)).toBe(false);
      expect(result.path.startsWith(fakeHome)).toBe(true);
      expect(existsSync(result.path)).toBe(true);

      const written = JSON.parse(readFileSync(result.path, "utf-8"));
      expect(written.mcpServers.purix.command).toBe("purix");
      expect(written.mcpServers.purix.args).toEqual(["mcp-serve"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});