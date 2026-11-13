// pythonProvider.runTests: tests are chosen by relation to the change, and "nothing ran" is reported as
// no_tests (not tested), never as a pass or as a failure of the change. pytest is stubbed here; the real
// run is covered by the manual check recorded in the session report.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pythonProvider } from "./python.js";
import { providerKitHooks } from "../provider-kit.js";
import { safeRmSync } from "../../platform/fs_retry.js";
import { placeFakeInstall } from "../../tools/test_helpers.js";

let dir: string;
const realHook = providerKitHooks.runIsolatedOrNotInstalled;
let calls: string[][];
let pytestExit = 0;
let pytestStdout = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "purix-pyrun-"));
  placeFakeInstall(dir, "pytest");
  calls = [];
  pytestExit = 0;
  pytestStdout = "";
  (providerKitHooks as any).runIsolatedOrNotInstalled = (command: string[]) => {
    calls.push(command);
    // `pytest --version` (is the tool there?) succeeds; the real run returns the configured exit code.
    return { exitCode: command.includes("--version") ? 0 : pytestExit, stdout: command.includes("--version") ? "" : pytestStdout, stderr: "pytest output", isolation: "none" };
  };
});
afterEach(() => { (providerKitHooks as any).runIsolatedOrNotInstalled = realHook; safeRmSync(dir); });

const put = (rel: string, body = "") => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), body); };
const runCalls = () => calls.filter((c) => !c.includes("--version"));

describe("pythonProvider.runTests", () => {
  it("runs only the discovered tests, not the changed source file and not the whole tree", () => {
    put("src/cart.py", "x = 1\n");
    put("tests/test_cart.py", "from src import cart\n");
    put("tests/test_unrelated.py", "def test_u(): pass\n");
    const r = pythonProvider.runTests("c", ["src/cart.py"], dir);
    expect(r.status).toBe("pass");
    expect(runCalls()).toHaveLength(1);
    expect(runCalls()[0]!.slice(1)).toEqual(["tests/test_cart.py"]);
    expect(r.discovery).toEqual({ tests: ["tests/test_cart.py"], uncovered: [], truncated: false });
  });

  it("reports no_tests, with the uncovered file, and never starts pytest when nothing is related", () => {
    put("src/cart.py", "x = 1\n");
    put("tests/test_other.py", "def test_o(): pass\n");
    const r = pythonProvider.runTests("c", ["src/cart.py"], dir);
    expect(r.status).toBe("no_tests");
    expect(r.reason).toMatch(/no test covers src\/cart\.py/);
    expect(r.discovery?.uncovered).toEqual(["src/cart.py"]);
    expect(runCalls()).toHaveLength(0);
  });

  it("a failing test is a fail, with the discovery attached", () => {
    put("src/cart.py", "x = 1\n");
    put("tests/test_cart.py", "from src import cart\n");
    pytestExit = 1;
    const r = pythonProvider.runTests("c", ["src/cart.py"], dir);
    expect(r.status).toBe("fail");
    expect(r.reason).toBe("pytest output");
    expect(r.discovery?.tests).toEqual(["tests/test_cart.py"]);
  });

  it("pytest exit code 5 (no tests collected) is not tested, not a failure of the change", () => {
    put("src/cart.py", "x = 1\n");
    put("tests/test_cart.py", "from src import cart\n"); // imports it, but holds no test functions
    pytestExit = 5;
    const r = pythonProvider.runTests("c", ["src/cart.py"], dir);
    expect(r.status).toBe("no_tests");
    expect(r.discovery?.uncovered).toEqual(["src/cart.py"]);
  });
});

// A6-1 (research 06, the count rule): pytest exits 0 when every test is skipped, so the exit code alone read as a pass.
describe("pythonProvider.runTests: the count rule", () => {
  const related = () => { put("src/cart.py", "x = 1\n"); put("tests/test_cart.py", "from src import cart\n"); };

  it("exit 0 with every test skipped is NOT TESTED, with the changed file named as uncovered", () => {
    related();
    pytestStdout = "ss\n2 skipped in 0.01s\n";
    const r = pythonProvider.runTests("c", ["src/cart.py"], dir);
    expect(r.status).toBe("no_tests");
    expect(r.notRun).toBe("all_skipped");
    expect(r.counts).toEqual({ passed: 0, failed: 0, skipped: 2 });
    expect(r.discovery?.uncovered).toEqual(["src/cart.py"]);
    expect(r.reason).toMatch(/no test ran/i);
  });
  it("exit 0 with only expected failures (xfail) is NOT TESTED: an expected failure proves nothing", () => {
    related();
    pytestStdout = "x\n1 xfailed in 0.01s\n";
    expect(pythonProvider.runTests("c", ["src/cart.py"], dir).status).toBe("no_tests");
  });
  it("one passed test among skipped ones is a pass that says how many it does not rest on", () => {
    related();
    pytestStdout = ".s\n1 passed, 1 skipped in 0.01s\n";
    const r = pythonProvider.runTests("c", ["src/cart.py"], dir);
    expect(r.status).toBe("pass");
    expect(r.counts).toEqual({ passed: 1, failed: 0, skipped: 1 });
  });
  it("with no readable summary line it does not guess: exit 0 stays a pass, without counts", () => {
    related();
    pytestStdout = "something else entirely\n";
    const r = pythonProvider.runTests("c", ["src/cart.py"], dir);
    expect(r.status).toBe("pass");
    expect(r.counts).toBeUndefined();
  });
});

describe("pythonProvider.findRelatedTests", () => {
  it("is the same discovery the verifier uses", () => {
    put("a.py", "x = 1\n");
    put("test_a.py", "import a\n");
    expect(pythonProvider.findRelatedTests!(["a.py"], dir).tests).toEqual(["test_a.py"]);
  });
});
