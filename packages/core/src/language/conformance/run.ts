// packages/core/src/language/conformance/run.ts
import { readFileSync, existsSync, cpSync, mkdirSync } from "node:fs";
import { createFileExclusive } from "../../platform/atomic_write.js";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getLanguageProvider } from "../registry.js";
import { installTool, locateTool } from "../../tools/broker.js";
import type { ConsentGate } from "../../tools/consent.js";
import { purixDir, PURIX_DIRNAME } from "../../platform/layout.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Walks up from this file looking for the repo root (pnpm-workspace.yaml,
 * falling back to .git) rather than a hardcoded number of ".." segments —
 * a fixed depth silently breaks the moment this file moves or the package
 * gets nested differently. Falls back to process.cwd() only if neither
 * marker is found at all (e.g. someone copied conformance/ out of the repo).
 */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 15; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml")) || existsSync(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return process.cwd();
}

/**
 * Copies committed fixture source (packages/core/src/language/conformance/
 * fixtures/<lang>/) into a disposable runtime workspace at the repo root:
 * .purix/tmp/conformance/<lang>/. This is the ONLY place a fixture's own
 * node_modules / venv / package.json / lockfile / any installed or
 * generated file is allowed to live — packages/ must only ever contain
 * the authored .ts/.py fixture source itself, nothing installed or
 * generated. Re-copies every run so the workspace can't drift from the
 * committed source; the toolchain install below is cached (skipped if
 * already present), so this stays fast on repeat runs.
 */
function prepareRuntimeWorkspace(repoRoot: string, langId: string, sourceFixtureDir: string): string {
  const runtimeDir = resolve(purixDir(repoRoot), "tmp", "conformance", langId);
  mkdirSync(runtimeDir, { recursive: true });
  if (existsSync(sourceFixtureDir)) {
    cpSync(sourceFixtureDir, runtimeDir, { recursive: true });
  }
  return runtimeDir;
}

/**
 * The tools a language's fixtures need, by tools-broker id. Versions are the catalog's (pinned and
 * hash-locked), so a certification result does not change when a new major ships (TEST-REPORT F11).
 * The conformance run itself installs nothing by hand: it asks the broker, which verifies hashes,
 * skips install scripts, and records what it did.
 */
const CONFORMANCE_TOOLS: Record<string, readonly string[]> = {
  typescript: ["typescript", "tsx", "eslint"],
  python: ["pyright", "pytest", "ruff", "pip-audit"],
};

/**
 * Makes sure each tool is available to the workspace. A tool the workspace can already locate
 * (installed earlier, cached across runs) is left alone. Without a consent gate nothing is installed
 * and the missing tool shows up as a failed check, with the broker's own hint.
 */
async function ensureToolsInstalled(runtimeDir: string, langId: string, consent: ConsentGate | undefined): Promise<void> {
  for (const id of CONFORMANCE_TOOLS[langId] ?? []) {
    if (locateTool({ baseDir: runtimeDir }, id)) continue;
    console.log(`  Installing ${id} into ${runtimeDir}/${PURIX_DIRNAME}/tools/ (pinned, hash-checked; not global, not inside packages/)...`);
    const res = await installTool({ baseDir: runtimeDir, ...(consent ? { consent } : {}) }, id);
    if (!res.ok) console.warn(`  ⚠ Could not install ${id}: ${res.message}${res.hint ? ` ${res.hint}` : ""}`);
  }
}

/**
 * The fixture idiom_violation.ts trips ESLint's built-in `no-var` rule and
 * says it needs "a real eslint.config.js in the runtime workspace (see
 * run.ts)" — that step was never written. The default parser handles the
 * plain-JS-compatible fixture, so no typescript-eslint dependency is needed.
 */
function ensureEslintConfig(runtimeDir: string): void {
  const configPath = resolve(runtimeDir, "eslint.config.mjs");
  // Create-if-absent in one step (no existsSync-then-write gap); an existing file is left as it is.
  createFileExclusive(
    configPath,
    `export default [\n  { files: ["**/*.ts"], rules: { "no-var": "error" } },\n];\n`
  );
}

/**
 * Writes a minimal, dependency-free package.json + package-lock.json into
 * the TS runtime workspace — generated here, at run time, never committed
 * under packages/, since neither file is a .ts source file. Its only job
 * is giving runVulnScan(baseDir) a lockfile to run `npm audit --json`
 * against, so dependency_audit can genuinely execute (ran:true) instead
 * of always reporting ran:false for lack of a manifest. This does NOT yet
 * prove the scanner can detect a real vulnerability — see the
 * dependency_audit step below for that explicitly open item.
 */
