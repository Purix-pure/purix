// packages/core/src/language/providers/python.ts
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { writeFileAtomic } from "../../platform/atomic_write.js";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "../../platform/spawn_sync.js";
import type { LanguageProvider, ParseCheckResult } from "../provider.js";
import type { VerificationResult } from "../../verify/verify.js";
import type { TestRunResult } from "../../verify/tests.js";
import type { IdiomCheckResult, IdiomFinding } from "../../verify/idiom.js";
import type { PinningFinding, VulnFinding } from "../../security/deps_audit.js";
import { parseLockfileFingerprint, providerKitHooks, runIsolatedOrNotInstalled } from "../provider-kit.js";
import type { TestIntegrityChecker } from "../../verify/test_integrity.js";
import { discoverRelatedPythonTests } from "../../verify/python_test_discovery.js";
import { parsePytestSummary } from "../../verify/test_counts.js";
import { failureOfStoppedRun } from "../../verify/outcome.js";
import { toolchainSubdir } from "../../platform/toolchain_tmp.js";
import { locateTool, missingToolHint, type ToolLocation } from "../../tools/broker.js";
import { withCutNote } from "../../verify/discovery_cut.js";

/**
 * Where a Python tool lives is the tools broker's one answer (ADR-060). This file no longer knows
 * about virtualenvs, install folders, or PATH: it asks, and when there is no answer it reports
 * not_installed with the broker's own sentence (e.g. "Run: purix tools install pytest").
 */
function toolOrHint(baseDir: string, id: string): { loc: ToolLocation } | { hint: string } {
  const loc = locateTool({ baseDir }, id);
  return loc ? { loc } : { hint: missingToolHint({ baseDir }, id) };
}

/** A Purix-installed tool lives outside the verification copy; its real folder must stay readable in the sandbox. */
function bindsFor(loc: ToolLocation): string[] {
  return loc.toolHome ? [loc.toolHome] : [];
}

/** The interpreter used for the syntax check, probed once per process. Null when none answers (the check is then skipped). */
let pythonForParse: string | null | undefined;
function parseInterpreter(): string | null {
  if (pythonForParse !== undefined) return pythonForParse;
  pythonForParse = null;
  for (const bin of ["python3", "python"]) {
    // cwd is pinned to the OS tmpdir: a bare probe must never let a launcher shim install a runtime into the project.
    // tier T1: the parse check's own row in platform/spawn_sync.ts. Without a tier a hung interpreter was waited on for the default ten minutes.
    const res = spawnSync([bin, "--version"], { cwd: tmpdir(), stdout: "pipe", stderr: "pipe", tier: "T1" });
    if (res.exitCode === 0) { pythonForParse = bin; break; }
  }
  return pythonForParse;
}

const PY_PARSE_SCRIPT = `
import ast, sys, json
try:
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        ast.parse(f.read(), filename=sys.argv[2])
    print(json.dumps({"ok": True}))
except SyntaxError as e:
    print(json.dumps({"ok": False, "line": e.lineno or 1, "column": e.offset or 1, "message": e.msg}))
`;

