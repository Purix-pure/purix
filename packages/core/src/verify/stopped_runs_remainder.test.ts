// src/verify/stopped_runs_remainder.test.ts
//
// N3 (plan 2026-11-07, finding F02-03 remainder). stopped_runs.test.ts covers a run stopped for time or output. Two cases were left:
//   1. A child ended by a SIGNAL (kill -9, an out-of-memory kill) comes back from spawnSync as exitCode null with no `stopped` marker,
//      so every caller read it as an ordinary failing exit.
//   2. The dependents re-check (verify/impact.ts) kept only the reason text of a stopped run, so a dependent whose test run overflowed
//      its output was reported as "now FAILS verification" and its manifest status was written as "fail".
//
// Linux, real child processes. Not covered: real bwrap or sandbox-exec (neither is on this machine), so a signal that kills the
// program INSIDE a sandbox, and how bwrap reports it, is not shown here. Only a signal that ends the direct child is.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "../platform/spawn_sync.js";
import { runIsolated } from "../sandbox/sandbox_exec.js";
import { runToolIsolated } from "../sandbox/tool_run.js";
import { failureOfStoppedRun, infrastructureResultOfSpawn } from "./outcome.js";
import { isUnlabelledTimeout, infrastructureStopOf } from "../recovery/infrastructure_stop.js";
import { reVerifyDependents } from "./impact.js";
import { reVerifyCascadeDependents } from "../manifest/commit_and_cascade.js";
import { typescriptProvider } from "../language/providers/typescript.js";
import { closeDb, writeManifest, readManifest } from "../manifest/store.js";
import type { ManifestEntry } from "../manifest/schema.js";
import { resolveRealNodeModules } from "../test-support/real_node_modules.js";
import { safeRmSync } from "../platform/fs_retry.js";

const unix = { skip: process.platform === "win32" ? "needs a POSIX shell" : false };
const SELF_KILL = ["sh", "-c", "kill -9 $$"];

let dir: string;
let originalCwd: string;
beforeEach(() => {
  originalCwd = process.cwd();
  dir = realpathSync(mkdtempSync(join(tmpdir(), "purix-stopped2-")));
});
afterEach(() => {
  closeDb();
  process.chdir(originalCwd);
  safeRmSync(dir);
});

describe("a child ended by a signal is a stopped run", unix, () => {
  it("spawnSync marks it stopped: signal and says which signal", () => {
    const r = spawnSync(SELF_KILL);
    expect(r.exitCode).toBeNull();
    expect(r.stopped).toBe("signal");
    expect((r as { signal?: string }).signal).toBe("SIGKILL");
  });
  it("a normal exit, even a failing one, still has no marker", () => {
    const r = spawnSync(["sh", "-c", "exit 3"]);
    expect(r.exitCode).toBe(3);
    expect(r.stopped).toBeUndefined();
  });
  it("a timeout is still a timeout, not a signal (the deadline kills with SIGKILL too)", () => {
    const r = spawnSync(["node", "-e", "setTimeout(()=>{}, 8000)"], { deadlineMs: 300 });
    expect(r.stopped).toBe("timeout");
  });
  it("the marker survives runIsolated", () => {
    const r = runIsolated(SELF_KILL, { cwd: dir, writableDir: dir });
    expect(r.exitCode).toBeNull();
    expect(r.stopped).toBe("signal");
  });
});

describe("how a signal stop is worded and labelled", () => {
  it("is not labelled infrastructure: Purix cannot tell an outside kill from code that killed itself, and says so", () => {
    const f = failureOfStoppedRun({ stopped: "signal" }, "The test run");
    expect(f).toBeDefined();
    expect(f!.infrastructure).toBeUndefined();
    expect(f!.reason).toMatch(/ended by a signal/);
    expect(f!.reason).toMatch(/cannot tell/);
    expect(f!.reason).not.toMatch(/not a failure of your code/);
  });
  it("has no infrastructure result of its own (no kind was observed for it)", () => {
    expect(infrastructureResultOfSpawn({ stopped: "signal" }, "x")).toBeUndefined();
  });
  it("the repair loop's stop rules do not read it as a timeout or as infrastructure", () => {
    const f = failureOfStoppedRun({ stopped: "signal" }, "The test run")!;
    expect(isUnlabelledTimeout({ status: "fail", reason: f.reason })).toBe(false);
    expect(infrastructureStopOf({ status: "fail", reason: f.reason })).toBeUndefined();
  });
  it("runToolIsolated gives a stopped result with those words, not a run with exit code null", () => {
    const r = runToolIsolated(SELF_KILL, dir, { what: "The TypeScript check" });
    expect(r.kind).not.toBe("ran");
    if (r.kind !== "ran" && r.kind !== "infrastructure") expect(r.reason).toMatch(/ended by a signal/);
  });
});

// ---- the dependents check ---------------------------------------------------------------------------------------------------------
const original = { verify: typescriptProvider.verify.bind(typescriptProvider), runTests: typescriptProvider.runTests.bind(typescriptProvider) };
afterEach(() => {
  typescriptProvider.verify = original.verify;
  typescriptProvider.runTests = original.runTests;
});

function dependentEntry(status: ManifestEntry["verification_status"]): ManifestEntry {
  return {
    component_id: "dep",
    component_type: "module",
    current_version: 1,
    schema_version: 5,
    parts: { tools: [], config: {} },
    files: ["src/dep.ts"],
    depends_on: [],
    depended_on_by: [],
    version_history: [],
    verification_status: status,
    last_synced_hash: "x",
  };
}

