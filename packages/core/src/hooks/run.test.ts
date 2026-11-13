// src/hooks/run.test.ts
//
// Tamper tests against a REAL store in a real temp project (no mocks of the store, the lock or the filesystem). Each test
// states the bypass it tries. A bypass that is known to pass is written as a test that says so, so the limit is on record.
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "./run";
import { writeManifest, closeDb, getDb } from "../manifest/store";
import { writeFileAtomic } from "../platform/atomic_write";
import { computeSyncHash } from "../state/hash";
import { existsSync } from "node:fs";
import { safeRmSync } from "../platform/fs_retry";
import type { ManifestEntry } from "../manifest/schema";

function entry(id: string, files: string[], type = "module"): ManifestEntry {
  return {
    component_id: id, component_type: type, current_version: 1, schema_version: 4,
    parts: { tools: [], config: {} }, files, depends_on: [], depended_on_by: [], version_history: [],
    verification_status: "pass", last_synced_hash: "h",
  } as unknown as ManifestEntry;
}

const edit = (root: string, tool: string, input: object) => JSON.stringify({ tool_name: tool, tool_input: input, cwd: root });
const bash = (root: string, command: string) => edit(root, "Bash", { command });
const pre = (payload: string) => runHook("claude-code", "pre-tool-use", payload);

