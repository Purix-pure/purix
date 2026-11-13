import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "path";
import { pythonProvider } from "./python";
import * as providerKit from "../provider-kit";
import { safeRmSync } from "../../platform/fs_retry.js";
import { placeFakeInstall } from "../../tools/test_helpers.js";

describe("Python Provider Audit Regression", () => {
  let tmpDir: string;
  const originalHook = providerKit.providerKitHooks.runIsolatedOrNotInstalled;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "purix-python-audit-"));
    writeFileSync(join(tmpDir, "requirements.txt"), "flask==2.0.0");
    placeFakeInstall(tmpDir, "pip-audit");
  });

  afterEach(() => {
    // test-only restore of the hook the tests above replace
    providerKit.providerKitHooks.runIsolatedOrNotInstalled = originalHook;
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

  // The shape below is a trimmed capture of real pip-audit 2.7.3 output (--vulnerability-service=pypi,
  // requests==2.19.0): vulns carry id, aliases, description and fix_versions. They have no url or
  // fixed_in field, which the old parser read, so every real finding came out as range "unknown".
  const REAL_SHAPE = JSON.stringify({
    dependencies: [
      { name: "idna", version: "2.7", vulns: [] },
      { name: "requests", version: "2.19.0", vulns: [{ id: "PYSEC-2018-28", aliases: ["GHSA-x84v-xcm2-53pg", "CVE-2018-18074"], description: "...", fix_versions: ["2.20.0"] }] },
    ],
    fixes: [],
  });

  function hook(res: { exitCode: number | null; stdout: string; stderr: string } | { status: "not_installed" }, calls?: string[][]) {
    // @ts-expect-error test-only monkeypatch of a readonly hook, not assignable without a cast
    providerKit.providerKitHooks.runIsolatedOrNotInstalled = (cmd: string[]) => { calls?.push(cmd); return res; };
  }

  it("a completed scan with findings reports ran:true and maps the real fields", async () => {
    hook({ exitCode: 1, stdout: REAL_SHAPE, stderr: "" });
    const r = await pythonProvider.auditDependencies(tmpDir);
    expect(r.ran).toBe(true);
    expect(r.vulnerabilities).toEqual([
      { module: "requests", severity: "high", title: "PYSEC-2018-28", url: "https://osv.dev/vulnerability/PYSEC-2018-28", range: "< 2.20.0" },
    ]);
  });

  it("a completed clean scan reports ran:true with no findings", async () => {
    hook({ exitCode: 0, stdout: JSON.stringify({ dependencies: [{ name: "idna", version: "3.7", vulns: [] }], fixes: [] }), stderr: "" });
    const r = await pythonProvider.auditDependencies(tmpDir);
    expect(r).toMatchObject({ ran: true, vulnerabilities: [] });
  });

  it("an unreachable vulnerability service (exit 1, empty stdout) is ran:false, never 'clean'", async () => {
    hook({ exitCode: 1, stdout: "", stderr: "pip_audit._service.interface.ServiceError" });
    const r = await pythonProvider.auditDependencies(tmpDir);
    expect(r.ran).toBe(false);
    expect(r.vulnerabilities).toEqual([]);
  });

  it("output that is not a pip-audit report is ran:false", async () => {
    for (const stdout of ["Traceback (most recent call last):", "{}", "[]", '{"dependencies": "x"}']) {
      hook({ exitCode: 0, stdout, stderr: "" });
      expect((await pythonProvider.auditDependencies(tmpDir)).ran).toBe(false);
    }
  });

  it("pip-audit not installed is ran:false", async () => {
    hook({ status: "not_installed" });
    expect((await pythonProvider.auditDependencies(tmpDir)).ran).toBe(false);
  });

  it("names the project's requirements file as the target (no target audits Purix's own tool venv)", async () => {
    const calls: string[][] = [];
    hook({ exitCode: 0, stdout: JSON.stringify({ dependencies: [], fixes: [] }), stderr: "" }, calls);
    await pythonProvider.auditDependencies(tmpDir);
    expect(calls).toHaveLength(1);
    const argv = calls[0]!;
    expect(argv.slice(argv.indexOf("-r"))).toEqual(["-r", "requirements.txt"]);
  });

  it("a project with no requirements.txt is ran:false and pip-audit is not run at all", async () => {
    const bare = mkdtempSync(join(tmpdir(), "purix-python-audit-bare-"));
    try {
      writeFileSync(join(bare, "pyproject.toml"), "[project]\nname = \"x\"\n");
      const calls: string[][] = [];
      hook({ exitCode: 0, stdout: "{}", stderr: "" }, calls);
      const r = await pythonProvider.auditDependencies(bare);
      expect(r.ran).toBe(false);
      expect(calls).toHaveLength(0);
    } finally { safeRmSync(bare); }
  });
});
