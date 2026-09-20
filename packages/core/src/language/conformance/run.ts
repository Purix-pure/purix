// packages/core/src/language/conformance/run.ts
import { writeFileSync, readFileSync, existsSync, cpSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "../../platform/spawn_sync.js";
import { getLanguageProvider } from "../registry.js";
import { pythonPack } from "../providers/python.pack.js";

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
 * .purix-tmp/conformance/<lang>/. This is the ONLY place a fixture's own
 * node_modules / venv / package.json / lockfile / any installed or
 * generated file is allowed to live — packages/ must only ever contain
 * the authored .ts/.py fixture source itself, nothing installed or
 * generated. Re-copies every run so the workspace can't drift from the
 * committed source; the toolchain install below is cached (skipped if
 * already present), so this stays fast on repeat runs.
 */
function prepareRuntimeWorkspace(repoRoot: string, langId: string, sourceFixtureDir: string): string {
  const runtimeDir = resolve(repoRoot, ".purix-tmp", "conformance", langId);
  mkdirSync(runtimeDir, { recursive: true });
  if (existsSync(sourceFixtureDir)) {
    cpSync(sourceFixtureDir, runtimeDir, { recursive: true });
  }
  return runtimeDir;
}

/**
 * Ensures TypeScript is installed LOCALLY to runtimeDir — never globally,
 * never inside packages/. verify.ts's own compileOrTypeCheck looks for
 * node_modules/typescript/bin/tsc scoped to whatever baseDir it's given
 * (no upward search, no reliance on a global `tsc`), by design, so this
 * just makes sure that local install exists before the checks run.
 */
function ensureTypeScriptInstalled(runtimeDir: string): void {
  const tscMarker = resolve(runtimeDir, "node_modules", "typescript", "bin", "tsc");
  if (existsSync(tscMarker)) return;
  console.log(`  Installing TypeScript locally into ${runtimeDir} (not global, not inside packages/)...`);
  const res = spawnSync(
    ["npm", "install", "--no-save", "--no-audit", "--no-fund", "--prefix", runtimeDir, "typescript", "tsx"],
    { cwd: runtimeDir, stdout: "pipe", stderr: "pipe" }
  );
  if (res.exitCode !== 0) {
    console.warn(`  ⚠ Failed to install TypeScript into ${runtimeDir}: ${res.stderr.toString().trim() || res.stdout.toString().trim()}`);
  }
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
  if (!existsSync(pkgPath)) {
    writeFileSync(
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
  }
  if (!existsSync(lockPath)) {
    writeFileSync(
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
 * Ensures Python's pinned toolchain (pyright/pytest/ruff/pip-audit) is
 * installed into runtimeDir's own .purix-tmp/python/venv — reuses the
 * EXACT same mechanism `purix lang install python` already uses for real
 * projects (see python.pack.ts), just pointed at the fixture runtime
 * workspace as baseDir instead of a user's project.
 */
async function ensurePythonInstalled(runtimeDir: string): Promise<void> {
  if (pythonPack.isFullyInstalled(runtimeDir)) return;
  console.log(`  Installing Python toolchain locally into ${runtimeDir}/.purix-tmp/python/ (not global, not inside packages/)...`);
  const results = await pythonPack.install(runtimeDir);
  for (const r of results) {
    if (!r.ok) console.warn(`  ⚠ Failed to install ${r.tool}: ${r.error}`);
  }
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

export async function runConformanceSuite(baseDir: string = process.cwd()): Promise<{ certified: boolean; report: Record<string, LanguageParityStatus> }> {
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

    if (langId === "typescript") {
      ensureTypeScriptInstalled(fixtureDir);
      ensureAuditManifest(fixtureDir);
    }
    if (langId === "python") await ensurePythonInstalled(fixtureDir);

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

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("run.ts")) {
  runConformanceSuite().then(({ certified, report }) => {
    console.log(`Language Parity Conformance Suite completed. Certified: ${certified}`);
    if (!certified) {
      console.log("Details:", JSON.stringify(report, null, 2));
      process.exitCode = 1;
    }
  });
}
