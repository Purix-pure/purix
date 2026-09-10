// src/verify/tests_frameworks.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTestsWithQuarantine } from "./tests";

describe("verify/tests framework detection and execution", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "purix-fw-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fails closed with a specific error when no supported test framework is detected", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "unsupported-proj", dependencies: {} }));
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    const testFile = "src/foo.test.ts";
    writeFileSync(join(tmpDir, testFile), "console.log('not a framework');");

    const result = runTestsWithQuarantine("comp-1", [testFile], tmpDir);
    expect(result.status).toBe("fail");
    expect(result.reason).toMatch(/no supported test framework detected/);
  });
});
