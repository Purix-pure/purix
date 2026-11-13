// src/verify/tests.ts
//
// Runtime migration (ADR-048) & framework detection: supports executing test suites
// across Node.js (`node:test` via `tsx`), Jest, Vitest, and Mocha with isolation via `runIsolated`.
// `detectTestFramework` identifies the configured test runner, and `runTestsWithQuarantine`
// executes the tests in sandbox isolation, parsing JSON/TAP test results.
import { existsSync, realpathSync, readFileSync, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { recordTestResult, isFlaky } from "../manifest/test_history.js";
import { runIsolated, type IsolationLevel } from "../sandbox/sandbox_exec.js";
import { discoverRelatedTests, isJsTsFile, isTestPath, type TestDiscovery } from "./test_discovery.js";
import { assessTestReport, type TestCounts } from "./test_counts.js";
import { ensureNodeTestReporter, parseReporterOutput, reporterSpecifier } from "./node_test_reporter.js";
import { locateTool, missingToolHint, type ToolLocation } from "../tools/broker.js";
import { failureOfStoppedRun, type InfrastructureKind } from "./outcome.js";
import { withCutNote } from "./discovery_cut.js";
import { changedLineCoverage, parseLcov, parseLcovBranchMisses, typeOnlyLines, type ChangedLineCoverage } from "./changed_line_coverage.js";
import { randomBytes } from "node:crypto";

export interface TestRunResult {
  status: "pass" | "fail" | "no_tests" | "not_installed";
  reason?: string;
  /** F02-03: set only on a "fail" that is not about the code: the run was stopped for output or resources. A timeout is left unlabelled on purpose (see failureOfStoppedRun). Never repair-eligible. */
  infrastructure?: InfrastructureKind;
  actionHint?: string;
  quarantinedFailures: string[];
  // Set only on the pass/fail outcomes that actually ran through
  // runIsolated() below — "no_tests" (nothing to run) and the
  // "no supported framework" fail case (never got as far as invoking
  // anything) genuinely have no isolation level to report, and leaving
  // this undefined there is the honest reflection of that, not a gap.
  isolation?: IsolationLevel;
  /**
   * What discovery found. On "pass" it says which tests ran and why; on "no_tests" it names the changed
   * files nothing covers. "no_tests" means NOT TESTED — never read it as clean.
   */
  discovery?: { tests: string[]; uncovered: string[]; truncated: boolean };
  /**
   * Set only with status "no_tests" when tests WERE selected and the runner started, but exercised nothing (A6-1, the count
   * rule): "no_tests_ran" = the report held no tests; "all_skipped" = it held only skipped / pending / todo entries. Either way
   * the changed sources are in discovery.uncovered, so every existing "not tested" path (sandbox.ts, the Not-Tested trailer)
   * treats it exactly like "no test covers this". Optional and additive: a consumer that ignores it behaves as before.
   */
  notRun?: "no_tests_ran" | "all_skipped";
  /** What the runner's own report counted, when it was read. A pass with skipped > 0 says how many tests it does NOT rest on. */
  counts?: TestCounts;
  /**
   * F06-02, baseline compare: tests that failed in the changed copy and ALSO failed on the unmodified code, so this change did not break them
   * (already broken, or flaky). Not blocking, never silent: callers that print a result can name them. Set only when a baseline was offered.
   */
  preExistingFailures?: string[];
  /**
   * F06-04: how much of what this change touched a passing run actually ran. Set only when the caller offered `options.coverage` and the run
   * produced a report. Information, never a gate: nothing reads it to block a change. `notMeasured` inside it lists changed files the report
   * did not mention (never read as covered).
   */
  changedLineCoverage?: ChangedLineCoverage;
  /** F06-04: why no coverage figure exists although it was asked for (a framework without a producer yet, or a report that could not be read). Never read it as "covered". */
  coverageNotMeasured?: string;
}

/** A fresh copy of the project as it is NOW, before the change, and the function that removes it. The sandbox supplies it (verify/tests.ts must not import the sandbox). */
export interface BaselineCopy {
  dir: string;
  dispose: () => void;
}

export interface RunTestsOptions {
  /**
   * F06-02 (research 06 section 4). When given, a failing test is judged against the unmodified code instead of a re-run of the changed code:
   * it is re-run up to BASELINE_RUNS times there, and it is forgiven only if it failed there at least once. A test that passes on the unmodified
   * code every time was broken by this change and blocks, even if a re-run of the changed code happens to pass. When the baseline cannot be
   * produced or read, nothing is forgiven. Without this option the older re-run-and-forgive rule applies (dependents re-check, library use).
   */
  baseline?: () => BaselineCopy;
  /**
   * F06-04: ask the runner for line coverage and report how much of the changed code a passing run ran. `changed` maps a file (relative to the folder the
   * tests run in) to its changed line numbers (changedLineNumbers). `typeText` optionally maps a file to its new text so lines that only hold types
   * are left out. node:test, Jest, Vitest (with a coverage package installed) and Mocha (with c8 installed) have a producer; anything else, or a missing package, returns `coverageNotMeasured` with the reason. Off by default:
   * a run that does not ask is exactly as before.
   */
  coverage?: { changed: Record<string, number[]>; newText?: Record<string, string> };
}

/** Times a failing test is re-run on the unmodified code before it is called the change's own failure (research 06 section 4: 3). */
export const BASELINE_RUNS = 3;

export type TestFramework = "jest" | "vitest" | "mocha" | "node:test";

/**
 * Which tools-broker entry runs a given framework. node:test files are TypeScript, so they run through
 * tsx. There is no package-runner fallback: nothing here may download an unpinned package at run time. When the
 * runner is neither the project's own nor installed through `purix tools`, the caller reports
 * not_installed with the broker's hint.
 */
export function runnerToolId(framework: TestFramework): "jest" | "vitest" | "mocha" | "tsx" {
  return framework === "node:test" ? "tsx" : framework;
}

export function locateRunner(baseDir: string, framework: TestFramework): ToolLocation | null {
  return locateTool({ baseDir }, runnerToolId(framework));
}

export function detectTestFramework(baseDir: string, testFiles: string[]): TestFramework | null {
  const pkgPath = resolve(baseDir, "package.json");
  let pkg: any = {};
  if (existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    } catch { /* malformed package.json is handled by the empty pkg default below */ }
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const hasJest = Boolean(deps.jest || existsSync(resolve(baseDir, "jest.config.js")) || existsSync(resolve(baseDir, "jest.config.ts")));
  const hasVitest = Boolean(deps.vitest || existsSync(resolve(baseDir, "vitest.config.js")) || existsSync(resolve(baseDir, "vitest.config.ts")));
  const hasMocha = Boolean(deps.mocha || existsSync(resolve(baseDir, ".mocharc.json")) || existsSync(resolve(baseDir, ".mocharc.yml")));

  if (hasJest) return "jest";
  if (hasVitest) return "vitest";
  if (hasMocha) return "mocha";

  const hasNodeTest = Boolean(deps["@types/node"] || testFiles.some(f => {
    try {
      const content = readFileSync(resolve(baseDir, f), "utf-8");
      return content.includes("node:test");
    } catch {
      return false;
    }
  }));

  if (hasNodeTest || existsSync(resolve(baseDir, "tsconfig.json"))) {
    return "node:test";
  }

  return null;
}

// Statuses Jest and Vitest use for a test that did not run: Jest says "pending" (skipped), "todo" and "disabled", Vitest says
// "skipped", "pending" and "todo". None of them is a pass or a failure (A6-1; research 06 section 1).
const NOT_RUN_STATUSES = new Set(["pending", "skipped", "todo", "disabled"]);

function parseAssertionResults(output: string): ParsedTest[] {
  try {
    const data = JSON.parse(output);
    const results: ParsedTest[] = [];
    for (const file of data.testResults || []) {
      for (const ar of file.assertionResults || []) {
        const skipped = NOT_RUN_STATUSES.has(ar.status);
        results.push({ name: ar.fullName || ar.title, passed: ar.status === "passed", ...(skipped ? { skipped: true } : {}) });
      }
    }
    return results;
  } catch {
    return [];
  }
}

export function parseJestJson(output: string): ParsedTest[] {
  return parseAssertionResults(output);
}

export function parseVitestJson(output: string): ParsedTest[] {
  return parseAssertionResults(output);
}

export function parseMochaJson(output: string): ParsedTest[] {
  try {
    const data = JSON.parse(output);
    const results: ParsedTest[] = [];
    // Mocha's `tests` array holds pending tests too, with no `err`, so they used to read as passes. The ones that did not run
    // are the entries of the separate `pending` array; match them back by file and full title, one for one (titles can repeat).
    const pending = new Map<string, number>();
    for (const p of data.pending || []) {
      const key = `${p.file ?? ""}\u0000${p.fullTitle || p.title}`;
      pending.set(key, (pending.get(key) ?? 0) + 1);
    }
    for (const t of data.tests || []) {
      const key = `${t.file ?? ""}\u0000${t.fullTitle || t.title}`;
      const left = pending.get(key) ?? 0;
      if (left > 0) {
        pending.set(key, left - 1);
        results.push({ name: t.fullTitle || t.title, passed: false, skipped: true });
        continue;
      }
      results.push({ name: t.fullTitle || t.title, passed: !t.err || Object.keys(t.err).length === 0 });
    }
    return results;
  } catch {
    return [];
  }
}

export interface ParsedTest {
  name: string;
  passed: boolean;
  /** Skipped, pending, todo or disabled: the test did not run. Neither a pass nor a failure. */
  skipped?: boolean;
}

/** Extra read-only binds a sandboxed run in `dir` needs so its linked node_modules (and a pnpm store above it) resolve. */
function nodeModulesBinds(dir: string): string[] {
  const extraBinds: string[] = [];
  const nodeModulesPath = join(dir, "node_modules");
  if (!existsSync(nodeModulesPath)) return extraBinds;
  try {
    const real = realpathSync(nodeModulesPath);
    if (real !== nodeModulesPath) extraBinds.push(real);
    // pnpm hoists package content into one .pnpm store at the workspace root; a package's node_modules entries are symlinks into it.
    let d = dirname(real);
    for (let i = 0; i < 8; i++) {
      if (existsSync(join(d, "node_modules", ".pnpm"))) {
        extraBinds.push(join(d, "node_modules"));
        break;
      }
      const parent = dirname(d);
      if (parent === d) break; // reached filesystem root
      d = parent;
    }
  } catch {
    // not a symlink, or unreadable: nothing extra to bind
  }
  return extraBinds;
}

function frameworkArgs(framework: TestFramework, dir: string): string[] {
  if (framework === "jest") return ["--json"];
  if (framework === "vitest") return ["run", "--reporter=json"];
  if (framework === "mocha") return ["--reporter", "json"];
  // node:test: structured events through a custom reporter, not the text of a built-in one.
  return ["--test", `--test-reporter=${reporterSpecifier(ensureNodeTestReporter(dir))}`, "--test-reporter-destination=stdout"];
}

function parseFor(framework: TestFramework, stdout: string): ParsedTest[] {
  if (framework === "jest") return parseJestJson(stdout);
  if (framework === "vitest") return parseVitestJson(stdout);
  if (framework === "mocha") return parseMochaJson(stdout);
  return parseReporterOutput(stdout);
}

interface BaselineVerdict {
  /** Failed on the unmodified code at least once: not this change's doing. */
  preExisting: string[];
  /** Passed (or was not reported) on the unmodified code every time: this change's failure. */
  ownedByChange: string[];
  /** Why no comparison could be made at all; then every name is in ownedByChange. */
  unavailable?: string;
}

/**
 * F06-02: run the selected tests on the unmodified code up to BASELINE_RUNS times and sort each failing test into "failed there too" or
 * "this change's". Strict on every doubt: a baseline that cannot be built, has none of the test files, is stopped, or does not report the
 * test by name never forgives it. Only the failing path calls this, so the cost is a few runs of the selected tests, on a failure only.
 */
function compareWithBaseline(framework: TestFramework, names: string[], testFiles: string[], makeBaseline: () => BaselineCopy): BaselineVerdict {
  const owned = (why: string): BaselineVerdict => ({ preExisting: [], ownedByChange: [...names], unavailable: why });
  let copy: BaselineCopy;
  try {
    copy = makeBaseline();
  } catch (err) {
    return owned(`a copy of the unmodified project could not be made (${err instanceof Error ? err.message : String(err)})`);
  }
  try {
    // A test file the change adds does not exist on the unmodified code; a failure inside it cannot be called pre-existing.
    const baseFiles = testFiles.filter((f) => existsSync(join(copy.dir, f)));
    if (baseFiles.length === 0) return owned("none of the selected test files exist on the unmodified code");
    const runner = locateRunner(copy.dir, framework);
    if (!runner) return owned(`${runnerToolId(framework)} could not be found for the unmodified code`);
    const binds = nodeModulesBinds(copy.dir);
    if (runner.toolHome) binds.push(runner.toolHome);
    const args = frameworkArgs(framework, copy.dir);
    const failedThere = new Set<string>();
    for (let round = 0; round < BASELINE_RUNS && failedThere.size < names.length; round++) {
      const res = runIsolated([...runner.command, ...args, ...baseFiles], { cwd: copy.dir, writableDir: copy.dir, extraReadOnlyBinds: binds });
      if (failureOfStoppedRun(res, `The ${framework} run on the unmodified code`)) break; // stopped: no report, so nothing is forgiven
      const parsed = parseFor(framework, res.stdout);
      for (const name of names) {
        const seen = parsed.find((t) => t.name === name);
        if (seen && !seen.passed && !seen.skipped) failedThere.add(name);
      }
    }
    return { preExisting: names.filter((n) => failedThere.has(n)), ownedByChange: names.filter((n) => !failedThere.has(n)) };
  } finally {
    try {
      copy.dispose();
    } catch {
      /* the copy lives in the temp folder; a failed removal must not change the verdict */
    }
  }
}

/** The one place this file prints a non-blocking notice (the single-point check allows few console calls here). */
function say(message: string): void {
  console.log(`  ⚠ ${message}`);
}

export function runTestsWithQuarantine(
  componentId: string,
  filePaths: string[],
  baseDir: string = process.cwd(),
  options: RunTestsOptions = {}
): TestRunResult {
  // Tests are chosen by relation to the change (imports + name), not by a sibling-file naming rule
  // (verify/test_discovery.ts). Anything that is not a JS/TS file has no tests to find here.
  if (!filePaths.some(isJsTsFile)) {
    return { status: "no_tests", reason: "none of the changed files is a JavaScript or TypeScript source", quarantinedFailures: [] };
  }
  const discovery: TestDiscovery = discoverRelatedTests(filePaths, baseDir);
  const testFiles = discovery.tests;
  const discoverySummary = { tests: testFiles, uncovered: discovery.uncovered, truncated: discovery.truncated };

  const framework = detectTestFramework(baseDir, testFiles);
  if (!framework) {
    return {
      status: "fail",
      reason: `no supported test framework detected in ${baseDir} — expected node:test, Jest, Vitest, or Mocha`,
      quarantinedFailures: [],
    };
  }

  if (testFiles.length === 0) {
    return {
      status: "no_tests",
      reason: withCutNote(`no test covers ${discovery.uncovered.join(", ")} (looked for tests that import it, directly or through other files, and for a test with the same name in the same folder, __tests__/ or test/)`, discovery.truncated),
      quarantinedFailures: [],
      discovery: discoverySummary,
    };
  }

  // node_modules inside the sandbox dir is usually a symlink back to the real project's node_modules (sandbox.ts sets this up):
  // bwrap's default-deny needs that target, and a pnpm store above it, bound read-only (nodeModulesBinds).
  const extraBinds = nodeModulesBinds(baseDir);

  const runner = locateRunner(baseDir, framework);
  if (!runner) {
    const id = runnerToolId(framework);
    return {
      status: "not_installed",
      reason: `${id} is not installed, so the ${framework} tests could not run`,
      actionHint: missingToolHint({ baseDir }, id),
      quarantinedFailures: [],
    };
  }
  // A Purix-installed tool lives outside the verification copy; its real folder must stay readable
  // inside the sandbox (an interpreter path baked into the tool's scripts has to resolve there too).
  if (runner.toolHome) extraBinds.push(runner.toolHome);

  // node:test: structured events through a custom reporter, not the text of a built-in one.
  const nodeArgs = ["--test", `--test-reporter=${reporterSpecifier(ensureNodeTestReporter(baseDir))}`, "--test-reporter-destination=stdout"];

  const runnerCmd = runner.command;
  let runnerArgs = nodeArgs;

  if (framework === "jest") {
    runnerArgs = ["--json"];
  } else if (framework === "vitest") {
    runnerArgs = ["run", "--reporter=json"];
  } else if (framework === "mocha") {
    runnerArgs = ["--reporter", "json"];
  }

  // F06-04: a second reporter writes an lcov file next to the project (inside the folder the sandbox may write to). It is removed before this
  // function returns, on every path.
  const plan = options.coverage !== undefined ? coveragePlan(framework, baseDir) : undefined;
  const coverageFile = plan?.file;
  const coverageArgs = plan?.args ?? [];
  const isolated = runIsolated([...(plan?.wrap ?? []), ...runnerCmd, ...runnerArgs, ...coverageArgs, ...testFiles], {
    cwd: baseDir,
    writableDir: baseDir,
    extraReadOnlyBinds: extraBinds,
  });
  // Read the report and remove the file now, before any return below.
  const lcovText = coverageFile ? readAndRemove(coverageFile, plan?.dir) : undefined;

  // F02-03: a run that was stopped has no report to read. Say what stopped it, so an overflow never reads as a failing test.
  const stoppedRun = failureOfStoppedRun(isolated, `The ${framework} test run`);
  if (stoppedRun) {
    return {
      status: "fail",
      reason: stoppedRun.reason,
      ...(stoppedRun.infrastructure ? { infrastructure: stoppedRun.infrastructure } : {}),
      quarantinedFailures: [],
      isolation: isolated.isolation,
    };
  }

  if (isolated.isolation === "none") {
    console.warn(
      `  [sandbox] no bwrap (Linux) or sandbox-exec (macOS) found, so the tests ran WITHOUT isolation: ` +
        `test code had full access to this machine's files and network. ` +
        `Windows has no native isolation backend: run inside WSL2 and install bwrap there to isolate them (macOS uses sandbox-exec, Linux needs bwrap).`
    );
  }

  let parsedTests: ParsedTest[];
  if (framework === "jest") parsedTests = parseJestJson(isolated.stdout);
  else if (framework === "vitest") parsedTests = parseVitestJson(isolated.stdout);
  else if (framework === "mocha") parsedTests = parseMochaJson(isolated.stdout);
  else parsedTests = parseReporterOutput(isolated.stdout);

  // The count rule (A6-1; research 06 section 1; ADR-069): a pass needs at least one test that ran and passed, counted from the
  // runner's own report, whatever the exit code said. A run that exercised nothing is NOT TESTED, which is the status every
  // consumer already reads as "not tested, not a pass, not worth a repair".
  const assessed = assessTestReport(parsedTests, isolated.exitCode);
  const counts: TestCounts = { passed: assessed.passed, failed: assessed.failed, skipped: assessed.skipped };
  if (assessed.verdict === "no_tests_ran" || assessed.verdict === "all_skipped") {
    // The changed sources, not the test files: they are what nothing exercised. If only test files changed, name those, so
    // the "not tested" list is never empty (sandbox.ts reads it from discovery.uncovered).
    const sources = filePaths.filter(isJsTsFile);
    const uncovered = sources.filter((f) => !isTestPath(f));
    const named = uncovered.length > 0 ? uncovered : sources;
    return {
      status: "no_tests",
      reason:
        assessed.verdict === "all_skipped"
          ? `no test ran: all ${assessed.skipped} selected test(s) were skipped or marked todo, so nothing exercised ${named.join(", ")}`
          : `no test ran: the ${framework} run reported no tests (${testFiles.join(", ")} declare none), so nothing exercised ${named.join(", ")}`,
      quarantinedFailures: [],
      isolation: isolated.isolation,
      discovery: { tests: [], uncovered: named, truncated: discovery.truncated },
      notRun: assessed.verdict,
      counts,
    };
  }
  if (assessed.verdict === "unreported") {
    // Nothing countable and a non-zero exit: the run may have crashed (syntax error, missing module). That is a failure of the
    // code, as before, and it keeps the runner's own words.
    return {
      status: "fail",
      reason: isolated.stderr.trim() || isolated.stdout.trim() || "test run failed and reported no individual test results — quarantine skipped for this run",
      quarantinedFailures: [],
      isolation: isolated.isolation,
    };
  }

  const quarantined: string[] = [];
  const real: string[] = [];
  const failing: string[] = [];

  for (const t of parsedTests) {
    // A skipped / todo test did not run: not a pass, not a failure, never re-run and never forgiven by a re-run's exit code
    // (that is how a skipped test used to read as a pass), and not written to the flaky history.
    if (t.skipped) continue;
    const name = t.name;
    const passed = t.passed;
    // Judge flakiness on the history as it stood BEFORE this run. Recording
    // first would put the current failure into the history, and any test that
    // had passed at least FLAKY_MIN_SAMPLES-1 times would then look "mixed"
    // (pass + fail) on its very first real regression and be excused.
    const flakyBefore = passed ? false : isFlaky(componentId, name);
    recordTestResult(componentId, name, passed ? "pass" : "fail");
    if (passed) continue;

    // F06-02: with a baseline, a failure is judged against the unmodified code (below), never by re-running the changed code.
    if (options.baseline) {
      failing.push(name);
      continue;
    }

    // Without a baseline (the dependents re-check has none: the change has already landed): the older rule. A failure is only
    // non-blocking if it does NOT reproduce. History decides how it is reported, never whether a reproducible failure blocks: a
    // deterministic failure fails the re-run too, however flaky the test once was. One bounded, local re-run (not an LLM call).
    const rerunArgs = framework === "node:test" ? [...runnerArgs, "--test-name-pattern", name] : runnerArgs;
    const rerun = runIsolated([...runnerCmd, ...rerunArgs, ...testFiles], {
      cwd: baseDir,
      writableDir: baseDir,
      extraReadOnlyBinds: extraBinds,
    });
    let rerunPassed = rerun.exitCode === 0;
    const rerunParsed = framework === "node:test" ? parseReporterOutput(rerun.stdout) : [];
    const rerunTest = rerunParsed.find((rt) => rt.name === name);
    if (rerunTest) rerunPassed = rerunTest.passed;
    recordTestResult(componentId, name, rerunPassed ? "pass" : "fail");
    if (rerunPassed) {
      if (flakyBefore) {
        quarantined.push(name);
      } else {
        say(`first-time failure did not reproduce on re-run, not blocking this pass, watch for a pattern: ${name}`);
      }
      continue;
    }

    real.push(name);
  }

  // F06-02 (research 06 section 4): the baseline compare. Each failing test is re-run on the unmodified code. Failed there too: already
  // broken or flaky, so not this change's doing: non-blocking, named in the result and fed to the history. Passed there every time: this
  // change broke it, and it blocks even if a re-run of the changed code would have passed.
  let preExisting: string[] | undefined;
  let baselineWhy: string | undefined;
  if (options.baseline) {
    preExisting = [];
    if (failing.length > 0) {
      const verdict = compareWithBaseline(framework, failing, testFiles, options.baseline);
      preExisting = verdict.preExisting;
      baselineWhy = verdict.unavailable;
      for (const name of preExisting) recordTestResult(componentId, name, "fail");
      real.push(...verdict.ownedByChange);
      if (preExisting.length > 0) {
        say(`failed on the unmodified code too, so not caused by this change and not blocking: ${preExisting.join(", ")}`);
      }
    }
  }

  if (real.length > 0) {
    const reason = options.baseline
      ? baselineWhy !== undefined
        ? `Test failure(s) that could not be compared with the unmodified code (${baselineWhy}), so none is forgiven: ${real.join(", ")}`
        : `Test failure(s) that pass on the unmodified code, so this change broke them: ${real.join(", ")}`
      : `Test failure(s) with a consistent (non-flaky) history: ${real.join(", ")}`;
    return { status: "fail", reason, quarantinedFailures: quarantined, isolation: isolated.isolation, discovery: discoverySummary, counts, ...(preExisting && preExisting.length > 0 ? { preExistingFailures: preExisting } : {}) };
  }
  if (quarantined.length > 0) {
    say(`quarantined flaky test(s), not blocking: ${quarantined.join(", ")}`);
  }
  const coverage = options.coverage ? coverageResult(options.coverage, framework, lcovText, plan?.notMeasured) : {};
  return { status: "pass", quarantinedFailures: quarantined, isolation: isolated.isolation, discovery: discoverySummary, counts, ...(preExisting && preExisting.length > 0 ? { preExistingFailures: preExisting } : {}), ...coverage };
}

function readAndRemove(file: string, dir?: string): string | undefined {
  try {
    return readFileSync(file, "utf-8");
  } catch {
    return undefined; // the run never wrote it (it was stopped, or the reporter is missing)
  } finally {
    try { rmSync(dir ?? file, { force: true, recursive: dir !== undefined }); } catch { /* best effort: a leftover file or folder is named .purix-cov-* and holds only line counts */ }
  }
}

export interface CoveragePlan {
  /** Where the lcov report will be (undefined: no producer could be set up, see `notMeasured`). */
  file?: string;
  /** A folder to remove with the report (Jest, Vitest and c8 write into one). */
  dir?: string;
  /** Flags added after the runner's own. */
  args: string[];
  /** A command put in front of the runner (c8 around Mocha). */
  wrap?: string[];
  notMeasured?: string;
}

/**
 * F06-04: how to get an lcov report out of each runner without changing whether the run passes. Every producer is told to ignore the
 * project's own coverage thresholds: a threshold in the project's config would turn a passing run into a failing one, and the number is only
 * read, never enforced (research 06 section 5). A runner that needs a coverage package the project does not have is not given the flags
 * (the run would fail on the missing package); the result then says why nothing was measured.
 */
export function coveragePlan(framework: TestFramework, baseDir: string): CoveragePlan {
  const stamp = `.purix-cov-${randomBytes(6).toString("hex")}`;
  if (framework === "node:test") {
    const file = resolve(baseDir, `${stamp}.lcov`);
    return { file, args: ["--experimental-test-coverage", "--test-reporter=lcov", `--test-reporter-destination=${file}`] };
  }
  const dir = resolve(baseDir, stamp);
  const file = join(dir, "lcov.info");
  if (framework === "jest") {
    return { file, dir, args: ["--coverage", "--coverageReporters=lcov", `--coverageDirectory=${dir}`, "--coverageThreshold={}"] };
  }
  if (framework === "vitest") {
    const nm = join(baseDir, "node_modules", "@vitest");
    if (!existsSync(join(nm, "coverage-v8")) && !existsSync(join(nm, "coverage-istanbul"))) {
      return { args: [], notMeasured: "vitest has no coverage package installed (@vitest/coverage-v8 or @vitest/coverage-istanbul), so line coverage was not measured" };
    }
    const off = ["lines", "functions", "branches", "statements"].map((k) => `--coverage.thresholds.${k}=0`);
    return { file, dir, args: ["--coverage.enabled=true", "--coverage.reporter=lcov", `--coverage.reportsDirectory=${dir}`, ...off] };
  }
  // mocha: no coverage of its own; c8 (Node's V8 coverage) wraps it when the project has it.
  const c8 = join(baseDir, "node_modules", ".bin", process.platform === "win32" ? "c8.cmd" : "c8");
  if (!existsSync(c8)) return { args: [], notMeasured: "mocha has no coverage tool installed (c8), so line coverage was not measured" };
  return { file, dir, args: [], wrap: [c8, "--reporter=lcov", `--report-dir=${dir}`, "--check-coverage=false"] };
}

/** F06-04: turns the lcov text of a passing run into the result fields. A missing or unreadable report is "not measured", never "covered". */
function coverageResult(
  asked: NonNullable<RunTestsOptions["coverage"]>,
  framework: TestFramework,
  lcovText: string | undefined,
  notMeasured?: string
): Pick<TestRunResult, "changedLineCoverage" | "coverageNotMeasured"> {
  if (notMeasured !== undefined) return { coverageNotMeasured: notMeasured };
  if (lcovText === undefined || lcovText.trim() === "") return { coverageNotMeasured: `the ${framework} run wrote no coverage report` };
  const ignore: Record<string, Set<number>> = {};
  for (const [file, text] of Object.entries(asked.newText ?? {})) ignore[file] = typeOnlyLines(text);
  return { changedLineCoverage: changedLineCoverage(asked.changed, parseLcov(lcovText), parseLcovBranchMisses(lcovText), ignore) };
}