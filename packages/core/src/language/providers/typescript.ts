// packages/core/src/language/providers/typescript.ts
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LanguageProvider } from "../provider.js";
import type { VerificationResult } from "../../verify/verify.js";
import { verifyComponent } from "../../verify/verify.js";
import type { TestRunResult } from "../../verify/tests.js";
import { runTestsWithQuarantine } from "../../verify/tests.js";
import type { IdiomCheckResult } from "../../verify/idiom.js";
import { checkIdioms } from "../../verify/idiom.js";
import type { PinningFinding, VulnFinding } from "../../security/deps_audit.js";
import { checkVersionPinning, runVulnScan } from "../../security/deps_audit.js";
import type { TestIntegrityChecker } from "../../verify/test_integrity.js";
import { providerKitHooks, runIsolatedOrNotInstalled } from "../provider-kit.js";

export const typescriptProvider: LanguageProvider = {
  id: "typescript",
  minSupportedVersion: "5.0.0",

  // See the getTestIntegrityChecker doc comment on LanguageProvider for why
  // this is dynamic-import-on-first-use rather than a top-level import:
  // ts-morph bundles the full TypeScript compiler and costs ~500ms to
  // load, which every command was paying even for `--version`.
  async getTestIntegrityChecker(): Promise<TestIntegrityChecker> {
    const { typescriptTestIntegrityChecker } = await import("../../verify/test_integrity.js");
    return typescriptTestIntegrityChecker;
  },

  detect(baseDir: string = process.cwd()): boolean {
    const tsconfigPath = resolve(baseDir, "tsconfig.json");
    if (existsSync(tsconfigPath)) return true;

    const pkgPath = resolve(baseDir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
        if (deps["typescript"] || deps["ts-node"] || deps["tsx"]) {
          return true;
        }
      } catch {}
    }
    return false;
  },

  verify(filePaths: string[], baseDir: string = process.cwd()): VerificationResult {
    return verifyComponent(filePaths, baseDir);
  },

  runTests(componentId: string, testFiles: string[], baseDir: string = process.cwd()): TestRunResult {
    return runTestsWithQuarantine(componentId, testFiles, baseDir);
  },

  checkIdiom(filePaths: string[], baseDir: string = process.cwd()): IdiomCheckResult {
    return checkIdioms(filePaths, baseDir);
  },

  async auditDependencies(baseDir: string = process.cwd()): Promise<{ pinning: PinningFinding[]; vulnerabilities: VulnFinding[] }> {
    const pinning = await checkVersionPinning(baseDir);
    const scan = runVulnScan(baseDir);
    return { pinning, vulnerabilities: scan.findings };
  },

  async getFingerprint(baseDir: string = process.cwd()): Promise<Record<string, string>> {
    const lockPath = resolve(baseDir, "package-lock.json");
    if (existsSync(lockPath)) {
        const lock = JSON.parse(readFileSync(lockPath, "utf-8"));
        const packages = lock.packages ?? {};
        const fingerprint: Record<string, string> = {};
        for (const [name, info] of Object.entries<any>(packages)) {
            if (name === "") continue; // root
            const pkgName = name.replace(/^node_modules\//, "");
            fingerprint[pkgName] = info.version;
        }
        return fingerprint;
    }
    const pkgPath = resolve(baseDir, "package.json");
    if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    }
    return {};
  }
};
