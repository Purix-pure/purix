// packages/core/src/state/project_id.test.ts
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { getProjectId } from "./project_id";
import { createConfigStore } from "./config";
import { resolveSharedStateDir } from "./git_common_dir";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "purix-projectid-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeGitConfig(baseDir: string, content: string) {
  mkdirSync(join(baseDir, ".git"), { recursive: true });
  writeFileSync(join(baseDir, ".git", "config"), content);
}

// ADR-041: getProjectId now caches its no-remote-fallback UUID and reads
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
      rmSync(dir2, { recursive: true, force: true });
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
      rmSync(dir2, { recursive: true, force: true });
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
      rmSync(dir2, { recursive: true, force: true });
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

  test("two worktrees of the same repository share the same project id even with no remote (ADR-041)", () => {
    // The bug this test exists to catch: before the fix, each worktree's
    // no-remote UUID fallback was cached under its own working directory,
    // so two worktrees of ONE repo would silently mint two different
    // ids — and therefore two different rows in the shared budget ledger,
    // defeating the whole point of ADR-041's atomic ceiling check.
    const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, stdio: "pipe" });
    git(["init", "-q"], dir);
    git(["config", "user.email", "test@purix.local"], dir);
    git(["config", "user.name", "Purix Test"], dir);
    writeFileSync(join(dir, "seed.txt"), "x\n");
    git(["add", "seed.txt"], dir);
    git(["commit", "-q", "-m", "seed"], dir);

    const worktreeDir = mkdtempSync(join(tmpdir(), "purix-projectid-wt-"));
    rmSync(worktreeDir, { recursive: true, force: true });
    try {
      git(["worktree", "add", "-q", "-b", "branch-x", worktreeDir], dir);
      // No remote configured anywhere — pure no-remote fallback path.
      expect(getProjectId(dir)).toBe(getProjectId(worktreeDir));
    } finally {
      try {
        git(["worktree", "remove", "--force", worktreeDir], dir);
      } catch {}
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  });
});