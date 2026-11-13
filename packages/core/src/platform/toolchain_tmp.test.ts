// src/platform/toolchain_tmp.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { existsSync, mkdtempSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRmSync } from "./fs_retry.js";
import { resolveToolchainTmp, toolchainPath, toolchainProbeCwd } from "./toolchain_tmp.js";
import { pythonPack } from "../language/providers/python.pack.js";

describe("toolchain lookups create nothing; only resolveToolchainTmp creates", () => {
  it("toolchainPath and toolchainProbeCwd leave an empty folder empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "purix-tc-"));
    try {
      const p = toolchainPath(dir, "python");
      expect(p).toBe(join(dir, ".purix", "tmp", "python"));
      // No toolchain folder yet: the probe runs from the OS temp dir, never inside the project.
      expect(toolchainProbeCwd(dir, "python")).toBe(tmpdir());
      expect(readdirSync(dir)).toEqual([]);
    } finally { safeRmSync(dir); }
  });

  it("the probe cwd is the toolchain folder once it exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "purix-tc-"));
    try {
      const created = resolveToolchainTmp(dir, "python");
      expect(existsSync(created)).toBe(true);
      expect(toolchainProbeCwd(dir, "python")).toBe(created);
    } finally { safeRmSync(dir); }
  });

  it("the Python pack's read-side check (checkRuntimePresent) creates nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "purix-tc-"));
    try {
      pythonPack.checkRuntimePresent(dir);
      expect(readdirSync(dir)).toEqual([]);
    } finally { safeRmSync(dir); }
  });
});