function project(): void {
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "dep.ts"), "export const d = 1;\n");
  process.chdir(dir);
  writeManifest(dependentEntry("pass"));
}

describe("the dependents re-check (verify/impact.ts)", unix, () => {
  it("a test run stopped at its output limit is infrastructure: not a failure of the dependent, and its status is not rewritten to fail", () => {
    project();
    typescriptProvider.verify = () => ({ status: "pass", isolation: "none" });
    typescriptProvider.runTests = () => ({
      status: "fail",
      reason: "The vitest test run was stopped because it printed more than its output limit. This is not a failure of your code.",
      infrastructure: "output_limit",
      quarantinedFailures: [],
    });
    const [c] = reVerifyDependents([{ component_id: "dep", files: ["src/dep.ts"] }], dir);
    expect(c!.infrastructure).toBe("output_limit");
    expect(c!.status).not.toBe("pass");
    expect(readManifest("dep")!.verification_status).toBe("pass");
  });

  it("a compile stopped for a resource limit is infrastructure too", () => {
    project();
    typescriptProvider.verify = () => ({ status: "fail", reason: "The TypeScript check could not run because the machine was out of a resource.", infrastructure: "resource_limit" });
    const [c] = reVerifyDependents([{ component_id: "dep", files: ["src/dep.ts"] }], dir);
    expect(c!.infrastructure).toBe("resource_limit");
    expect(readManifest("dep")!.verification_status).toBe("pass");
  });

  it("a missing test tool is infrastructure (not_installed), by the repo's own mapping of that status", () => {
    project();
    typescriptProvider.verify = () => ({ status: "pass", isolation: "none" });
    typescriptProvider.runTests = () => ({ status: "not_installed", reason: "vitest is not installed", quarantinedFailures: [] });
    const [c] = reVerifyDependents([{ component_id: "dep", files: ["src/dep.ts"] }], dir);
    expect(c!.infrastructure).toBe("not_installed");
    expect(readManifest("dep")!.verification_status).toBe("pass");
  });

  it("a real failing test is still a failure of the dependent and is still written as fail (control)", () => {
    project();
    typescriptProvider.verify = () => ({ status: "pass", isolation: "none" });
    typescriptProvider.runTests = () => ({ status: "fail", reason: "1 test failed: dep.test.ts", quarantinedFailures: [] });
    const [c] = reVerifyDependents([{ component_id: "dep", files: ["src/dep.ts"] }], dir);
    expect(c!.status).toBe("fail");
    expect(c!.infrastructure).toBeUndefined();
    expect(readManifest("dep")!.verification_status).toBe("fail");
  });

  it("a timeout stays unlabelled on purpose (new code can hang): still a failure with its own words (control)", () => {
    project();
    typescriptProvider.verify = () => ({ status: "pass", isolation: "none" });
    typescriptProvider.runTests = () => ({ status: "fail", reason: "The vitest test run timed out: it was stopped after it ran past its time limit.", quarantinedFailures: [] });
    const [c] = reVerifyDependents([{ component_id: "dep", files: ["src/dep.ts"] }], dir);
    expect(c!.status).toBe("fail");
    expect(c!.infrastructure).toBeUndefined();
  });
});

describe("what the person is told about a dependent that could not be re-checked", unix, () => {
  it("says 'could not be re-verified', not 'FAILS', for infrastructure; a real failure still says it failed", () => {
    project();
    typescriptProvider.verify = () => ({ status: "pass", isolation: "none" });
    typescriptProvider.runTests = () => ({ status: "fail", reason: "The vitest test run was stopped because it printed more than its output limit.", infrastructure: "output_limit", quarantinedFailures: [] });
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => lines.push(a.join(" "));
    try {
      reVerifyCascadeDependents({ ...dependentEntry("pass"), component_id: "root", files: [], depended_on_by: ["dep"] }, dir);
      typescriptProvider.runTests = () => ({ status: "fail", reason: "1 test failed", quarantinedFailures: [] });
      reVerifyCascadeDependents({ ...dependentEntry("pass"), component_id: "root", files: [], depended_on_by: ["dep"] }, dir);
    } finally {
      console.log = log;
    }
    const text = lines.join("\n");
    expect(text).toMatch(/dep: could not be re-verified \(not a failure of the dependent\)/);
    expect(text).toMatch(/❌ dep: 1 test failed/);
  });
});

const realModules = resolveRealNodeModules("tsx");
describe("the dependents re-check with the REAL test runner flooding its report", { skip: realModules ? false : "no node_modules with tsx found" }, () => {
  it("reaches the cascade result as infrastructure output_limit", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p", type: "module", devDependencies: { "@types/node": "*" } }));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "dep.ts"), "export const d = 1;\n");
    symlinkSync(realModules!, join(dir, "node_modules"), "junction");
    writeFileSync(join(dir, "src", "dep.test.ts"), `import { test } from "node:test";\nfor (let i = 0; i < 3000; i++) test("t" + i + "x".repeat(1000), () => {});\n`);
    process.chdir(dir);
    writeManifest(dependentEntry("pass"));
    // Only the compiler is stubbed (a real tsc run is not what is under test); the test run is the real one.
    typescriptProvider.verify = () => ({ status: "pass", isolation: "none" });
    const log = console.log;
    const warn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    try {
      const [c] = reVerifyDependents([{ component_id: "dep", files: ["src/dep.ts"] }], dir);
      expect(c!.infrastructure).toBe("output_limit");
      expect(readManifest("dep")!.verification_status).toBe("pass");
    } finally {
      console.log = log;
      console.warn = warn;
    }
  });
});
