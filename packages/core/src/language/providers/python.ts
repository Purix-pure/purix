// packages/core/src/language/providers/python.ts
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LanguageProvider } from "../provider.js";
import type { VerificationResult } from "../../verify/verify.js";
import type { TestRunResult } from "../../verify/tests.js";
import type { IdiomCheckResult, IdiomFinding } from "../../verify/idiom.js";
import type { PinningFinding, VulnFinding } from "../../security/deps_audit.js";
import { parseLockfileFingerprint, providerKitHooks, runIsolatedOrNotInstalled } from "../provider-kit.js";
import type { TestIntegrityChecker } from "../../verify/test_integrity.js";
import { resolveToolchainTmp, toolchainSubdir } from "../../platform/toolchain_tmp.js";

function getVenvBinPath(baseDir: string, binName: string): string {
  const isWin = process.platform === "win32";
  const venvDir = toolchainSubdir(baseDir, "python", "venv");
  const binDir = isWin ? resolve(venvDir, "Scripts") : resolve(venvDir, "bin");
  const nameWithExe = isWin ? `${binName}.exe` : binName;
  const path = resolve(binDir, nameWithExe);
  if (existsSync(path)) return path;
  
  const pathPlain = resolve(binDir, binName);
  if (existsSync(pathPlain)) return pathPlain;
  
  return binName;
}

function checkToolAvailable(baseDir: string, binName: string): boolean {
  const isWin = process.platform === "win32";
  const venvDir = toolchainSubdir(baseDir, "python", "venv");
  const binDir = isWin ? resolve(venvDir, "Scripts") : resolve(venvDir, "bin");
  const localBin = resolve(binDir, isWin ? `${binName}.exe` : binName);
  if (existsSync(localBin)) return true;
  const localBinPlain = resolve(binDir, binName);
  if (existsSync(localBinPlain)) return true;
  // Fallback probe uses a bare command name (e.g. "pyright"), not a resolved
  // venv path. On Windows, invoking a bare Python-ecosystem command with no
  // matching interpreter/tool on PATH can trigger the py launcher / pymanager
  // shim to self-install a runtime into cwd. Pin cwd to .purix-tmp/python/
  // instead of baseDir so that self-install (if it happens) can't land in
  // source (see python.pack.ts for the same fix on the install path).
  const toolchainDir = resolveToolchainTmp(baseDir, "python");
  const res = providerKitHooks.runIsolatedOrNotInstalled([binName, "--version"], { cwd: toolchainDir, writableDir: toolchainDir });
  return !("status" in res) && res.exitCode === 0;
}

