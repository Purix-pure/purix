// packages/core/src/state/project_id.test.ts
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { getProjectId } from "./project_id";
import { createConfigStore } from "./config";
import { resolveSharedStateDir } from "./git_common_dir";
import { safeRmSync } from "../platform/fs_retry.js";
import { resolveTsxCommand } from "../test-support/real_node_modules.js";

const tsxCommand = resolveTsxCommand();

// Spawns a real, separate OS process (not an in-process simulation) that
// calls getProjectId(baseDir) exactly once and prints the result — see
// project_id_race_worker.ts for why this needs to be a real process
// rather than several in-process calls (in-process calls can't race on
// the unlocked check-then-act window the regression test below exists to
// catch).
function spawnProjectIdWorker(baseDir: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      tsxCommand[0]!,
      [...tsxCommand.slice(1), join(import.meta.dirname, "project_id_race_worker.ts"), baseDir],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      const line = stdout.trim();
      if (!line) return reject(new Error(`worker produced no output (exit ${code}). stderr: ${stderr}`));
      resolvePromise(line);
    });
  });
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "purix-projectid-test-"));
});

afterEach(() => {
  safeRmSync(dir);
});

function writeGitConfig(baseDir: string, content: string) {
  mkdirSync(join(baseDir, ".git"), { recursive: true });
  writeFileSync(join(baseDir, ".git", "config"), content);
}

// ADR-042: getProjectId now caches its no-remote-fallback UUID and reads
// the shareProjectId opt-in flag from the git-common-dir-resolved shared
// state dir (same place the budget/manifest DB lives), not baseDir
// directly — see project_id.ts's header comment. Tests must write through
// the SAME resolver the production code uses, and only after .git exists
// (resolveSharedStateDir's answer depends on finding .git in the first
// place) — writing straight to createConfigStore(baseDir) would silently
// land in the wrong file and the flag would look unset.
function setSharedConfigFlag(baseDir: string, key: string, value: boolean) {
  createConfigStore(resolveSharedStateDir(baseDir)).set(key, value);
}

