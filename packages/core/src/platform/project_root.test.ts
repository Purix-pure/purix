import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProjectRoot } from "./project_root.js";
import { safeRmSync } from "./fs_retry.js";

function scratch(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "purix-root-")));
}

describe("findProjectRoot (N-3)", () => {
  it("an existing .purix in an ancestor wins over the folder you are standing in", () => {
    const base = scratch();
    try {
      mkdirSync(join(base, "proj", ".purix"), { recursive: true });
      mkdirSync(join(base, "proj", "src", "components"), { recursive: true });
      assert.deepEqual(findProjectRoot(join(base, "proj", "src", "components"), join(base, "home")), { root: join(base, "proj"), by: "purix" });
    } finally { safeRmSync(base); }
  });

  it("with no Purix state the nearest .git decides", () => {
    const base = scratch();
    try {
      mkdirSync(join(base, "repo", ".git"), { recursive: true });
      mkdirSync(join(base, "repo", "a", "b"), { recursive: true });
      assert.deepEqual(findProjectRoot(join(base, "repo", "a", "b"), join(base, "home")), { root: join(base, "repo"), by: "git" });
    } finally { safeRmSync(base); }
  });

  it("a nested repository is its own project, but state in the outer project still wins", () => {
    const base = scratch();
    try {
      mkdirSync(join(base, "mono", ".git"), { recursive: true });
      mkdirSync(join(base, "mono", "svc", ".git"), { recursive: true });
      mkdirSync(join(base, "mono", "svc", "src"), { recursive: true });
      assert.equal(findProjectRoot(join(base, "mono", "svc", "src"), join(base, "home"))?.root, join(base, "mono", "svc"));
      mkdirSync(join(base, "mono", ".purix"));
      assert.equal(findProjectRoot(join(base, "mono", "svc", "src"), join(base, "home"))?.root, join(base, "mono"));
    } finally { safeRmSync(base); }
  });

  it("a .git file (worktree or submodule) counts", () => {
    const base = scratch();
    try {
      mkdirSync(join(base, "wt", "sub"), { recursive: true });
      writeFileSync(join(base, "wt", ".git"), "gitdir: /elsewhere\n");
      assert.equal(findProjectRoot(join(base, "wt", "sub"), join(base, "home"))?.root, join(base, "wt"));
    } finally { safeRmSync(base); }
  });

  it("the home folder is never a project: ~/.purix is the machine store, and a dotfiles repo is not a project", () => {
    const base = scratch();
    try {
      const home = join(base, "home");
      mkdirSync(join(home, ".purix"), { recursive: true });
      mkdirSync(join(home, ".git"));
      mkdirSync(join(home, "work", "thing"), { recursive: true });
      assert.equal(findProjectRoot(join(home, "work", "thing"), home), null);
      assert.equal(findProjectRoot(home, home), null);
    } finally { safeRmSync(base); }
  });

  it("returns null when nothing marks a project, so the caller keeps its folder", () => {
    const base = scratch();
    try {
      mkdirSync(join(base, "plain", "x"), { recursive: true });
      assert.equal(findProjectRoot(join(base, "plain", "x"), join(base, "home")), null);
    } finally { safeRmSync(base); }
  });
});