export const pythonProvider: LanguageProvider = {
  id: "python",
  minSupportedVersion: "3.10.0",

  parseCheck(path: string, content: string): ParseCheckResult | undefined {
    if (!/\.pyi?$/i.test(path)) return undefined;
    const bin = parseInterpreter();
    if (!bin) return undefined;
    const dir = mkdtempSync(join(tmpdir(), "purix-pyparse-"));
    try {
      const src = join(dir, "src.py");
      const script = join(dir, "check.py");
      writeFileAtomic(src, content);
      writeFileAtomic(script, PY_PARSE_SCRIPT);
      // A stop (deadline, signal, output cap) comes back with a null exit code, so it is "could not check" here, never ok and never a syntax error.
      const res = spawnSync([bin, script, src, path], { cwd: dir, stdout: "pipe", stderr: "pipe", tier: "T1" });
      if (res.exitCode !== 0) return undefined;
      const parsed = JSON.parse(res.stdout.toString().trim()) as { ok: boolean; line?: number; column?: number; message?: string };
      return parsed.ok ? { ok: true } : { ok: false, line: parsed.line ?? 1, column: parsed.column ?? 1, message: parsed.message ?? "invalid syntax", code: "SyntaxError" };
    } catch {
      return undefined;
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  },

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
    const pyright = toolOrHint(baseDir, "pyright");
    if ("hint" in pyright) {
      return { status: "not_installed", reason: "Python tooling (pyright) not installed", actionHint: pyright.hint };
    }
    const result = runFn([...pyright.loc.command, ...filePaths], { cwd: baseDir, writableDir: baseDir, extraReadOnlyBinds: bindsFor(pyright.loc) });

    if ("status" in result) {
      return { status: "not_installed", reason: "Python tooling (pyright) not installed or failed to spawn", actionHint: missingToolHint({ baseDir }, "pyright") };
    }
    const stoppedRun = failureOfStoppedRun(result, "The Python type check (pyright)");
    if (stoppedRun) return { status: "fail", reason: stoppedRun.reason, ...(stoppedRun.infrastructure ? { infrastructure: stoppedRun.infrastructure } : {}) };
    if (result.exitCode === 0) return { status: "pass", isolation: result.isolation };
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    return { status: "fail", reason: stderr || stdout || "pyright verification failed" };
  },

  findRelatedTests(changedPaths: string[], baseDir: string = process.cwd()) {
    return discoverRelatedPythonTests(changedPaths, baseDir);
  },

  // `changedFiles` are the files that changed (the sandbox passes them for every language), NOT test
  // files. Tests are chosen by relation to the change, as for TypeScript. This used to hand the changed
  // source files themselves to pytest, which collects nothing from them and exits 5 ("no tests collected").
  runTests(componentId: string, changedFiles: string[], baseDir: string = process.cwd()): TestRunResult {
    const pytest = toolOrHint(baseDir, "pytest");
    if ("hint" in pytest) {
      return { status: "not_installed", reason: "Python tooling (pytest) not installed", actionHint: pytest.hint, quarantinedFailures: [] };
    }
    const discovery = discoverRelatedPythonTests(changedFiles, baseDir);
    const discoverySummary = { tests: discovery.tests, uncovered: discovery.uncovered, truncated: discovery.truncated };
    if (discovery.tests.length === 0) {
      return {
        status: "no_tests",
        reason: discovery.uncovered.length > 0
          ? withCutNote(`no test covers ${discovery.uncovered.join(", ")} (looked for tests that import it, directly or through other files, and for test_<name>.py / <name>_test.py)`, discovery.truncated)
          : "none of the changed files is a Python source",
        quarantinedFailures: [],
        discovery: discoverySummary,
      };
    }
    const result = providerKitHooks.runIsolatedOrNotInstalled([...pytest.loc.command, ...discovery.tests], {
      cwd: baseDir,
      writableDir: baseDir,
      extraReadOnlyBinds: bindsFor(pytest.loc),
    });

    if ("status" in result) {
      return {
        status: "not_installed",
        reason: "Python tooling (pytest) not installed or failed to spawn",
        actionHint: missingToolHint({ baseDir }, "pytest"),
        quarantinedFailures: [],
      };
    }
    const stoppedRun = failureOfStoppedRun(result, "The Python test run (pytest)");
    if (stoppedRun) {
      return {
        status: "fail",
        reason: stoppedRun.reason,
        ...(stoppedRun.infrastructure ? { infrastructure: stoppedRun.infrastructure } : {}),
        quarantinedFailures: [],
        isolation: result.isolation,
        discovery: discoverySummary,
      };
    }
    if (result.exitCode === 0) {
      // The count rule (A6-1; research 06): pytest exits 0 when every test is skipped or only expected-to-fail, so the exit code
      // alone read as a pass. The summary line says what ran. With no readable summary nothing is guessed: exit 0 stays a pass.
      const counts = parsePytestSummary(result.stdout);
      if (counts && counts.passed === 0 && counts.failed === 0) {
        const sources = changedFiles.filter((f) => f.endsWith(".py"));
        return {
          status: "no_tests",
          reason: `no test ran: pytest ran ${discovery.tests.join(", ")} but every test was skipped or expected to fail, so nothing exercised ${sources.join(", ")}`,
          quarantinedFailures: [],
          isolation: result.isolation,
          discovery: { tests: [], uncovered: sources, truncated: discovery.truncated },
          notRun: "all_skipped",
          counts: { passed: counts.passed, failed: counts.failed, skipped: counts.skipped + counts.xfailed },
        };
      }
      return {
        status: "pass",
        quarantinedFailures: [],
        isolation: result.isolation,
        discovery: discoverySummary,
        ...(counts ? { counts: { passed: counts.passed, failed: counts.failed, skipped: counts.skipped + counts.xfailed } } : {}),
      };
    }
    // pytest exit code 5 = "no tests collected": the selected files hold no test functions, so nothing ran.
    if (result.exitCode === 5) {
      const sources = changedFiles.filter((f) => f.endsWith(".py"));
      return {
        status: "no_tests",
        reason: `pytest collected no tests from ${discovery.tests.join(", ")}`,
        quarantinedFailures: [],
        isolation: result.isolation,
        discovery: { tests: [], uncovered: sources, truncated: discovery.truncated },
      };
    }
    const stdout = result.stdout.trim();
    const stderr = result.stderr.trim();
    return {
      status: "fail",
      reason: stderr || stdout || "pytest test run failed",
      quarantinedFailures: [],
      isolation: result.isolation,
      discovery: discoverySummary,
    };
  },

  checkIdiom(filePaths: string[], baseDir: string = process.cwd()): IdiomCheckResult {
    const ruff = toolOrHint(baseDir, "ruff");
    if ("hint" in ruff) {
      return { findings: [], ran: false, status: "not_installed", reason: "Python tooling (ruff) not installed", actionHint: ruff.hint };
    }
    const ruffCache = toolchainSubdir(baseDir, "python", "ruff_cache");
    const result = providerKitHooks.runIsolatedOrNotInstalled([...ruff.loc.command, "check", "--output-format=json", ...filePaths], {
        cwd: baseDir,
        writableDir: baseDir,
        env: { RUFF_CACHE_DIR: ruffCache },
        extraReadOnlyBinds: bindsFor(ruff.loc),
    });

    if ("status" in result) {
      return {
        findings: [],
        ran: false,
        status: "not_installed",
        reason: "Python tooling (ruff) not installed or failed to spawn",
        actionHint: missingToolHint({ baseDir }, "ruff"),
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

  auditDependencies(baseDir: string = process.cwd()): Promise<{ pinning: PinningFinding[]; vulnerabilities: VulnFinding[]; ran: boolean }> {
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
        } catch { /* best-effort audit parse — a malformed entry shouldn't fail the whole scan */ }
    }

    // pip-audit given no target audits the environment it runs in, which is Purix's own tool venv, not
    // the project (measured: "would have audited 29 packages", exactly the tool venv's 29). So the
    // target is named. Only requirements.txt is supported; a project without one reports ran:false
    // rather than auditing the wrong thing.
    if (!existsSync(reqPath)) return Promise.resolve({ pinning, vulnerabilities: [], ran: false });

    const pipAudit = toolOrHint(baseDir, "pip-audit");
    // No pip-audit means the scan could not run: ran:false, never a clean pass (provider.ts).
    if ("hint" in pipAudit) return Promise.resolve({ pinning, vulnerabilities: [], ran: false });
    const result = providerKitHooks.runIsolatedOrNotInstalled(
      [...pipAudit.loc.command, "--format=json", "--vulnerability-service=osv", "-r", "requirements.txt"],
      { cwd: baseDir, writableDir: baseDir, extraReadOnlyBinds: bindsFor(pipAudit.loc) }
    );

    // "status" in result means pip-audit itself could not run (not installed, isolation unavailable).
    if ("status" in result) return Promise.resolve({ pinning, vulnerabilities: [], ran: false });

    // Exit code 1 means BOTH "found vulnerabilities" and "failed" (vulnerability service unreachable,
    // dependency resolution error), so the exit code cannot say whether the audit completed. A failed
    // run prints no JSON report; a completed one always prints {"dependencies": [...]}. Only the
    // report proves the scan happened. "Could not check" must never read as "checked and clean"
    // (provider.ts); the sandbox denies network, so on isolated runs this is the common failure.
    let report: { dependencies?: unknown } | undefined;
    try { report = JSON.parse(result.stdout); } catch { /* not a report: handled below */ }
    if (!report || !Array.isArray(report.dependencies)) return Promise.resolve({ pinning, vulnerabilities: [], ran: false });

    const vulnerabilities: VulnFinding[] = [];
    for (const dep of report.dependencies as Array<{ name?: string; vulns?: Array<{ id?: string; fix_versions?: string[] }> }>) {
        for (const vuln of dep.vulns ?? []) {
            // Real pip-audit vulns carry id, aliases, description and fix_versions. There is no url or
            // fixed_in field, so the url is the OSV page for the id and the range comes from fix_versions.
            const fixes = Array.isArray(vuln.fix_versions) ? vuln.fix_versions : [];
            vulnerabilities.push({
                module: dep.name ?? "unknown",
                severity: fixes.length > 0 ? "high" : "moderate",
                title: vuln.id ?? "Known vulnerability",
                url: vuln.id ? `https://osv.dev/vulnerability/${vuln.id}` : "",
                range: fixes.length === 1 ? `< ${fixes[0]}` : fixes.length > 1 ? `fixed in: ${fixes.join(", ")}` : "unknown",
            });
        }
    }

    return Promise.resolve({ pinning, vulnerabilities, ran: true });
  },

  getFingerprint(baseDir: string = process.cwd()): Promise<Record<string, string>> {
    const reqPath = resolve(baseDir, "requirements.txt");
    if (existsSync(reqPath)) {
        const content = readFileSync(reqPath, "utf-8");
        return Promise.resolve(parseLockfileFingerprint(content, /^([^#\s]+)==([\d.]+)$/gm));
    }
    return Promise.resolve({});
  }
};