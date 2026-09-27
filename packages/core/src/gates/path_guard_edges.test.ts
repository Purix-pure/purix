// resolveSafePath()/findUnsafePaths() edge cases: empty input, traversal, root itself, and a real symlink escape.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSafePath, findUnsafePaths } from "./path_guard";

let root: string;
let outside: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "purix-guard-root-"));
  outside = mkdtempSync(join(tmpdir(), "purix-guard-outside-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("resolveSafePath", () => {
  it("rejects empty, blank and null paths", () => {
    expect(resolveSafePath(root, "")).toEqual({ ok: false, reason: "empty path" });
    expect(resolveSafePath(root, "   ").ok).toBe(false);
    expect(resolveSafePath(root, null as unknown as string).ok).toBe(false);
  });
  it("accepts the root itself, a new nested file, and an existing directory", () => {
    expect(resolveSafePath(root, ".").ok).toBe(true);
    expect(resolveSafePath(root, "a/b/new.ts").ok).toBe(true);
    mkdirSync(join(root, "src"));
    expect(resolveSafePath(root, "src").ok).toBe(true);
  });
  it("rejects lexical traversal out of the root", () => {
    const r = resolveSafePath(root, "../escape.ts");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("outside the target directory");
  });
  it("rejects a symlink inside the root that points outside it", { skip: process.platform === "win32" ? "needs symlink privileges" : false }, () => {
    symlinkSync(outside, join(root, "link"));
    const r = resolveSafePath(root, "link/file.ts");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("symlink");
  });
  it("accepts a symlink that stays inside the root", { skip: process.platform === "win32" ? "needs symlink privileges" : false }, () => {
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "alias"));
    expect(resolveSafePath(root, "alias/file.ts").ok).toBe(true);
  });
});

describe("findUnsafePaths", () => {
  it("returns only the offenders, with their reasons", () => {
    const bad = findUnsafePaths(root, ["ok.ts", "../no.ts", "sub/ok2.ts", ""]);
    expect(bad.map((b) => b.path)).toEqual(["../no.ts", ""]);
    expect(bad.every((b) => b.reason.length > 0)).toBe(true);
  });
});