describe("getProjectId", () => {
  test("derives a deterministic id from a remote URL in .git/config when sharing is opted in", () => {
    writeGitConfig(
      dir,
      `[remote "origin"]\n\turl = git@github.com:example/purix.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`
    );
    setSharedConfigFlag(dir, "purix.shareProjectId", true);
    const id1 = getProjectId(dir);
    const id2 = getProjectId(dir);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{64}$/); // sha256 hex digest
  });

  test("two different clones of the same remote are isolated by default (different IDs)", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "purix-projectid-test-"));
    try {
      const remoteConfig = `[remote "origin"]\n\turl = https://github.com/example/purix.git\n`;
      writeGitConfig(dir, remoteConfig);
      writeGitConfig(dir2, remoteConfig);
      expect(getProjectId(dir)).not.toBe(getProjectId(dir2));
    } finally {
      safeRmSync(dir2);
    }
  });

  test("two different clones share the same id when purix.shareProjectId is explicitly opted in", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "purix-projectid-test-"));
    try {
      const remoteConfig = `[remote "origin"]\n\turl = https://github.com/example/purix.git\n`;
      writeGitConfig(dir, remoteConfig);
      writeGitConfig(dir2, remoteConfig);
      setSharedConfigFlag(dir, "purix.shareProjectId", true);
      setSharedConfigFlag(dir2, "purix.shareProjectId", true);
      expect(getProjectId(dir)).toBe(getProjectId(dir2));
    } finally {
      safeRmSync(dir2);
    }
  });

  test("different remotes produce different ids when sharing is opted in", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "purix-projectid-test-"));
    try {
      writeGitConfig(dir, `[remote "origin"]\n\turl = git@github.com:a/one.git\n`);
      writeGitConfig(dir2, `[remote "origin"]\n\turl = git@github.com:b/two.git\n`);
      setSharedConfigFlag(dir, "purix.shareProjectId", true);
      setSharedConfigFlag(dir2, "purix.shareProjectId", true);
      expect(getProjectId(dir)).not.toBe(getProjectId(dir2));
    } finally {
      safeRmSync(dir2);
    }
  });

  test("no .git/config at all falls back to a persisted UUID", () => {
    const id1 = getProjectId(dir);
    const id2 = getProjectId(dir);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f-]{36}$/);
  });

  test(".git/config present but with no remote section also falls back to a UUID", () => {
    writeGitConfig(dir, `[core]\n\trepositoryformatversion = 0\n`);
    const id = getProjectId(dir);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("the fallback UUID is stable across calls (cached, not recomputed)", () => {
    const id1 = getProjectId(dir);
    const id2 = getProjectId(dir);
    const id3 = getProjectId(dir);
    expect(id1).toBe(id2);
    expect(id2).toBe(id3);
  });

  test("computed once means a later remote rename doesn't change an already-cached id", () => {
    writeGitConfig(dir, `[remote "origin"]\n\turl = git@github.com:a/one.git\n`);
    setSharedConfigFlag(dir, "purix.shareProjectId", true);
    const before = getProjectId(dir);
    // Simulate `git remote rename` / `git remote set-url` happening later —
    // getProjectId must not recompute from the new remote once cached.
    writeGitConfig(dir, `[remote "origin"]\n\turl = git@github.com:a/renamed.git\n`);
    const after = getProjectId(dir);
    expect(after).toBe(before);
  });

  test("two worktrees of the same repository share the same project id even with no remote (ADR-042)", () => {
    // The bug this test exists to catch: before the fix, each worktree's
    // no-remote UUID fallback was cached under its own working directory,
    // so two worktrees of ONE repo would silently mint two different
    // ids — and therefore two different rows in the shared budget ledger,
    // defeating the whole point of ADR-042's atomic ceiling check.
    const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, stdio: "pipe" });
    git(["init", "-q"], dir);
    git(["config", "user.email", "test@purix.local"], dir);
    git(["config", "user.name", "Purix Test"], dir);
    writeFileSync(join(dir, "seed.txt"), "x\n");
    git(["add", "seed.txt"], dir);
    git(["commit", "-q", "-m", "seed"], dir);

    const worktreeDir = mkdtempSync(join(tmpdir(), "purix-projectid-wt-"));
    safeRmSync(worktreeDir);
    try {
      git(["worktree", "add", "-q", "-b", "branch-x", worktreeDir], dir);
      // No remote configured anywhere — pure no-remote fallback path.
      expect(getProjectId(dir)).toBe(getProjectId(worktreeDir));
    } finally {
      try {
        git(["worktree", "remove", "--force", worktreeDir], dir);
      } catch { /* test cleanup — worktree may already be gone */ }
      safeRmSync(worktreeDir);
    }
  });

  test("ten real concurrent processes with no id cached yet all resolve to the SAME id", async () => {
    // Regression test for a real bug found investigating
    // llm/budget_worktree.test.ts's pre-existing flaky failure: getProjectId()
    // used to check its cache and, if empty, mint-and-persist a fresh id as
    // two separate unlocked-then-locked steps. Ten processes racing here
    // (no remote, nothing cached — pure no-remote fallback path) used to
    // each independently mint their OWN randomUUID() before observing any
    // other process's write, so several DIFFERENT ids were live at once —
    // confirmed directly via instrumented runs during that investigation
    // (two distinct repo_id values across ten racing budget-reservation
    // workers). That silently split one project's budget ledger into
    // multiple rows, each separately enforcing the full cost ceiling. Must
    // be a real multi-process race (see spawnProjectIdWorker) — sequential
    // in-process calls, as every other test in this file makes, can't
    // exercise the unlocked check-then-act window this test exists to catch.
    // This is a real race, not a guaranteed one: confirmed directly
    // against the pre-fix code, 10 concurrent workers landed inside the
    // empty-cache race window and got back more than one distinct id in
    // roughly 1 of 20 runs (2 of 40 measured here) — the window this test
    // targets is narrower than budget_worktree.test.ts's own concurrency
    // test (that worker does real SQL/table-creation work before racing;
    // this one is a few synchronous fs calls, so there's less time for
    // processes to overlap). A pass here on any single run isn't proof the
    // fix holds — the fix is trusted on the direct repo_id evidence from
    // this bug's investigation, and this test exists so a regression has
    // a real, if imperfect, chance of being caught by CI over time.
    const results = await Promise.all(Array.from({ length: 10 }, () => spawnProjectIdWorker(dir)));
    const distinctIds = new Set(results);
    expect(distinctIds.size).toBe(1);
    expect([...distinctIds][0]).toMatch(/^[0-9a-f-]{36}$/);
  });
});