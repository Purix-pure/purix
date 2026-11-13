// src/verify/stopped_runs.test.ts
//
// F02-03 (research 02, finding 3; re-checked 2026-11-07 as "partly fixed"): spawn_sync already stops a run that goes past its deadline or
// prints past its output cap and says so with `stopped`. runIsolated dropped that marker, so a test run or compile that overflowed or
// timed out came back as exitCode null and was reported as a failure of the code (or, for Python, as "not installed").
//
// What is proved here: the marker survives runIsolated; a real node:test run that floods its output is an infrastructure result with the
// kind "output_limit" and is not repairable; a hang is NOT labelled as infrastructure (new code can loop forever, so the repair loop
// must still compare with the original, see recovery/resolve_verification.ts) but its words say it timed out; a missing binary is still
// "not installed" and a timeout is no longer called that. Linux, real child processes, no real bwrap on this machine.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIsolated } from "../sandbox/sandbox_exec.js";
import { runToolIsolated } from "../sandbox/tool_run.js";
import { runIsolatedOrNotInstalled } from "../language/provider-kit.js";
import { failureOfStoppedRun, isRepairEligibleKind } from "./outcome.js";
import { isUnlabelledTimeout, infrastructureStopOf } from "../recovery/infrastructure_stop.js";
import { runTestsWithQuarantine } from "./tests.js";
import { closeDb } from "../manifest/store.js";
import { resolveRealNodeModules } from "../test-support/real_node_modules.js";
import { safeRmSync } from "../platform/fs_retry.js";

const unix = { skip: process.platform === "win32" ? "needs a POSIX shell" : false };
const HANG = ["node", "-e", "setTimeout(()=>{}, 8000)"];
const FLOOD = (bytes: number) => ["node", "-e", `process.stdout.write("x".repeat(${bytes}))`];

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "purix-stopped-")));
});
afterEach(() => {
  closeDb();
  safeRmSync(dir);
});

describe("runIsolated keeps the stop marker", unix, () => {
  it("reports a timeout as stopped: timeout", () => {
    const r = runIsolated(HANG, { cwd: dir, writableDir: dir, deadlineMs: 300 });
    expect(r.exitCode).toBeNull();
    expect(r.stopped).toBe("timeout");
  });
  it("reports an output overflow as stopped: output_limit", () => {
    const r = runIsolated(FLOOD(5000), { cwd: dir, writableDir: dir, maxOutputBytes: 1000 });
    expect(r.stopped).toBe("output_limit");
  });
  it("a normal exit, even a failing one, has no stop marker", () => {
    const r = runIsolated(["node", "-e", "process.exit(3)"], { cwd: dir, writableDir: dir });
    expect(r.exitCode).toBe(3);
    expect(r.stopped).toBeUndefined();
  });
});

describe("a stopped run is worded and labelled by what stopped it", () => {
  it("an output overflow is infrastructure: not repairable, says it is not the code", () => {
    const f = failureOfStoppedRun({ stopped: "output_limit" }, "The TypeScript check");
    expect(f?.infrastructure).toBe("output_limit");
    expect(f?.reason).toContain("not a failure of your code");
  });
  it("a timeout is NOT labelled infrastructure, because new code can hang; its words still say it timed out", () => {
    const f = failureOfStoppedRun({ stopped: "timeout" }, "The test run");
    expect(f?.infrastructure).toBeUndefined();
    expect(f?.reason).toMatch(/timed out/);
    expect(f?.reason).not.toMatch(/not a failure of your code/);
    // The repair loop's existing rule for an ambiguous timeout picks it up and confirms against the original code first.
    expect(isUnlabelledTimeout({ status: "fail", reason: f!.reason })).toBe(true);
    expect(infrastructureStopOf({ status: "fail", reason: f!.reason })).toBeUndefined();
  });
  it("a normal exit gives nothing", () => {
    expect(failureOfStoppedRun({}, "x")).toBeUndefined();
  });
  it("only a code failure is repair-eligible", () => {
    expect(isRepairEligibleKind("infrastructure")).toBe(false);
  });
});

describe("runToolIsolated (tsc, ESLint)", unix, () => {
  it("an output overflow is an infrastructure result, not a run whose exit code was null", () => {
    const r = runToolIsolated(FLOOD(2 * 1024 * 1024), dir, { what: "The TypeScript check" });
    expect(r.kind).toBe("infrastructure");
    if (r.kind === "infrastructure") {
      expect(r.infrastructure).toBe("output_limit");
      expect(r.reason).toContain("The TypeScript check");
    }
  });
  it("a normal failing exit is still a run", () => {
    const r = runToolIsolated(["node", "-e", "process.exit(2)"], dir, { what: "The TypeScript check" });
    expect(r.kind).toBe("ran");
  });
});

describe("runIsolatedOrNotInstalled (Python providers)", unix, () => {
  it("a missing program is still 'not installed'", () => {
    const r = runIsolatedOrNotInstalled(["purix-definitely-not-a-program"], { cwd: dir, writableDir: dir });
    expect(r).toEqual({ status: "not_installed" });
  });
  it("a timeout is no longer called 'not installed'", () => {
    const r = runIsolatedOrNotInstalled(HANG, { cwd: dir, writableDir: dir, deadlineMs: 300 });
    expect("status" in r).toBe(false);
    expect((r as { stopped?: string }).stopped).toBe("timeout");
  });
});

const realModules = resolveRealNodeModules("tsx");
describe("runTestsWithQuarantine, a run whose report floods the output", { skip: realModules ? false : "no node_modules with tsx found" }, () => {
  it("is an infrastructure result with kind output_limit, never a plain code failure", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p", type: "module", devDependencies: { "@types/node": "*" } }));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    symlinkSync(realModules!, join(dir, "node_modules"), "junction");
    writeFileSync(
      join(dir, "src", "a.test.ts"),
      // The runner's own report is what grows: a test's stdout is swallowed by the node:test reporter, but every test is a line of the
      // report, so thousands of long-named tests push the report past the 1 MiB cap.
      `import { test } from "node:test";\nfor (let i = 0; i < 3000; i++) test("t" + i + "x".repeat(1000), () => {});\n`,
    );
    const log = console.log;
    const warn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    try {
      const r = runTestsWithQuarantine("comp-flood", ["src/a.ts"], dir);
      expect(r.status).toBe("fail");
      expect(r.infrastructure).toBe("output_limit");
      expect(r.reason).toContain("not a failure of your code");
    } finally {
      console.log = log;
      console.warn = warn;
    }
  });
});