function ensureAuditManifest(runtimeDir: string): void {
  const pkgPath = resolve(runtimeDir, "package.json");
  const lockPath = resolve(runtimeDir, "package-lock.json");
  createFileExclusive(
    pkgPath,
    JSON.stringify(
      {
        name: "purix-conformance-typescript-fixture",
        version: "1.0.0",
        private: true,
      },
      null,
      2
    )
  );
  {
    createFileExclusive(
      lockPath,
      JSON.stringify(
        {
          name: "purix-conformance-typescript-fixture",
          version: "1.0.0",
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": { name: "purix-conformance-typescript-fixture", version: "1.0.0" },
          },
        },
        null,
        2
      )
    );
  }
}

/**
 * The Python audit only audits a named requirements.txt (python.ts: pip-audit with no target would audit Purix's own
 * tool venv, not the project), so a workspace without one always reports ran:false. The TypeScript side gets the same
 * treatment from ensureAuditManifest. One pinned, tiny, dependency-free package gives pip-audit something real to scan.
 */
function ensureAuditRequirements(runtimeDir: string): void {
  createFileExclusive(resolve(runtimeDir, "requirements.txt"), "six==1.16.0\n");
}

interface LanguageParityStatus {
  certified: boolean;
  capabilities: {
    compileOrTypeCheck: boolean;
    testExecution: boolean;
    testIntegrityCheck: boolean;
    idiomCheck: boolean;
    dependencyVulnScan: boolean;
  };
  fixtures: Array<{ name: string; passed: boolean; error?: string }>;
}

export interface ConformanceOptions {
  /** How tool installs are approved. Omitted: nothing is installed and missing tools fail their checks. */
  consent?: ConsentGate;
}

