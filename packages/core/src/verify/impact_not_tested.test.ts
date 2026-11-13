// src/verify/impact_not_tested.test.ts
//
// C3 item 1 (plan v4), the "dependents re-check" part: after a contract-changing commit each dependent is re-verified, and the line was a bare
// "✅ name" even when no test covered the dependent. Its verification_pass event also carried no not_tested, so (like the MCP ingest event,
// D-c) it ERASED the record of the dependent's untested files, because `purix check`, status and evidence read the latest pass only.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reVerifyDependents } from "./impact.js";
import { typescriptProvider } from "../language/providers/typescript.js";
import { closeDb } from "../manifest/store.js";
import { listEvents } from "../manifest/events.js";
import { latestNotTestedByComponent, latestSearchCutByComponent } from "../manifest/not_tested.js";
import { safeRmSync } from "../platform/fs_retry.js";

let dir: string;
let prevCwd: string;
let stateDir: string;
const original = { verify: typescriptProvider.verify.bind(typescriptProvider), runTests: typescriptProvider.runTests.bind(typescriptProvider) };
let nextTestResult: ReturnType<typeof typescriptProvider.runTests>;

beforeEach(() => {
  prevCwd = process.cwd();
  stateDir = mkdtempSync(join(tmpdir(), "purix-cascade-nt-state-"));
  process.chdir(stateDir);
  dir = mkdtempSync(join(tmpdir(), "purix-cascade-nt-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "dep.ts"), "export const d = 1;\n");
  typescriptProvider.verify = () => ({ status: "pass", isolation: "none" });
  typescriptProvider.runTests = () => nextTestResult;
});
afterEach(() => {
  typescriptProvider.verify = original.verify;
  typescriptProvider.runTests = original.runTests;
  closeDb();
  process.chdir(prevCwd);
  safeRmSync(dir);
  safeRmSync(stateDir);
});

const DEP = [{ component_id: "dep", files: ["src/dep.ts"] }];

describe("dependents re-check keeps 'not tested' on the record and in the result", () => {
  it("no test covers the dependent: result and event both say not tested", () => {
    nextTestResult = { status: "no_tests", quarantinedFailures: [], discovery: { tests: [], uncovered: ["src/dep.ts"], truncated: false } };
    const [r] = reVerifyDependents(DEP, dir);
    expect(r!.status).toBe("pass");
    expect(r!.notTested).toEqual(["src/dep.ts"]);
    expect(r!.testSearchCut).toBeUndefined();
    const ev = listEvents({ kind: "verification_pass" }).filter((e) => e.component_id === "dep");
    expect(ev[ev.length - 1]!.detail.not_tested).toEqual(["src/dep.ts"]);
    expect([...latestNotTestedByComponent().keys()]).toEqual(["dep"]);
  });

  it("a test ran and covered it: nothing is reported as untested", () => {
    nextTestResult = { status: "pass", quarantinedFailures: [], discovery: { tests: ["src/dep.test.ts"], uncovered: [], truncated: false } };
    const [r] = reVerifyDependents(DEP, dir);
    expect(r!.status).toBe("pass");
    expect(r!.notTested).toBeUndefined();
    expect(latestNotTestedByComponent().size).toBe(0);
  });

  it("the search for tests was cut off: the result and the record say so", () => {
    nextTestResult = { status: "no_tests", quarantinedFailures: [], discovery: { tests: [], uncovered: ["src/dep.ts"], truncated: true } };
    const [r] = reVerifyDependents(DEP, dir);
    expect(r!.notTested).toEqual(["src/dep.ts"]);
    expect(r!.testSearchCut).toBe(true);
    expect([...latestSearchCutByComponent()]).toEqual(["dep"]);
  });

  it("a later complete pass clears the gap the earlier one recorded", () => {
    nextTestResult = { status: "no_tests", quarantinedFailures: [], discovery: { tests: [], uncovered: ["src/dep.ts"], truncated: false } };
    reVerifyDependents(DEP, dir);
    nextTestResult = { status: "pass", quarantinedFailures: [], discovery: { tests: ["src/dep.test.ts"], uncovered: [], truncated: false } };
    reVerifyDependents(DEP, dir);
    expect(latestNotTestedByComponent().size).toBe(0);
  });
});
