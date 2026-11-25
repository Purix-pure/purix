// pythonProvider.runTests with `coverage` asked for (F06-04, the Python producer). pytest is stubbed: what is checked is which flags are
// added, that nothing is added when pytest-cov is missing (the run would fail on an unknown option), that coverage can never change
// whether a run passes, and that a missing report reads "not measured", never "covered". The real tools are covered by
// python_coverage.real.test.ts, which skips itself when pytest and pytest-cov are not installed.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pythonProvider } from "./python.js";
import { providerKitHooks } from "../provider-kit.js";
import { safeRmSync } from "../../platform/fs_retry.js";
import { placeFakeInstall } from "../../tools/test_helpers.js";

let dir: string;
const realHook = providerKitHooks.runIsolatedOrNotInstalled;
let calls: { command: string[]; env?: Record<string, string> }[];
let pluginsText = "";
let reportText: string | null = null;
let probeExit = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "purix-pycov-"));
  placeFakeInstall(dir, "pytest");
  calls = [];
  pluginsText = "pytest 9.2.0\nregistered third-party plugins:\n  pytest-cov-7.1.0 at /x/plugin.py\n";
  reportText = null;
  probeExit = 0;
  (providerKitHooks as any).runIsolatedOrNotInstalled = (command: string[], opts: { env?: Record<string, string> }) => {
    calls.push({ command, env: opts?.env });
    if (command.includes("--version")) {
      // `pytest --version` (is the tool there?) has one --version; the plugin probe has two.
      const probe = command.filter((c) => c === "--version").length === 2;
      return { exitCode: probe ? probeExit : 0, stdout: "", stderr: probe ? pluginsText : "pytest 9.2.0", isolation: "none" };
    }
    const flag = command.find((c) => c.startsWith("--cov-report=lcov:"));
    if (flag && reportText !== null) {
      const file = flag.slice("--cov-report=lcov:".length);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, reportText);
    }
    return { exitCode: 0, stdout: "1 passed in 0.01s\n", stderr: "", isolation: "none" };
  };
});
afterEach(() => { (providerKitHooks as any).runIsolatedOrNotInstalled = realHook; safeRmSync(dir); });

const put = (rel: string, body = "") => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), body); };
const realRun = () => calls.find((c) => !c.command.includes("--version"))!;
const covFolders = () => readdirSync(dir).filter((n) => n.startsWith(".purix-cov-"));
const setup = () => { put("src/cart.py", "x = 1\n"); put("tests/test_cart.py", "from src import cart\n"); };
const LCOV = "SF:src/cart.py\nDA:1,1\nDA:2,1\nDA:3,0\nDA:4,1\nBRDA:4,0,jump to line 5,0\nBRDA:4,0,jump to line 6,1\nend_of_record\n";