export async function runConformanceSuite(
  baseDir: string = process.cwd(),
  options: ConformanceOptions = {}
): Promise<{ certified: boolean; report: Record<string, LanguageParityStatus> }> {
  // Rust/Go/Ruby removed from beta scope — see BETA_SCOPE.md. Re-add here
  // alongside their pack import when a language is un-gated in registry.ts.
  const languages = ["typescript", "python"];
  const report: Record<string, LanguageParityStatus> = {};
  let allCertified = true;

  const repoRoot = findRepoRoot(__dirname);

  for (const langId of languages) {
    const provider = getLanguageProvider(langId);

    const capabilities = {
      compileOrTypeCheck: true,
      testExecution: true,
      testIntegrityCheck: true,
      idiomCheck: true,
      dependencyVulnScan: true,
    };

    const sourceFixtureDir = resolve(__dirname, "fixtures", langId);
    const fixtureDir = prepareRuntimeWorkspace(repoRoot, langId, sourceFixtureDir);

    await ensureToolsInstalled(fixtureDir, langId, options.consent);
    if (langId === "typescript") {
      ensureEslintConfig(fixtureDir);
      ensureAuditManifest(fixtureDir);
    }
    if (langId === "python") ensureAuditRequirements(fixtureDir);

    const fixturesResults: Array<{ name: string; passed: boolean; error?: string }> = [];

    if (!provider) {
      report[langId] = {
        certified: false,
        capabilities,
        fixtures: [{ name: "provider_registered", passed: false, error: "Provider not registered" }],
      };
      allCertified = false;
      continue;
    }

    // All currently-supported languages (typescript, python) are flat,
    // non-per-package fixture layouts — every scenario file lives directly
    // in fixtures/<lang>/. (go/ruby/rust used per-scenario subdirectories
    // before being removed from beta scope; re-introduce `isPerPackage`
    // branching here if a per-package language returns.)
    const scenarios = {
      passing: { file: langId === "typescript" ? "passing_fixture.ts" : "passing.py" },
      brokenCompile: { file: langId === "typescript" ? "broken_compile.ts" : "broken_compile.py" },
      passingTest: { file: langId === "typescript" ? "passing_fixture.ts" : "passing_test.py" },
      brokenTest: { file: langId === "typescript" ? "broken_test_fixture.ts" : "broken_test_test.py" },
      idiomViolation: { file: langId === "typescript" ? "idiom_violation.ts" : "idiom_violation.py" },
      integrityBefore: { file: langId === "typescript" ? "weakened_assertion_before_fixture.ts" : "weakened_assertion_before.py" },
      integrityAfter: { file: langId === "typescript" ? "weakened_assertion_after_fixture.ts" : "weakened_assertion_after.py" },
    };

    // 1. compileOrTypeCheck
    try {
      const passRes = provider.verify([resolve(fixtureDir, scenarios.passing.file)], fixtureDir);
      const brokenRes = provider.verify([resolve(fixtureDir, scenarios.brokenCompile.file)], fixtureDir);

      const passed = passRes.status === "pass" && brokenRes.status === "fail";
      fixturesResults.push({
        name: "compileOrTypeCheck",
        passed,
        error: passed ? undefined : `passRes: ${JSON.stringify(passRes)}, brokenRes: ${JSON.stringify(brokenRes)}`,
      });
    } catch (err: any) {
      fixturesResults.push({ name: "compileOrTypeCheck", passed: false, error: err?.message });
    }

    // 2. testExecution
    try {
      const passRes = provider.runTests("test", [resolve(fixtureDir, scenarios.passingTest.file)], fixtureDir);
      const brokenRes = provider.runTests("test", [resolve(fixtureDir, scenarios.brokenTest.file)], fixtureDir);

      const passed = passRes.status === "pass" && brokenRes.status === "fail";
      fixturesResults.push({
        name: "testExecution",
        passed,
        error: passed ? undefined : `passRes: ${JSON.stringify(passRes)}, brokenRes: ${JSON.stringify(brokenRes)}`,
      });
    } catch (err: any) {
      fixturesResults.push({ name: "testExecution", passed: false, error: err?.message });
    }

    // 3. testIntegrityChecker
    try {
      const testIntegrityChecker = await provider.getTestIntegrityChecker?.();
      if (testIntegrityChecker) {
        const beforePath = resolve(fixtureDir, scenarios.integrityBefore.file);
        const afterPath = resolve(fixtureDir, scenarios.integrityAfter.file);

        const beforeContent = readFileSync(beforePath, "utf-8");
        const afterContent = readFileSync(afterPath, "utf-8");

        const suffix = scenarios.integrityAfter.file.slice(scenarios.integrityAfter.file.lastIndexOf("."));
        const syntheticPath = `conformance_fixture${suffix}`;

        const res = testIntegrityChecker.check(
          [{ path: syntheticPath, content: beforeContent }],
          [{ path: syntheticPath, content: afterContent }]
        );
        fixturesResults.push({
          name: "test_integrity",
          passed: res.flagged,
          error: res.flagged ? undefined : `Integrity check failed to flag a weakened assertion: ${JSON.stringify(res.findings)}`,
        });
      } else {
        fixturesResults.push({ name: "test_integrity", passed: false, error: "Missing testIntegrityChecker" });
      }
    } catch (err: any) {
      fixturesResults.push({ name: "test_integrity", passed: false, error: err?.message });
    }

    // 4. Idiom check
    try {
      const idiomRes = provider.checkIdiom([resolve(fixtureDir, scenarios.idiomViolation.file)], fixtureDir);
      const passed = idiomRes.findings.length > 0;
      fixturesResults.push({
        name: "idiom_check",
        passed,
        error: passed ? undefined : `Idiom check found no issues (or could not run — see 'ran' in the underlying result). Res: ${JSON.stringify(idiomRes)}`,
      });
    } catch (err: any) {
      fixturesResults.push({ name: "idiom_check", passed: false, error: err?.message });
    }

    // 5. Dependency audit
    //
    // Previously this always pushed passed: true regardless of what the
    // scan returned — it could never fail. Fixed to require the scan
    // actually executed (auditRes.ran), per provider.ts's `ran` field
    // (added this pass to typescript.ts and python.ts, both of which
    // previously discarded it). This is a real improvement — the check
    // can now fail — but it is still an HONEST, PARTIAL fix, not a full
    // close-out: it certifies the scanner runs, not that it can detect a
    // real vulnerability. Proving detection needs a fixture with a real,
    // currently-flagged CVE in a lockfile generated against the live npm/
    // PyPI registry, which this environment could not generate and verify
    // without network access. Tracked as an explicit open item in
    // Document 4 §1.5 — do not read `ran: true` as "vulnerability
    // detection is proven," only as "the scan is no longer a no-op."
    try {
      const auditRes = await provider.auditDependencies(fixtureDir);
      const passed = auditRes.ran;
      fixturesResults.push({
        name: "dependency_audit",
        passed,
        error: passed ? undefined : `Dependency scan could not execute: ${JSON.stringify(auditRes)}`,
      });
    } catch (err: any) {
      fixturesResults.push({ name: "dependency_audit", passed: false, error: err?.message });
    }

    const allFixturesPassed = fixturesResults.every((f) => f.passed);
    const allCapsTrue = Object.values(capabilities).every((v) => v === true);
    const certified = allFixturesPassed && allCapsTrue;

    if (!certified) {
      allCertified = false;
    }

    report[langId] = {
      certified,
      capabilities,
      fixtures: fixturesResults,
    };
  }

  return { certified: allCertified, report };
}

/**
 * Entry point for `tsx run.ts` (release-check and CI): there is no one to answer a prompt. Running the
 * suite this way is the explicit act, and it only ever installs the catalog's pinned, hash-checked
 * tools into the disposable conformance workspace. `purix lang verify` passes the human gate instead.
 */
const unattendedGate: ConsentGate = { confirmInstall: () => Promise.resolve(true) };

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("run.ts")) {
  runConformanceSuite(undefined, { consent: unattendedGate })
    .then(({ certified, report }) => {
      console.log(`Language Parity Conformance Suite completed. Certified: ${certified}`);
      if (!certified) {
        console.log("Details:", JSON.stringify(report, null, 2));
        process.exitCode = 1;
      }
    })
    .catch((error: unknown) => {
      console.error("Language Parity Conformance Suite crashed before completing:", error);
      process.exitCode = 1;
    });
}
