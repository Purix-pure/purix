import { describe, it } from "node:test";
import { expect } from "expect";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { purixTmpRoot } from "./layout.js";
import { resolveToolchainTmp } from "./toolchain_tmp.js";
import { safeRmSync } from "./fs_retry.js";

describe("disposable data lives under .purix/tmp", () => {
  it("creates .purix/tmp, self-ignoring and tagged as a cache dir", () => {
    const base = mkdtempSync(join(tmpdir(), "purix-layout-"));
    try {
      const dir = purixTmpRoot(base);
      expect(dir).toBe(join(base, ".purix", "tmp"));
      expect(readFileSync(join(dir, ".gitignore"), "utf-8")).toContain("\n*\n");
      expect(readFileSync(join(dir, "CACHEDIR.TAG"), "utf-8").startsWith("Signature: 8a477f597d28d172789f06886806bc55")).toBe(true);
    } finally { safeRmSync(base); }
  });
  it("toolchain dirs go inside it and never create a sibling .purix-tmp", () => {
    const base = mkdtempSync(join(tmpdir(), "purix-layout-"));
    try {
      const py = resolveToolchainTmp(base, "python");
      expect(py).toBe(join(base, ".purix", "tmp", "python"));
      expect(existsSync(join(base, ".purix-tmp"))).toBe(false);
    } finally { safeRmSync(base); }
  });
  it("does not overwrite an existing .gitignore the user edited", () => {
    const base = mkdtempSync(join(tmpdir(), "purix-layout-"));
    try {
      const dir = purixTmpRoot(base);
      
      writeFileSync(join(dir, ".gitignore"), "custom\n");
      purixTmpRoot(base);
      expect(readFileSync(join(dir, ".gitignore"), "utf-8")).toBe("custom\n");
    } finally { safeRmSync(base); }
  });
});