describe("hook: tamper tests", () => {
  let root: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    root = realpathSync(mkdtempSync(join(tmpdir(), "purix-hook-")));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "src", "free.ts"), "export const f = 1;\n");
    process.chdir(root);
    const alpha = entry("alpha", ["src/a.ts"]);
    alpha.last_synced_hash = computeSyncHash([{ path: "src/a.ts", content: "export const a = 1;\n" }]);
    writeManifest(alpha);
    // The real index row carries no sync hash (see isLockable in governed_lock.ts), so it never reads as drift.
    const index = entry("purix-codebase-index", ["src/free.ts"], "codebase_index");
    index.last_synced_hash = null;
    writeManifest(index);
    closeDb();
  });
  afterEach(() => {
    closeDb();
    process.chdir(prevCwd);
    safeRmSync(root);
  });

  test("an Edit to a governed file is blocked, names the file and the component, and points at the Purix route", () => {
    const a = pre(edit(root, "Edit", { file_path: join(root, "src", "a.ts"), old_string: "1", new_string: "2" }));
    expect(a.exitCode).toBe(2);
    expect(a.stderr).toContain("src/a.ts");
    expect(a.stderr).toContain("alpha");
    expect(a.stderr).toContain("purix");
  });
  test("an edit to a file that is only indexed (not governed) is allowed", () => {
    expect(pre(edit(root, "Write", { file_path: join(root, "src", "free.ts"), content: "x" })).exitCode).toBe(0);
    expect(pre(edit(root, "Write", { file_path: join(root, "src", "brand-new.ts"), content: "x" })).exitCode).toBe(0);
  });
  test("a relative path and a ./ path are resolved the same way", () => {
    expect(pre(edit(root, "Edit", { file_path: "src/a.ts" })).exitCode).toBe(2);
    expect(pre(edit(root, "Edit", { file_path: "./src/../src/a.ts" })).exitCode).toBe(2);
  });
  test("MultiEdit that mixes a free file and a governed one is blocked as a whole", () => {
    const a = pre(edit(root, "MultiEdit", { file_path: "src/free.ts", edits: [{ file_path: "src/a.ts" }] }));
    expect(a.exitCode).toBe(2);
  });
  test("BYPASS TRIED: a symlink inside the project that points at a governed file is still blocked", (t) => {
    try { symlinkSync(join(root, "src", "a.ts"), join(root, "innocent.ts")); } catch { t.skip("symlinks not permitted here (Windows without developer mode)"); return; }
    expect(pre(edit(root, "Write", { file_path: "innocent.ts", content: "x" })).exitCode).toBe(2);
  });
  test("BYPASS TRIED: switching the hook off by editing the agent's config is blocked", () => {
    for (const p of [".claude/settings.json", ".claude/settings.local.json", ".cursor/hooks.json", "purix.lock.json"]) {
      const a = pre(edit(root, "Write", { file_path: p, content: "{}" }));
      expect(a.exitCode).toBe(2);
      expect(a.stderr).toContain("hook setup");
    }
  });
  test("BYPASS TRIED: editing Purix's own state through a write tool is blocked", () => {
    expect(pre(edit(root, "Write", { file_path: join(root, ".purix", "manifest.db"), content: "x" })).exitCode).toBe(2);
  });
  test("BYPASS TRIED: a shell redirect, sed -i, rm, mv, tee and a git checkout that name a governed file are blocked", () => {
    for (const c of ["echo x > src/a.ts", "echo x >> ./src/a.ts", "sed -i 's/1/2/' src/a.ts", "rm src/a.ts", "mv src/a.ts /tmp/z", "echo x | tee src/a.ts", "git checkout -- src/a.ts", "Set-Content src/a.ts 'x'", "python3 -c \"open('src/a.ts','w').write('x')\" src/a.ts"]) {
      expect(`${c} => ${bash(root, c) && pre(bash(root, c)).exitCode}`).toBe(`${c} => 2`);
    }
  });
  test("BYPASS TRIED: a glob, a parent directory and the project root cannot be used to reach a governed file", () => {
    for (const c of ["rm src/*.ts", "rm -rf src", "rm -rf .", "echo x > src/a*"]) {
      expect(`${c} => ${pre(bash(root, c)).exitCode}`).toBe(`${c} => 2`);
    }
  });
  test("BYPASS TRIED: chaining a Purix command with a write does not launder the write", () => {
    expect(pre(bash(root, "purix check && rm src/a.ts")).exitCode).toBe(2);
  });
  test("a Purix command itself, and read-only shell commands on a governed file, are allowed", () => {
    expect(pre(bash(root, "purix change \"rename a in src/a.ts\"")).exitCode).toBe(0);
    expect(pre(bash(root, "npx purix check")).exitCode).toBe(0);
    expect(pre(bash(root, "cat src/a.ts")).exitCode).toBe(0);
    expect(pre(bash(root, "grep -n export src/a.ts")).exitCode).toBe(0);
    expect(pre(bash(root, "ls src && pnpm test")).exitCode).toBe(0);
    expect(pre(bash(root, "echo hi > /dev/null")).exitCode).toBe(0);
  });
  test("A9-1: MCP config, git hooks and skills folders are protected from write tools and from the shell", () => {
    for (const f of [".mcp.json", ".vscode/settings.json", ".git/hooks/pre-commit", ".claude/skills/x/SKILL.md", ".claude/commands/x.md"]) {
      expect(`${f} => ${pre(edit(root, "Write", { file_path: join(root, f), content: "x" })).exitCode}`).toBe(`${f} => 2`);
    }
    expect(pre(bash(root, "echo x > .git/hooks/pre-commit")).exitCode).toBe(2);
    expect(pre(bash(root, "python3 -c \"open('.mcp.json','w')\"")).exitCode).toBe(2);
  });
  test("A9-1: a path set in a variable earlier in the same command is resolved (this was a KNOWN LIMIT before; it now blocks)", () => {
    expect(pre(bash(root, "f=src/a; echo x > $f.ts")).exitCode).toBe(2);
  });
  test("KNOWN LIMIT (stated, not hidden): a script written first and run later, and an encoded string piped to a shell, pass the screen", () => {
    expect(pre(bash(root, "python3 fix.py")).exitCode).toBe(0);
    expect(pre(bash(root, "echo ZWNobyB4ID4gc3JjL2EudHM= | base64 -d | sh")).exitCode).toBe(0);
  });
  test("FAIL CLOSED: unreadable payload, no tool, and a write tool with no readable path are all blocked", () => {
    expect(pre("not json").exitCode).toBe(2);
    expect(pre("{}").exitCode).toBe(2);
    expect(pre(edit(root, "Write", { weird_key: "src/free.ts" })).exitCode).toBe(2);
  });
  test("FAIL CLOSED: a damaged store with no lock blocks every write; a damaged store WITH a lock still enforces the lock's files", () => {
    closeDb();
    writeFileSync(join(root, ".purix", "manifest.db"), "this is not a database");
    const a = pre(edit(root, "Write", { file_path: "src/free.ts", content: "x" }));
    expect(a.exitCode).toBe(2);
    expect(a.stderr).toContain("unreadable");
    writeFileAtomic(join(root, "purix.lock.json"), JSON.stringify({ schema: 1, components: [{ component_id: "alpha", version: 1, last_synced_hash: "h", files: [{ path: "src/a.ts", sha256: "x" }] }] }));
    expect(pre(edit(root, "Write", { file_path: "src/a.ts", content: "x" })).exitCode).toBe(2);
    expect(pre(edit(root, "Write", { file_path: "src/free.ts", content: "x" })).exitCode).toBe(0);
  });
  test("a project with no store and no lock governs nothing: edits are allowed, config files are still protected", () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "purix-hook-bare-")));
    // The project root is found by walking up to the nearest .git, lock or .purix. A temp folder can sit under a home
    // folder that has its own .purix (it does on a Windows machine that uses Purix), so mark this folder as the root.
    mkdirSync(join(bare, ".git"));
    try {
      process.chdir(bare);
      expect(runHook("claude-code", "pre-tool-use", edit(bare, "Write", { file_path: "x.ts", content: "x" })).exitCode).toBe(0);
      expect(runHook("claude-code", "pre-tool-use", edit(bare, "Write", { file_path: ".claude/settings.json", content: "{}" })).exitCode).toBe(2);
      // The hook is read-only: it did not create a store, a state folder or anything else in the project.
      expect(existsSync(join(bare, ".purix"))).toBe(false);
    } finally {
      process.chdir(root);
      safeRmSync(bare);
    }
  });
  test("a denied call leaves a hook_denied event in the store", () => {
    pre(edit(root, "Edit", { file_path: "src/a.ts" }));
    const rows = getDb().prepare("SELECT kind, detail FROM events WHERE kind = 'hook_denied'").all() as { kind: string; detail: string }[];
    closeDb();
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0]!.detail)).toMatchObject({ agent: "claude-code", rule: "governed-file", targets: ["src/a.ts"] });
  });
  test("Cursor: the same governed edit is denied with a permission:deny body and exit 2; a free edit says nothing", () => {
    const denied = runHook("cursor", "pre-tool-use", JSON.stringify({ tool_name: "StrReplace", tool_input: { path: "src/a.ts" }, workspace_roots: [root] }));
    expect(denied.exitCode).toBe(2);
    expect(JSON.parse(denied.stdout).permission).toBe("deny");
    const shell = runHook("cursor", "pre-tool-use", JSON.stringify({ command: "rm src/a.ts", cwd: root, workspace_roots: [root] }));
    expect(shell.exitCode).toBe(2);
    const free = runHook("cursor", "pre-tool-use", JSON.stringify({ tool_name: "Write", tool_input: { path: "src/free.ts" }, workspace_roots: [root] }));
    // C5: still no objection and no stdout (so nothing can read as a grant); stderr now says the file is not governed.
    expect(free.exitCode).toBe(0);
    expect(free.stdout).toBe("");
    expect(free.stderr).toContain("src/free.ts");
    expect(free.stderr).toMatch(/not governed by Purix/);
  });
  test("Stop: a clean tree is silent; a governed file changed behind Purix's back is reported (exit 2); the loop guard lets the second Stop through", () => {
    const stop = (active: boolean) => runHook("claude-code", "stop", JSON.stringify({ cwd: root, stop_hook_active: active }));
    expect(stop(false)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    // A shell edit the screen missed (the known limit above): change the governed file directly.
    writeFileSync(join(root, "src", "a.ts"), "export const a = 999;\n");
    const first = stop(false);
    expect(first.exitCode).toBe(2);
    expect(first.stderr).toContain("alpha");
    expect(stop(true).exitCode).toBe(0);
  });
});
