// src/verify/tests.ts
//
// Runtime migration (ADR-009) & framework detection: supports executing test suites
// across Node.js (`node:test` via `tsx`), Jest, Vitest, and Mocha with isolation via `runIsolated`.
// `detectTestFramework` identifies the configured test runner, and `runTestsWithQuarantine`
// executes the tests in sandbox isolation, parsing JSON/TAP test results.
import { existsSync, realpathSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { recordTestResult, isFlaky, sampleCount, FLAKY_MIN_SAMPLES } from "../manifest/test_history.js";
import { runIsolated } from "../sandbox/sandbox_exec.js";

export interface TestRunResult {
  status: "pass" | "fail" | "no_tests" | "not_installed";
  reason?: string;
  actionHint?: string;
  quarantinedFailures: string[];
}

/**
 * Same "prefer a local binary, fall back to npx" pattern verify.ts
 * already established for tsc — tsx isn't necessarily hoisted into
 * every workspace package's own node_modules under pnpm's default
 * (non-hoisted) layout, so this checks baseDir's own node_modules/.bin
 * first before assuming a network-dependent npx fallback is needed.
 */
function tsxCommand(baseDir: string): string[] {
  const localTsx = resolve(baseDir, "node_modules/.bin/tsx");
  return existsSync(localTsx) ? [localTsx] : ["npx", "tsx"];
}

export function detectTestFramework(baseDir: string, testFiles: string[]): "jest" | "vitest" | "mocha" | "node:test" | null {
  const pkgPath = resolve(baseDir, "package.json");
  let pkg: any = {};
  if (existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    } catch {}
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

function parseJestJson(output: string): ParsedTapTest[] {
  try {
    const data = JSON.parse(output);
    const results: ParsedTapTest[] = [];
    for (const tr of data.testResults || []) {
      for (const ar of tr.assertionResults || []) {
        results.push({ name: ar.fullName || ar.title, passed: ar.status === "passed" });
      }
    }
    return results;
  } catch {
    return [];
  }
}

function parseVitestJson(output: string): ParsedTapTest[] {
  try {
    const data = JSON.parse(output);
    const results: ParsedTapTest[] = [];
    for (const file of data.testResults || []) {
      for (const assertion of file.assertionResults || []) {
        results.push({ name: assertion.fullName || assertion.title, passed: assertion.status === "passed" });
      }
    }
    return results;
  } catch {
    return [];
  }
}

function parseMochaJson(output: string): ParsedTapTest[] {
  try {
    const data = JSON.parse(output);
    const results: ParsedTapTest[] = [];
    for (const t of data.tests || []) {
      results.push({ name: t.fullTitle || t.title, passed: !t.err || Object.keys(t.err).length === 0 });
    }
    return results;
  } catch {
    return [];
  }
}

interface ParsedTapTest {
  name: string;
  passed: boolean;
}

/**
 * Parses Node's own `--test-reporter=tap` output. Deliberately not the
 * built-in `json` reporter: at this project's actual Node runtime
 * (verified directly, not assumed) `--test-reporter=json` fails to
 * resolve as a built-in reporter name, while `tap` is Node's original
 * and most stable test-runner output format.
 *
 * BUG FIX, caught by running this against a real `describe()`-wrapped
 * test file rather than assuming TAP's shape: a `describe()` block
 * indents its own tests' `(not )?ok N - name` lines, so indentation
 * alone can't tell a real per-test result apart from a describe-level
 * (or whole-file-level) rollup line — both match the same
 * `(ok|not ok) N - name` shape at different indent depths, and the
 * component test fixtures this actually runs against (drift.test.ts,
 * migration.test.ts) DO wrap their assertions in a describe() block.
 * Node's TAP output disambiguates this itself: the YAML block
 * immediately following each result line carries `type: 'test'` for a
 * real leaf test and `type: 'suite'` for any grouping level (describe
 * block or whole file) — that field, not indentation, is what this
 * scans for.
 */
function parseTapOutput(output: string): ParsedTapTest[] {
  const results: ParsedTapTest[] = [];
  const resultRe = /^\s*(ok|not ok) \d+ - (.+)$/;
  const typeRe = /^\s*type: '(\w+)'/;
  const lines = output.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const match = line.match(resultRe);
    if (!match) continue;
    const status = match[1];
    const name = match[2];
    if (status === undefined || name === undefined) continue; // regex guarantees these when match succeeds; guard is for noUncheckedIndexedAccess, not a real runtime case
    // The YAML diagnostic block, if any, starts on the very next line
    // and ends at the next "..." line — scan only that span for `type:`,
    // so a differently-indented `type:` belonging to a later, unrelated
    // block can't be mistaken for this result's own.
    let type: string | null = null;
    for (let j = i + 1; j < lines.length; j++) {
      const nextLine = lines[j];
      if (nextLine === undefined || /^\s*\.\.\.\s*$/.test(nextLine)) break;
      const typeMatch = nextLine.match(typeRe);
      if (typeMatch?.[1]) {
        type = typeMatch[1];
        break;
      }
    }
    if (type !== "test") continue; // skip suite/file/hook rollups — only real leaf tests
    results.push({ name: name.trim(), passed: status === "ok" });
  }
  return results;
}

export function runTestsWithQuarantine(
  componentId: string,
  filePaths: string[],
  baseDir: string = process.cwd()
): TestRunResult {
  const testFiles = filePaths
    .map((p) => p.replace(/\.ts$/, ".test.ts"))
    .filter((p) => existsSync(resolve(baseDir, p)));

  const framework = detectTestFramework(baseDir, testFiles);
  if (!framework) {
    return {
      status: "fail",
      reason: `no supported test framework detected in ${baseDir} — expected node:test, Jest, Vitest, or Mocha`,
      quarantinedFailures: [],
    };
  }

  if (testFiles.length === 0) {
    return { status: "no_tests", quarantinedFailures: [] };
  }

  // node_modules inside the sandbox dir is usually a symlink back to the
  // real project's node_modules (sandbox.ts sets this up) — bwrap's
  // default-deny means that symlink target needs its own explicit
  // read-only bind, or module resolution breaks inside the sandbox.
  const nodeModulesPath = join(baseDir, "node_modules");
  const extraBinds: string[] = [];
  if (existsSync(nodeModulesPath)) {
    try {
      const real = realpathSync(nodeModulesPath);
      if (real !== nodeModulesPath) extraBinds.push(real);

      // pnpm workspaces hoist the actual package content to a single
      // .pnpm content-addressable store at the WORKSPACE ROOT's
      // node_modules, not inside each package's own node_modules. A
      // package's local node_modules/<pkg> entries are themselves
      // symlinks pointing (often several `../` hops) at that root
      // store — binding only `real` above isn't enough, since the
      // store those symlinks resolve into lives outside it entirely.
      // Walk up from `real` looking for the nearest ancestor whose
      // node_modules contains a .pnpm store, and bind that too.
      let dir = dirname(real);
      for (let i = 0; i < 8; i++) {
        const candidate = join(dir, "node_modules", ".pnpm");
        if (existsSync(candidate)) {
          extraBinds.push(join(dir, "node_modules"));
          break;
        }
        const parent = dirname(dir);
        if (parent === dir) break; // reached filesystem root
        dir = parent;
      }
    } catch {
      // not a symlink, or unreadable — nothing extra to bind
    }
  }

  const tsx = tsxCommand(baseDir);
  const tapArgs = ["--test", "--test-reporter=tap", "--test-reporter-destination=stdout"];

  let runnerCmd = tsx;
  let runnerArgs = tapArgs;

  if (framework === "jest") {
    runnerCmd = ["npx", "jest"];
    runnerArgs = ["--json"];
  } else if (framework === "vitest") {
    runnerCmd = ["npx", "vitest"];
    runnerArgs = ["run", "--reporter=json"];
  } else if (framework === "mocha") {
    runnerCmd = ["npx", "mocha"];
    runnerArgs = ["--reporter", "json"];
  }

  const isolated = runIsolated([...runnerCmd, ...runnerArgs, ...testFiles], {
    cwd: baseDir,
    writableDir: baseDir,
    extraReadOnlyBinds: extraBinds,
  });

  if (isolated.isolation === "none") {
    console.warn(
      `  [sandbox] no bwrap (Linux) or sandbox-exec (macOS) found — running tests unisolated. ` +
        `Section 24's execution-isolation question is still open on this machine specifically.`
    );
  }

  let parsedTests: ParsedTapTest[] = [];
  if (framework === "jest") parsedTests = parseJestJson(isolated.stdout);
  else if (framework === "vitest") parsedTests = parseVitestJson(isolated.stdout);
  else if (framework === "mocha") parsedTests = parseMochaJson(isolated.stdout);
  else parsedTests = parseTapOutput(isolated.stdout);
  if (parsedTests.length === 0) {
    if (isolated.exitCode === 0) return { status: "pass", quarantinedFailures: [] };
    return {
      status: "fail",
      reason: isolated.stderr.trim() || isolated.stdout.trim() || "test run failed with no parseable TAP output — quarantine skipped for this run",
      quarantinedFailures: [],
    };
  }

  const quarantined: string[] = [];
  const real: string[] = [];

  for (const t of parsedTests) {
    const name = t.name;
    const passed = t.passed;
    // Capture this BEFORE recordTestResult below appends the current
    // run — this is what isFlaky's own FLAKY_MIN_SAMPLES check would
    // have seen coming in, i.e. whether isFlaky could possibly have
    // returned true for this test before now.
    const priorSamples = passed ? 0 : sampleCount(componentId, name);
    recordTestResult(componentId, name, passed ? "pass" : "fail");
    if (passed) continue;

    if (isFlaky(componentId, name)) {
      quarantined.push(name);
      continue;
    }

    // Not (yet) flaky by history — but with fewer than
    // FLAKY_MIN_SAMPLES prior samples, isFlaky couldn't have returned
    // true for this test regardless of how it actually behaves, so a
    // single failure here might just be its first occurrence catching
    // a flake rather than a real regression. One bounded, local re-run
    // (not an LLM call) before committing to "real", same sandbox
    // invocation this call is already running inside.
    if (priorSamples < FLAKY_MIN_SAMPLES) {
      const rerunArgs = framework === "node:test" ? [...runnerArgs, "--test-name-pattern", name] : runnerArgs;
      const rerun = runIsolated([...runnerCmd, ...rerunArgs, ...testFiles], {
        cwd: baseDir,
        writableDir: baseDir,
        extraReadOnlyBinds: extraBinds,
      });
      let rerunPassed = rerun.exitCode === 0;
      const rerunParsed = parseTapOutput(rerun.stdout);
      const rerunTest = rerunParsed.find((rt) => rt.name === name);
      if (rerunTest) rerunPassed = rerunTest.passed;
      recordTestResult(componentId, name, rerunPassed ? "pass" : "fail");
      if (rerunPassed) {
        console.log(`  ⚠ first-time failure did not reproduce on re-run, not blocking this pass, watch for a pattern: ${name}`);
        continue;
      }
    }

    real.push(name);
  }

  if (real.length > 0) {
    return { status: "fail", reason: `Test failure(s) with a consistent (non-flaky) history: ${real.join(", ")}`, quarantinedFailures: quarantined };
  }
  if (quarantined.length > 0) {
    console.log(`  ⚠ quarantined flaky test(s), not blocking: ${quarantined.join(", ")}`);
  }
  return { status: "pass", quarantinedFailures: quarantined };
}