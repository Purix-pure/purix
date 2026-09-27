// src/gates/path_guard.test.ts
//
// This is the last line of defense against a path string from an
// untrusted source (ingested diff header, LLM-produced TopologyPlan,
// replayed snapshot) escaping the repo root. Fail-closed behavior here
// is a security boundary, not just correctness — tested accordingly.
import { describe, it } from "node:test";
import { expect } from "expect";
import { resolve, join } from "node:path";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolveSafePath, findUnsafePaths } from "./path_guard";
import { safeRmSync } from "../platform/fs_retry.js";

const ROOT = resolve("/repo/root");

describe("resolveSafePath", () => {
  it("accepts a simple relative path inside the target directory", () => {
    const result = resolveSafePath(ROOT, "src/file.ts");
    expect(result.ok).toBe(true);
    expect(result.resolved).toBe(resolve(ROOT, "src/file.ts"));
  });

  it("accepts a nested relative path", () => {
    const result = resolveSafePath(ROOT, "a/b/c/file.ts");
    expect(result.ok).toBe(true);
  });

  it("accepts the root directory itself (empty-ish '.' path)", () => {
    const result = resolveSafePath(ROOT, ".");
    expect(result.ok).toBe(true);
    expect(result.resolved).toBe(ROOT);
  });

  it("rejects a simple '../' traversal", () => {
    const result = resolveSafePath(ROOT, "../outside.ts");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/outside the target directory/);
  });

  it("rejects a deeply nested path that still climbs out via '../../..'", () => {
    const result = resolveSafePath(ROOT, "a/b/../../../etc/passwd");
    expect(result.ok).toBe(false);
  });

  it("rejects an absolute path pointing elsewhere", () => {
    const result = resolveSafePath(ROOT, "/etc/passwd");
    expect(result.ok).toBe(false);
  });

  it("rejects a sibling directory that merely shares a string prefix with root", () => {
    // "/repo/root" is a string-prefix of "/repo/root-evil/x" but not a real
    // path ancestor — the trailing-separator check in resolveSafePath
    // exists specifically to prevent this kind of prefix confusion.
    const result = resolveSafePath(ROOT, "../root-evil/x");
    expect(result.ok).toBe(false);
  });

  it("rejects an empty path", () => {
    const result = resolveSafePath(ROOT, "");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/empty path/);
  });

  it("rejects a whitespace-only path", () => {
    const result = resolveSafePath(ROOT, "   ");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/empty path/);
  });

  it("rejects a null path", () => {
    const result = resolveSafePath(ROOT, null as unknown as string);
    expect(result.ok).toBe(false);
  });

  it("does not include a resolved path on rejection", () => {
    const result = resolveSafePath(ROOT, "../escape.ts");
    expect(result.ok).toBe(false);
    expect(result.resolved).toBeUndefined();
  });
});

describe("findUnsafePaths", () => {
  it("returns an empty array when every path is safe", () => {
    const bad = findUnsafePaths(ROOT, ["a.ts", "b/c.ts"]);
    expect(bad).toEqual([]);
  });

  it("flags only the unsafe entries, preserving which ones", () => {
    const bad = findUnsafePaths(ROOT, ["a.ts", "../escape.ts", "b/c.ts", "/abs/path.ts"]);
    expect(bad.map((b) => b.path)).toEqual(["../escape.ts", "/abs/path.ts"]);
  });

  it("returns an empty array for an empty input list", () => {
    expect(findUnsafePaths(ROOT, [])).toEqual([]);
  });

  it("attaches a reason to every flagged entry", () => {
    const bad = findUnsafePaths(ROOT, ["../x.ts"]);
    expect(bad[0]?.reason).toBeTruthy();
  });
});

describe("resolveSafePath — symlink escape (GAPS-REPORT §2.6)", () => {
  let tmpRoot: string;

  const setup = () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "purix-path-guard-test-"));
  };
  const teardown = () => {
    safeRmSync(tmpRoot);
  };

  it("rejects a path through a component that is a symlink pointing outside targetDir", () => {
    setup();
    try {
      const outsideDir = mkdtempSync(join(tmpdir(), "purix-path-guard-outside-"));
      try {
        writeFileSync(join(outsideDir, "passwd"), "root:x:0:0::/root:/bin/bash\n");
        // Plant "shared -> outsideDir" inside the target directory, then
        // ask for a path lexically inside targetDir through that symlink.
        //
        // WINDOWS FIX: fs.symlinkSync() for a directory target needs
        // SeCreateSymbolicLinkPrivilege on Windows (admin elevation, or
        // Developer Mode enabled in Settings) — without it this throws
        // EPERM before the test's actual assertions ever run, which is
        // very likely why this test (and the one below) were reported
        // failing. Passing "junction" as the link type sidesteps that:
        // NTFS junctions don't require the privilege, both targets here
        // are already-absolute local directory paths (junctions can't
        // target files or relative/UNC paths, but both usages here are
        // directories with absolute paths, so that's not a constraint
        // issue), and findSymlinkEscape()'s realpathSync() call follows
        // a junction exactly the same way it follows a symlink — so this
        // still genuinely exercises the escape-detection logic, not a
        // weaker substitute for it. The "junction" argument is a no-op
        // on POSIX (real symlinks are used there regardless), so this is
        // safe cross-platform.
        symlinkSync(outsideDir, join(tmpRoot, "shared"), "junction");
        const result = resolveSafePath(tmpRoot, "shared/passwd");
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/symlink escape/);
        expect(result.resolved).toBeUndefined();
      } finally {
        safeRmSync(outsideDir);
      }
    } finally {
      teardown();
    }
  });

  it("accepts a symlink that stays inside targetDir", () => {
    setup();
    try {
      mkdirSync(join(tmpRoot, "real"));
      writeFileSync(join(tmpRoot, "real", "file.ts"), "export {};\n");
      // See the "junction" comment in the test above — same fix, same
      // reason.
      symlinkSync(join(tmpRoot, "real"), join(tmpRoot, "alias"), "junction");
      const result = resolveSafePath(tmpRoot, "alias/file.ts");
      expect(result.ok).toBe(true);
    } finally {
      teardown();
    }
  });

  it("accepts an ordinary path when targetDir doesn't exist on disk at all (no false positive from the symlink check)", () => {
    const result = resolveSafePath(resolve("/repo/does-not-exist"), "src/file.ts");
    expect(result.ok).toBe(true);
  });

  it("accepts a path in a real, existing directory with no symlinks involved", () => {
    setup();
    try {
      const result = resolveSafePath(tmpRoot, "a/b/file.ts");
      expect(result.ok).toBe(true);
    } finally {
      teardown();
    }
  });
});