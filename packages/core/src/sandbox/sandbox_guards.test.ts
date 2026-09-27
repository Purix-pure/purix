// verifyInSandbox() guard rails that run before any toolchain is involved, plus temp-root cleanup.
import { describe, it } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyInSandbox, cleanupSandboxTempRoots } from "./sandbox";

describe("verifyInSandbox — early guards", () => {
  it("blocks a patch that contains a secret, without creating any sandbox", () => {
    const dir = mkdtempSync(join(tmpdir(), "purix-sbx-"));
    try {
      const r = verifyInSandbox("c", [{ path: "src/a.ts", new_content: 'export const key = "AKIAIOSFODNN7EXAMPLE";\n' }], dir);
      expect(r.status).toBe("fail");
      if (r.status === "fail") expect(r.reason).toContain("Secrets/entropy scan blocked this patch");
      expect(r.idiomFindings).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cleanupSandboxTempRoots", () => {
  it("is safe to call repeatedly, including when nothing is open", () => {
    expect(() => cleanupSandboxTempRoots()).not.toThrow();
    expect(() => cleanupSandboxTempRoots()).not.toThrow();
  });
});
