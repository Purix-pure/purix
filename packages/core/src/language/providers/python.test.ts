import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "path";
import { pythonProvider } from "./python";

describe("Python Provider", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "purix-python-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detect() returns true with markers", () => {
    writeFileSync(join(tmpDir, "requirements.txt"), "");
    expect(pythonProvider.detect(tmpDir)).toBe(true);
  });

  it("detect() returns false without markers", () => {
    expect(pythonProvider.detect(tmpDir)).toBe(false);
  });

  it("verify() returns not_installed when binary missing", () => {
    writeFileSync(join(tmpDir, "requirements.txt"), "");
    // Simulate `providerKitHooks.runIsolatedOrNotInstalled` returning not_installed
    const mockRun = () => ({ status: "not_installed" });
    const res = pythonProvider.verify(["test.py"], tmpDir, mockRun as any);
    expect(res.status).toBe("not_installed");
  });

  it("getFingerprint() parses requirements.txt", async () => {
    writeFileSync(join(tmpDir, "requirements.txt"), "flask==2.0.0\nnumpy==1.21.0");
    const fingerprint = await pythonProvider.getFingerprint(tmpDir);
    expect(fingerprint).toEqual({ flask: "2.0.0", numpy: "1.21.0" });
  });

  it("testIntegrityChecker works", async () => {
    const before = [{ path: "test.py", content: "assert 1 == 1\nassert 2 == 2" }];
    const after = [{ path: "test.py", content: "assert 1 == 1" }];
    const checker = (await pythonProvider.getTestIntegrityChecker!())!;
    const res = checker.check(before, after);
    expect(res.flagged).toBe(true);
    expect(res.findings.length).toBe(1);
  });
});
