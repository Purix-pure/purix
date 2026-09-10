// src/security/deps_audit.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkVersionPinning } from "./deps_audit";

describe("Dependency Pinning Audit", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "purix-depsaudit-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("flags caret and tilde ranges and allows exact pins", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        dependencies: {
          "lodash": "^4.17.21",
          "express": "~4.18.2",
          "zod": "3.22.4"
        }
      })
    );

    const findings = await checkVersionPinning(tmpDir);
    expect(findings.length).toBe(2);
    expect(findings.some((f) => f.name === "lodash" && f.reason.includes("caret"))).toBe(true);
    expect(findings.some((f) => f.name === "express" && f.reason.includes("tilde"))).toBe(true);
    expect(findings.some((f) => f.name === "zod")).toBe(false);
  });
});
