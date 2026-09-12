import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "path";
import { typescriptProvider } from "./typescript";

describe("TypeScript Provider", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "purix-ts-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detect() returns true with tsconfig", () => {
    writeFileSync(join(tmpDir, "tsconfig.json"), "{}");
    expect(typescriptProvider.detect(tmpDir)).toBe(true);
  });

  it("detect() returns false without markers", () => {
    expect(typescriptProvider.detect(tmpDir)).toBe(false);
  });

  it("getFingerprint() parses package.json", async () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
        dependencies: { "lodash": "4.0.0" }
    }));
    const fingerprint = await typescriptProvider.getFingerprint(tmpDir);
    expect(fingerprint).toEqual({ "lodash": "4.0.0" });
  });

  it("testIntegrityChecker works", async () => {
    const before = [{ path: "test.test.ts", content: "expect(1).toBe(1);\nexpect(2).toBe(2);" }];
    const after = [{ path: "test.test.ts", content: "expect(1).toBe(1);" }];
    const checker = (await typescriptProvider.getTestIntegrityChecker!())!;
    const res = checker.check(before, after);
    expect(res.flagged).toBe(true);
    expect(res.findings.length).toBe(1);
  });

  it("verify() returns status", () => {
    writeFileSync(join(tmpDir, "tsconfig.json"), "{}");
    const res = typescriptProvider.verify(["test.ts"], tmpDir);
    expect(res.status).toBeDefined();
  });
});
