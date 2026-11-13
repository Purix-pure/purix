// packages/core/src/language/providers/typescript.ts
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LanguageProvider } from "../provider.js";
import type { VerificationResult } from "../../verify/verify.js";
import { verifyComponent } from "../../verify/verify.js";
import type { TestRunResult } from "../../verify/tests.js";
import { runTestsWithQuarantine, type RunTestsOptions } from "../../verify/tests.js";
import type { IdiomCheckResult } from "../../verify/idiom.js";
import { checkIdioms } from "../../verify/idiom.js";
import type { PinningFinding, VulnFinding } from "../../security/deps_audit.js";
import { checkVersionPinning, runVulnScan } from "../../security/deps_audit.js";
import type { TestIntegrityChecker } from "../../verify/test_integrity.js";
import { discoverRelatedTests } from "../../verify/test_discovery.js";
import { createRequire } from "node:module";
import type { ParseCheckResult } from "../provider.js";

const TS_EXTENSIONS = /\.(?:[cm]?[jt]s|[jt]sx)$/i;

/**
 * The TypeScript compiler that ships inside ts-morph, loaded on first use and synchronously (the verify path is
 * synchronous). It is never the project's own TypeScript, which is why a parse failure only counts when the file's
 * original text parsed clean through the same parser (see verify/precheck.ts).
 */
let tsApi: typeof import("ts-morph").ts | null | undefined;
function loadTs(): typeof import("ts-morph").ts | null {
  if (tsApi !== undefined) return tsApi;
  try {
    tsApi = (createRequire(import.meta.url)("ts-morph") as typeof import("ts-morph")).ts;
  } catch {
    tsApi = null;
  }
  return tsApi;
}

export const typescriptProvider: LanguageProvider = {
  id: "typescript",
  minSupportedVersion: "5.0.0",

  parseCheck(path: string, content: string): ParseCheckResult | undefined {
    if (!TS_EXTENSIONS.test(path)) return undefined;
    const ts = loadTs();
    if (!ts) return undefined;
    // Parse only. transpileModule reports the same syntactic errors but also emits, which is ~10x slower on a 500-line file.
    // The parser's diagnostics are an internal field of the source file; if a future TypeScript hides it, fall back to
    // transpileModule's public report so the check degrades to slower, never to silent.
    const sf = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, false);
    const parseDiagnostics = (sf as unknown as { parseDiagnostics?: readonly { start?: number; code: number; messageText: string | { messageText: string } }[] }).parseDiagnostics;
    if (Array.isArray(parseDiagnostics)) {
      const first = parseDiagnostics[0];
      if (!first || first.start === undefined) return { ok: true };
      const pos = sf.getLineAndCharacterOfPosition(first.start);
      return { ok: false, line: pos.line + 1, column: pos.character + 1, message: ts.flattenDiagnosticMessageText(first.messageText as never, "\n"), code: `TS${first.code}` };
    }
    const out = ts.transpileModule(content, {
      fileName: path,
      reportDiagnostics: true,
      compilerOptions: { allowJs: true, jsx: ts.JsxEmit.Preserve, noResolve: true, isolatedModules: true },
    });
    const first = (out.diagnostics ?? []).find((d) => d.category === ts.DiagnosticCategory.Error && d.file !== undefined && d.start !== undefined);
    if (!first || !first.file || first.start === undefined) return { ok: true };
    const pos = first.file.getLineAndCharacterOfPosition(first.start);
    return { ok: false, line: pos.line + 1, column: pos.character + 1, message: ts.flattenDiagnosticMessageText(first.messageText, "\n"), code: `TS${first.code}` };
  },

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
      } catch { /* best-effort package.json probe */ }
    }
    return false;
  },

  verify(filePaths: string[], baseDir: string = process.cwd()): VerificationResult {
    return verifyComponent(filePaths, baseDir);
  },

  runTests(componentId: string, testFiles: string[], baseDir: string = process.cwd(), options?: RunTestsOptions): TestRunResult {
    return runTestsWithQuarantine(componentId, testFiles, baseDir, options);
  },

  findRelatedTests(changedPaths: string[], baseDir: string = process.cwd()) {
    return discoverRelatedTests(changedPaths, baseDir);
  },

  checkIdiom(filePaths: string[], baseDir: string = process.cwd()): IdiomCheckResult {
    return checkIdioms(filePaths, baseDir);
  },

  async auditDependencies(baseDir: string = process.cwd()): Promise<{ pinning: PinningFinding[]; vulnerabilities: VulnFinding[]; ran: boolean }> {
    const pinning = await checkVersionPinning(baseDir);
    const scan = runVulnScan(baseDir);
    // scan.ran distinguishes "no vulnerabilities found" from "could not
    // scan at all" (no lockfile, npm unavailable) — previously discarded
    // here, which is what let a caller treat both cases as an identical
    // clean pass. See provider.ts's interface comment.
    return { pinning, vulnerabilities: scan.findings, ran: scan.ran };
  },

  getFingerprint(baseDir: string = process.cwd()): Promise<Record<string, string>> {
    return Promise.resolve((() => {
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
    })());
  }
};
