import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "path";
import { pythonProvider } from "./python";
import * as providerKit from "../provider-kit";
import { safeRmSync } from "../../platform/fs_retry.js";

describe("Python Provider Audit Regression", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "purix-python-audit-"));
    writeFileSync(join(tmpDir, "requirements.txt"), "flask==2.0.0");
  });

  afterEach(() => {
    safeRmSync(tmpDir);
  });

  it("auditDependencies handles non-zero exit code with vulnerabilities", async () => {
    // Mocking to return non-zero exit code but valid JSON
    const mockOutput = JSON.stringify({
      dependencies: [{
        name: "flask",
        vulns: [{ id: "GHSA-xxxx", fixed_in: "2.0.1" }]
      }]
    });
    
    // @ts-expect-error test-only monkeypatch of a readonly hook, not assignable without a cast
    providerKit.providerKitHooks.runIsolatedOrNotInstalled = () => ({
      exitCode: 1,
      stdout: mockOutput,
      stderr: ""
    });

    const result = await pythonProvider.auditDependencies(tmpDir);
    // Based on requirements, if exitCode is 1 and stdout has vulnerabilities, it should NOT return empty
    expect(result.vulnerabilities.length).toBeGreaterThan(0);
  });

  it("dependencyVulnScan detects a known-CVE dependency", async () => {
    // Mocking to return found vulnerability for urllib3
    const mockOutput = JSON.stringify({
      dependencies: [{
        name: "urllib3",
        version: "1.26.4",
        vulns: [{ id: "CVE-2021-33503", fixed_in: "1.26.5" }]
      }]
    });
    
    // @ts-expect-error test-only monkeypatch of a readonly hook, not assignable without a cast
    providerKit.providerKitHooks.runIsolatedOrNotInstalled = () => ({
      exitCode: 1,
      stdout: mockOutput,
      stderr: ""
    });

    const result = await pythonProvider.auditDependencies(tmpDir);
    expect(result.vulnerabilities.length).toBeGreaterThan(0);
    expect(result.vulnerabilities[0]?.module).toBe("urllib3");
  });
});
