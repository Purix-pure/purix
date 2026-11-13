// A2b-1 (research 11, D01 and D14), at the command line: what `purix hook` and a second mutating command do while another
// process holds the repository lock.
//
// Before: `hook` was not in READ_ONLY_COMMANDS, so every hook call ran reconcile and then took the repository lock. A busy lock
// threw out of the pre-action step, the process exited 1, and Claude Code reads exit 1 from a hook as "the hook failed, carry
// on": the edit went through. With 8 callers at once, 6 of 8 were let through. And the same pre-action step reconciled a live
// operation's journal row before the lock refused the command.
import { describe, it } from "node:test";
import { expect } from "expect";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRmSync } from "@purix/core/platform/fs_retry";
import { writeManifest, createPendingOperation, listPendingOperations, closeDb } from "@purix/core/manifest/store";
import { computeSyncHash } from "@purix/core/state/hash";

const require = createRequire(import.meta.url);
const tsxLoader = pathToFileURL(require.resolve("tsx")).href;
const CLI = join(import.meta.dirname, "cli.ts");
const BEFORE = "export const a = 1;\n";
const AFTER = "export const a = 2;\n";

function project(): { root: string; home: string; cleanup: () => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "purix-busy-lock-")));
  const home = `${root}-home`;
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), BEFORE);
  const prev = process.cwd();
  process.chdir(root);
  try {
    writeManifest({
      component_id: "alpha", component_type: "module", current_version: 1, schema_version: 4,
      parts: { tools: [], config: {} }, files: ["src/a.ts"], depends_on: [], depended_on_by: [], version_history: [],
      verification_status: "pass", last_synced_hash: computeSyncHash([{ path: "src/a.ts", content: BEFORE }]),
    } as never);
    closeDb();
  } finally {
    process.chdir(prev);
  }
  return { root, home, cleanup: () => { safeRmSync(root); safeRmSync(home); } };
}

/** A live process that holds the repository lock with a fresh heartbeat. */
function holdLock(root: string): ChildProcess {
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  const now = new Date().toISOString();
  mkdirSync(join(root, ".purix"), { recursive: true });
  writeFileSync(join(root, ".purix", "repo.lock"), JSON.stringify({ pid: holder.pid, timestamp: now, updatedAt: now, token: "live-operation" }));
  return holder;
}

const editPayload = (root: string) =>
  JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(root, "src", "a.ts"), old_string: "1", new_string: "2" }, cwd: root });

function runHook(root: string, home: string, payload: string = editPayload(root)): Promise<{ code: number | null; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--import", tsxLoader, CLI, "hook", "claude-code", "pre-tool-use"], { cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home } });
    let err = "";
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("close", (code) => resolve({ code, err }));
    p.stdin.end(payload);
  });
}

describe("purix hook while the repository lock is busy", { timeout: 120_000 }, () => {
  it("blocks an edit to a governed file (exit 2) when a live process holds the lock", async () => {
    const p = project();
    const holder = holdLock(p.root);
    try {
      const r = await runHook(p.root, p.home);
      expect({ code: r.code, why: r.err.slice(0, 300) }).toEqual({ code: 2, why: expect.stringContaining("src/a.ts") });
    } finally {
      holder.kill();
      p.cleanup();
    }
  });

  it("still allows an edit to a file Purix does not govern while a live process holds the lock (no false block)", async () => {
    const p = project();
    const holder = holdLock(p.root);
    try {
      writeFileSync(join(p.root, "src", "free.ts"), "export const f = 1;\n");
      const free = JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(p.root, "src", "free.ts"), old_string: "1", new_string: "2" }, cwd: p.root });
      const r = await runHook(p.root, p.home, free);
      // C5: not blocked (exit 0); stderr now only says the file is not governed.
      expect({ code: r.code, named: r.err.includes("src/free.ts") && /not governed by Purix/.test(r.err) }).toEqual({ code: 0, named: true });
    } finally {
      holder.kill();
      p.cleanup();
    }
  });

  it("blocks all of 8 simultaneous calls: none is let through", async () => {
    const p = project();
    try {
      const rs = await Promise.all(Array.from({ length: 8 }, () => runHook(p.root, p.home)));
      expect(rs.map((r) => r.code)).toEqual(Array(8).fill(2));
    } finally {
      p.cleanup();
    }
  });

  it("takes no lock and leaves none behind", async () => {
    const p = project();
    try {
      await runHook(p.root, p.home);
      expect(() => readFileSync(join(p.root, ".purix", "repo.lock"))).toThrow(/ENOENT/);
    } finally {
      p.cleanup();
    }
  });
});

describe("a second mutating command while a live operation holds the lock", { timeout: 120_000 }, () => {
  it("is refused by the lock without touching the live operation's journal row or files", () => {
    const p = project();
    const prev = process.cwd();
    process.chdir(p.root);
    let opId: string;
    try {
      opId = createPendingOperation({
        component_id: "alpha", operation: "modify", new_version: 2, contract_changed: false,
        before_snapshot: [{ path: "src/a.ts", content: BEFORE }], after_snapshot: [{ path: "src/a.ts", content: AFTER }],
      });
      closeDb();
    } finally {
      process.chdir(prev);
    }
    writeFileSync(join(p.root, "src", "a.ts"), AFTER); // the live operation's write has landed; its manifest commit has not
    const holder = holdLock(p.root);
    try {
      const r = spawnSync(process.execPath, ["--import", tsxLoader, CLI, "delete", "no-such-component"], {
        cwd: p.root, env: { ...process.env, HOME: p.home, USERPROFILE: p.home }, encoding: "utf8",
      });
      expect(r.stderr).toMatch(/already locked by active process/);
      expect(r.stderr).not.toMatch(/reconciling/);
      expect(readFileSync(join(p.root, "src", "a.ts"), "utf8")).toBe(AFTER);
      process.chdir(p.root);
      try {
        expect(listPendingOperations().map((o) => o.id)).toEqual([opId]);
      } finally {
        closeDb();
        process.chdir(prev);
      }
    } finally {
      holder.kill();
      p.cleanup();
    }
  });
});