describe("pythonProvider.runTests: changed-line coverage", () => {
  it("adds the coverage flags when pytest-cov is installed, and overrides every project threshold", () => {
    setup();
    reportText = LCOV;
    const r = pythonProvider.runTests("c", ["src/cart.py"], dir, { coverage: { changed: { "src/cart.py": [2, 3, 4] } } });
    expect(r.status).toBe("pass");
    const run = realRun().command;
    expect(run).toEqual(expect.arrayContaining(["--cov=.", "--cov-branch", "--cov-fail-under=0"]));
    expect(run.some((a) => a.startsWith("--cov-report=lcov:"))).toBe(true);
    expect(run).toContain("tests/test_cart.py");
    expect(realRun().env?.COVERAGE_FILE).toMatch(/\.purix-cov-[0-9a-f]+/);
  });

  it("reads the report: lines no test ran are uncovered, a branch taken one way is partial, and the numbers add up", () => {
    setup();
    reportText = LCOV;
    const r = pythonProvider.runTests("c", ["src/cart.py"], dir, { coverage: { changed: { "src/cart.py": [2, 3, 4] } } });
    const c = r.changedLineCoverage!;
    expect(c.perFile["src/cart.py"]!.executable).toEqual([2, 3, 4]);
    expect(c.perFile["src/cart.py"]!.uncovered).toEqual([3]);
    expect(c.perFile["src/cart.py"]!.partial).toEqual([4]);
    expect(c.total).toBe(3);
    expect(c.covered).toBe(1);
    expect(r.coverageNotMeasured).toBeUndefined();
  });

  it("a changed file the report does not name is not measured, never covered", () => {
    setup();
    reportText = LCOV;
    const r = pythonProvider.runTests("c", ["src/cart.py"], dir, { coverage: { changed: { "src/other.py": [1] } } });
    expect(r.changedLineCoverage!.notMeasured).toEqual(["src/other.py"]);
    expect(r.changedLineCoverage!.ratio).toBeUndefined();
  });

  it("without pytest-cov nothing is added, the run is unchanged, and the result says why there is no figure", () => {
    setup();
    pluginsText = "pytest 9.2.0\nregistered third-party plugins:\n  pytest-xdist-3.0 at /x/y.py\n";
    const r = pythonProvider.runTests("c", ["src/cart.py"], dir, { coverage: { changed: { "src/cart.py": [1] } } });
    expect(r.status).toBe("pass");
    expect(realRun().command.some((a) => a.startsWith("--cov"))).toBe(false);
    expect(r.changedLineCoverage).toBeUndefined();
    expect(r.coverageNotMeasured).toMatch(/pytest-cov is not installed/);
    expect(covFolders()).toEqual([]);
  });

  it("a plugin probe that fails is 'not measured' and adds nothing", () => {
    setup();
    probeExit = 2;
    const r = pythonProvider.runTests("c", ["src/cart.py"], dir, { coverage: { changed: { "src/cart.py": [1] } } });
    expect(r.status).toBe("pass");
    expect(realRun().command.some((a) => a.startsWith("--cov"))).toBe(false);
    expect(r.coverageNotMeasured).toMatch(/could not ask pytest/);
  });

  it("a run that wrote no report is 'not measured', still a pass", () => {
    setup();
    reportText = null;
    const r = pythonProvider.runTests("c", ["src/cart.py"], dir, { coverage: { changed: { "src/cart.py": [1] } } });
    expect(r.status).toBe("pass");
    expect(r.coverageNotMeasured).toMatch(/wrote no coverage report/);
  });

  it("removes its folder on every path", () => {
    setup();
    reportText = LCOV;
    pythonProvider.runTests("c", ["src/cart.py"], dir, { coverage: { changed: { "src/cart.py": [1] } } });
    expect(covFolders()).toEqual([]);
    reportText = null;
    pythonProvider.runTests("c", ["src/cart.py"], dir, { coverage: { changed: { "src/cart.py": [1] } } });
    expect(covFolders()).toEqual([]);
    expect(existsSync(join(dir, ".coverage"))).toBe(false);
  });

  it("does nothing extra when coverage is not asked for: no probe, no flags", () => {
    setup();
    const r = pythonProvider.runTests("c", ["src/cart.py"], dir);
    expect(r.status).toBe("pass");
    expect(calls.filter((c) => c.command.filter((a) => a === "--version").length === 2)).toHaveLength(0);
    expect(realRun().command.some((a) => a.startsWith("--cov"))).toBe(false);
    expect(r.changedLineCoverage).toBeUndefined();
    expect(r.coverageNotMeasured).toBeUndefined();
  });

  it("never asks for coverage of a run that has no tests", () => {
    put("src/cart.py", "x = 1\n");
    put("tests/test_other.py", "def test_o(): pass\n");
    const r = pythonProvider.runTests("c", ["src/cart.py"], dir, { coverage: { changed: { "src/cart.py": [1] } } });
    expect(r.status).toBe("no_tests");
    expect(calls.filter((c) => c.command.filter((a) => a === "--version").length === 2)).toHaveLength(0);
  });
});
