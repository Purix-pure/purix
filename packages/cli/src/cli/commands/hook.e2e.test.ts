// src/cli/commands/hook.e2e.test.ts
//
// The real CLI as a real child process, fed a real payload on stdin, the way an agent's hook runs it. Checks the exit code
// and the text the agent would see. (Real Claude Code and Cursor are NOT in this loop; see docs/HOOKS.md.)
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { writeManifest, closeDb } from "@purix/core/manifest/store";
import { safeRmSync } from "@purix/core/platform/fs_retry";

const require = createRequire(import.meta.url);
const tsx = pathToFileURL(require.resolve("tsx")).href; // Windows rejects a plain absolute path after --import
const CLI = join(import.meta.dirname, "..", "..", "cli.ts");

function purix(cwd: string, args: string[], input?: string) {
  const r = spawnSync(process.execPath, ["--import", tsx, CLI, ...args], { cwd, input, encoding: "utf-8", timeout: 60_000, env: { ...process.env, CLAUDE_PROJECT_DIR: "" } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("purix hook (child process)", () => {
  let root: string;
  let prev: string;
  beforeEach(() => {
    prev = process.cwd();
    root = realpathSync(mkdtempSync(join(tmpdir(), "purix-hook-e2e-")));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    process.chdir(root);
    writeManifest({
      component_id: "alpha", component_type: "module", current_version: 1, schema_version: 4, parts: { tools: [], config: {} }, files: ["src/a.ts"],
      depends_on: [], depended_on_by: [], version_history: [], verification_status: "pass", last_synced_hash: "h",
    } as never);
    closeDb();
  });
  afterEach(() => {
    closeDb();
    process.chdir(prev);
    safeRmSync(root);
  });

  test("a governed edit exits 2 with the reason on stderr; a free edit exits 0 with nothing printed", () => {
    const denied = purix(root, ["hook", "claude-code", "pre-tool-use"], JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(root, "src", "a.ts") }, cwd: root }));
    expect(denied.code).toBe(2);
    expect(denied.err).toContain("src/a.ts");
    const free = purix(root, ["hook", "claude-code", "pre-tool-use"], JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(root, "src", "new.ts") }, cwd: root }));
    expect(free.code).toBe(0);
    expect(free.out).toBe("");
  });
  test("garbage on stdin, and an unknown agent, both exit 2 (never 1, which Claude Code would read as 'carry on')", () => {
    expect(purix(root, ["hook", "claude-code", "pre-tool-use"], "garbage").code).toBe(2);
    expect(purix(root, ["hook", "nonesuch", "pre-tool-use"], "{}").code).toBe(2);
  });
  test("garbage on a Stop event exits 0 (a bug in the backstop must not trap the agent)", () => {
    expect(purix(root, ["hook", "claude-code", "stop"], "garbage").code).toBe(0);
  });
  test("the hook command is not advertised in --help; `purix hooks --help` works", () => {
    expect(purix(root, ["--help"]).out).not.toMatch(/^\s+hook\s/m);
    const h = purix(root, ["hooks", "--help"]);
    expect(h.code ?? 0).toBe(0);
    expect(h.out).toMatch(/install/);
  });
  test("a Gemini CLI / Antigravity / Codex hook call answers in its own style from the same engine", () => {
    const gem = purix(root, ["hook", "gemini", "pre-tool-use"], JSON.stringify({ tool_name: "write_file", tool_input: { file_path: "src/a.ts" }, cwd: root }));
    expect(gem.code).toBe(0);
    expect(JSON.parse(gem.out).decision).toBe("deny");
    const agy = purix(root, ["hook", "antigravity", "pre-tool-use"], JSON.stringify({ toolCall: { name: "list_dir", args: { DirectoryPath: root } }, workspacePaths: [root] }));
    expect(JSON.parse(agy.out)).toEqual({ decision: "allow" });
    const codex = purix(root, ["hook", "codex", "pre-tool-use"], JSON.stringify({ tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch" }, cwd: root }));
    expect(codex.code).toBe(2);
    expect(codex.err).toContain("src/a.ts");
  });
  test("`hooks install` with no agent installs only for agents already used here; with none, it says so and exits 1", () => {
    expect(purix(root, ["hooks", "install"]).code).toBe(1);
    mkdirSync(join(root, ".codex"));
    const r = purix(root, ["hooks", "install"]);
    expect(r.code ?? 0).toBe(0);
    expect(r.out).toContain("Codex");
    expect(r.out).toContain("/hooks");
    expect(existsSync(join(root, ".codex", "hooks.json"))).toBe(true);
    expect(existsSync(join(root, ".claude"))).toBe(false);
  });
  test("OpenCode install writes the owned plugin file; --user is refused for an agent without a user location", () => {
    expect(purix(root, ["hooks", "install", "opencode"]).code ?? 0).toBe(0);
    expect(existsSync(join(root, ".opencode", "plugins", "purix-guard.ts"))).toBe(true);
    expect(purix(root, ["hooks", "install", "codex", "--user"]).code).toBe(1);
  });
  test("hooks install -> status -> uninstall round trip on a real folder", () => {
    const inst = purix(root, ["hooks", "install", "claude-code"]);
    expect(inst.code ?? 0).toBe(0);
    const p = join(root, ".claude", "settings.local.json");
    expect(existsSync(p)).toBe(true);
    expect(JSON.parse(readFileSync(p, "utf-8")).hooks.PreToolUse[0].hooks[0].command).toContain("purix hook claude-code pre-tool-use");
    expect(purix(root, ["hooks", "status"]).out).toMatch(/Claude Code: config present/);
    purix(root, ["hooks", "uninstall", "claude-code"]);
    expect(purix(root, ["hooks", "status"]).out).toMatch(/Claude Code: not installed/);
  });
});