export const pythonProvider: LanguageProvider = {
  id: "python",
  minSupportedVersion: "3.10.0",

  async getTestIntegrityChecker(): Promise<TestIntegrityChecker> {
    const { pythonTestIntegrityChecker } = await import("../../verify/python_test_integrity.js");
    return pythonTestIntegrityChecker;
  },

  detect(baseDir: string = process.cwd()): boolean {
    return (
      existsSync(resolve(baseDir, "pyproject.toml")) ||
      existsSync(resolve(baseDir, "requirements.txt")) ||
      existsSync(resolve(baseDir, "setup.py"))
    );
  },

  verify(filePaths: string[], baseDir: string = process.cwd(), runFn = runIsolatedOrNotInstalled): VerificationResult {
    if (filePaths.length === 0) {
      return { status: "fail", reason: "No files to verify" };
    }
    if (!checkToolAvailable(baseDir, "pyright")) {
      return {
        status: "not_installed",
        reason: "Python tooling (pyright) not installed",
        actionHint: "run `purix lang install python`",
      };
    }
    const pyrightBin = getVenvBinPath(baseDir, "pyright");
    const result = runFn([pyrightBin, ...filePaths], { cwd: baseDir, writableDir: baseDir });

    if ("status" in result) {
      return {
        status: "not_installed",
        reason: "Python tooling (pyright) not installed or failed to spawn",
        actionHint: "run `purix lang install python`",
      };
    }
    if (result.exitCode === 0) return { status: "pass" };
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    return { status: "fail", reason: stderr || stdout || "pyright verification failed" };
  },

  runTests(componentId: string, testFiles: string[], baseDir: string = process.cwd()): TestRunResult {
    if (!checkToolAvailable(baseDir, "pytest")) {
      return {
        status: "not_installed",
        reason: "Python tooling (pytest) not installed",
        actionHint: "run `purix lang install python`",
        quarantinedFailures: [],
      };
    }
    const pytestBin = getVenvBinPath(baseDir, "pytest");
    const targetFiles = testFiles.length > 0 ? testFiles : ["tests"];
    const result = providerKitHooks.runIsolatedOrNotInstalled([pytestBin, ...targetFiles], { cwd: baseDir, writableDir: baseDir });

    if ("status" in result) {
      return {
        status: "not_installed",
        reason: "Python tooling (pytest) not installed or failed to spawn",
        actionHint: "run `purix lang install python`",
        quarantinedFailures: [],
      };
    }
    if (result.exitCode === 0) {
      return { status: "pass", quarantinedFailures: [] };
    }
    const stdout = result.stdout.trim();
    const stderr = result.stderr.trim();
    return {
      status: "fail",
      reason: stderr || stdout || "pytest test run failed",
      quarantinedFailures: [],
    };
  },

  checkIdiom(filePaths: string[], baseDir: string = process.cwd()): IdiomCheckResult {
    if (!checkToolAvailable(baseDir, "ruff")) {
      return {
        findings: [],
        ran: false,
        status: "not_installed",
        reason: "Python tooling (ruff) not installed",
        actionHint: "run `purix lang install python`",
      };
    }
    const ruffBin = getVenvBinPath(baseDir, "ruff");
    const result = providerKitHooks.runIsolatedOrNotInstalled([ruffBin, "check", "--output-format=json", ...filePaths], {
        cwd: baseDir,
        writableDir: baseDir,
        env: { RUFF_CACHE_DIR: toolchainSubdir(baseDir, "python", "ruff_cache") }
    });

    if ("status" in result) {
      return {
        findings: [],
        ran: false,
        status: "not_installed",
        reason: "Python tooling (ruff) not installed or failed to spawn",
        actionHint: "run `purix lang install python`",
      };
    }

    if (result.exitCode !== 0 && result.exitCode !== 1) {
      return { findings: [], ran: false };
    }

    try {
      const parsed = JSON.parse(result.stdout);
      const findings: IdiomFinding[] = parsed.map((item: any) => ({
        path: item.filename,
        line: item.location?.row ?? 0,
        rule: item.code ?? "unknown",
        message: item.message ?? "",
      }));
      return { findings, ran: true };
    } catch {
      return { findings: [], ran: false };
    }
  },

  async auditDependencies(baseDir: string = process.cwd()): Promise<{ pinning: PinningFinding[]; vulnerabilities: VulnFinding[] }> {
    const reqPath = resolve(baseDir, "requirements.txt");
    const pinning: PinningFinding[] = [];
    if (existsSync(reqPath)) {
        try {
            const content = readFileSync(reqPath, "utf-8");
            for (const line of content.split("\n")) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith("#")) continue;
                if (!trimmed.includes("==") && !trimmed.includes("@")) {
                    pinning.push({
                        name: trimmed.split(/[>=<~!]/)[0]!.trim(),
                        declaredRange: trimmed,
                        section: "dependencies",
                        reason: "unpinned or loose version constraint in requirements.txt",
                    });
                }
            }
        } catch {}
    }

    const pipAuditBin = getVenvBinPath(baseDir, "pip-audit");
    const result = providerKitHooks.runIsolatedOrNotInstalled([pipAuditBin, "--format=json", "--vulnerability-service=osv"], { cwd: baseDir, writableDir: baseDir });

    const vulnerabilities: VulnFinding[] = [];
    if (!("status" in result) && result.stdout.length > 0) {
        try {
            const parsed = JSON.parse(result.stdout);
            for (const dep of parsed.dependencies ?? []) {
                for (const vuln of dep.vulns ?? []) {
                    vulnerabilities.push({
                        module: dep.name,
                        severity: vuln.fix_versions ? "high" : "moderate",
                        title: vuln.id ?? "Known vulnerability",
                        url: vuln.url ?? "",
                        range: vuln.fixed_in ? `< ${vuln.fixed_in}` : "unknown",
                    });
                }
            }
        } catch {}
    }

    return { pinning, vulnerabilities };
  },

  async getFingerprint(baseDir: string = process.cwd()): Promise<Record<string, string>> {
    const reqPath = resolve(baseDir, "requirements.txt");
    if (existsSync(reqPath)) {
        const content = readFileSync(reqPath, "utf-8");
        return parseLockfileFingerprint(content, /^([^#\s]+)==([\d\.]+)$/gm);
    }
    return {};
  }
};