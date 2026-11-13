// A6-1: runTestsWithQuarantine end to end for Jest, Vitest and Mocha, without installing them. A stub executable stands in for the
// runner and replays the REAL stdout and exit code captured from Jest 29.7.0, Vitest 4.1.12 and Mocha 12.0.3
// (test_fixtures/runner_output/), so what is under test is Purix's reading of what those runners really print.
//
// What this adds over tests_run.test.ts (node:test only): node:test reports a skip as a pass, so only these three runners ever
// hand the failure path a skipped test. Without the guard, a skipped test was re-run and "forgiven" by the re-run's exit code.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../manifest/store";
import { runTestsWithQuarantine } from "./tests";
import { safeRmSync } from "../platform/fs_retry.js";

const FIXTURES = join(import.meta.dirname, "test_fixtures", "runner_output");
const skip = process.platform === "win32" ? "the stub runner is a shebang script" : false;

let cwd: string;
let dir: string;
let counter: string;
let logs: string[];
let log: typeof console.log;
let warn: typeof console.warn;

beforeEach(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "purix-stub-runner-"));
  counter = join(dir, "runner-calls.txt");
  process.chdir(dir);
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.js"), "exports.a = 1;\n");
  writeFileSync(join(dir, "src", "a.test.js"), "// the stub runner never reads this\n");
  logs = [];
  log = console.log;
  warn = console.warn;
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  console.warn = () => {};
});
afterEach(() => {
  console.log = log;
  console.warn = warn;
  closeDb();
  process.chdir(cwd);
  safeRmSync(dir);
});

/** A project whose `fw` runner is a stub that replays a captured run and counts how many times it was started. */
function stubRunner(fw: "jest" | "vitest" | "mocha", captured: string): void {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p", devDependencies: { [fw]: "*" } }));
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  const bin = join(dir, "node_modules", ".bin", fw);
  writeFileSync(
    bin,
    `#!/usr/bin/env node\nconst fs = require("node:fs");\nfs.appendFileSync(${JSON.stringify(counter)}, "x");\nconst f = JSON.parse(fs.readFileSync(${JSON.stringify(join(FIXTURES, `${fw}.${captured}.json`))}, "utf8"));\nprocess.stdout.write(f.stdout);\nprocess.exit(f.exitCode);\n`,
  );
  chmodSync(bin, 0o755);
}
const started = (): number => (existsSync(counter) ? readFileSync(counter, "utf8").length : 0);

for (const fw of ["jest", "vitest", "mocha"] as const) {
  describe(`runTestsWithQuarantine with a stubbed ${fw} replaying real output`, { skip }, () => {
    it("a passing run passes", () => {
      stubRunner(fw, "passed");
      const r = runTestsWithQuarantine(`stub-${fw}-pass`, ["src/a.js"], dir);
      expect(r.status).toBe("pass");
      expect(r.counts).toEqual({ passed: 1, failed: 0, skipped: 0 });
    });
    it("a failing run fails, naming the test", () => {
      stubRunner(fw, "failed");
      const r = runTestsWithQuarantine(`stub-${fw}-fail`, ["src/a.js"], dir);
      expect(r.status).toBe("fail");
      expect(r.reason).toContain("broken");
    });
    it("every test skipped or todo is NOT TESTED, whatever the exit code (0) said", () => {
      stubRunner(fw, "all-skipped");
      const r = runTestsWithQuarantine(`stub-${fw}-skipped`, ["src/a.js"], dir);
      expect(r.status).toBe("no_tests");
      expect(r.notRun).toBe("all_skipped");
      expect(r.discovery?.uncovered).toEqual(["src/a.js"]);
    });
    it("only todo entries is NOT TESTED", () => {
      stubRunner(fw, "todo-only");
      expect(runTestsWithQuarantine(`stub-${fw}-todo`, ["src/a.js"], dir).notRun).toBe("all_skipped");
    });
    it("one pass among skipped and todo entries passes, says what it does not rest on, and never re-runs a skipped test", () => {
      stubRunner(fw, "mixed");
      const r = runTestsWithQuarantine(`stub-${fw}-mixed`, ["src/a.js"], dir);
      expect(r.status).toBe("pass");
      expect(r.counts).toEqual({ passed: 1, failed: 0, skipped: 2 });
      // The guard: a skipped test used to enter the failure path, be re-run (a second start of the runner) and be forgiven.
      expect(started()).toBe(1);
      expect(logs.filter((l) => l.includes("did not reproduce"))).toEqual([]);
    });
    it("a run that reports no tests and exits 0 would be NOT TESTED; one that crashed with the runner's own error stays a failure", () => {
      stubRunner(fw, "no-tests");
      const r = runTestsWithQuarantine(`stub-${fw}-none`, ["src/a.js"], dir);
      // Mocha exits 0 here (nothing to run), Jest and Vitest exit 1 ("suite failed to run"): the exit code splits them, and a
      // non-zero exit with nothing countable is not decided by the count rule (it could be a syntax error).
      expect(r.status).toBe(fw === "mocha" ? "no_tests" : "fail");
      if (fw === "mocha") expect(r.notRun).toBe("no_tests_ran");
    });
  });
}

describe("a runner whose JSON no longer reaches stdout (Vitest 5 writes it to a file)", { skip }, () => {
  it("exit 0 with an empty report is NOT TESTED, never a silent pass", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p", devDependencies: { vitest: "*" } }));
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    const bin = join(dir, "node_modules", ".bin", "vitest");
    writeFileSync(bin, "#!/usr/bin/env node\nprocess.exit(0);\n");
    chmodSync(bin, 0o755);
    const r = runTestsWithQuarantine("stub-vitest5", ["src/a.js"], dir);
    expect(r.status).toBe("no_tests");
    expect(r.notRun).toBe("no_tests_ran");
  });
});
