// A1: result kinds and the repair-eligibility rule.
import { describe, it } from "node:test";
import { expect } from "expect";
import {
  isRepairEligibleKind, infrastructureKindOfStop, infrastructureResultOfSpawn, checkKindOfVerification, checkKindOfTestRun,
  isRepairEligibleVerification, verificationOutcome, type CheckKind,
} from "./outcome.js";
import { spawnSync } from "../platform/spawn_sync.js";
import type { VerificationResult } from "./verify.js";

describe("repair eligibility", () => {
  it("only a code failure is eligible", () => {
    const kinds: CheckKind[] = ["pass", "fail", "infrastructure", "not_run", "no_tests_ran", "all_skipped"];
    expect(kinds.filter(isRepairEligibleKind)).toEqual(["fail"]);
  });
  it("verification results", () => {
    expect(isRepairEligibleVerification({ status: "pass" } as VerificationResult)).toBe(false);
    expect(isRepairEligibleVerification({ status: "fail", reason: "type error" })).toBe(true);
    expect(isRepairEligibleVerification({ status: "fail", reason: "secret", policyBlock: true })).toBe(false);
    expect(isRepairEligibleVerification({ status: "fail", reason: "slow", infrastructure: "timeout" })).toBe(false);
    expect(isRepairEligibleVerification({ status: "not_installed", reason: "no tsc" })).toBe(false);
  });
});

describe("mapping today's values onto kinds", () => {
  it("verification", () => {
    expect(checkKindOfVerification({ status: "pass" })).toBe("pass");
    expect(checkKindOfVerification({ status: "fail" })).toBe("fail");
    expect(checkKindOfVerification({ status: "fail", infrastructure: "output_limit" })).toBe("infrastructure");
    expect(checkKindOfVerification({ status: "not_installed" })).toBe("infrastructure");
  });
  it("test runs: no tests is not a pass and not a code failure", () => {
    expect(checkKindOfTestRun("pass")).toBe("pass");
    expect(checkKindOfTestRun("fail")).toBe("fail");
    expect(checkKindOfTestRun("no_tests")).toBe("no_tests_ran");
    expect(checkKindOfTestRun("not_installed")).toBe("infrastructure");
  });
  it("display outcome: infrastructure shows as an error, a plain failure is unchanged", () => {
    expect(verificationOutcome({ status: "fail" })).toBe("fail");
    expect(verificationOutcome({ status: "fail", infrastructure: "timeout" })).toBe("error");
    expect(verificationOutcome({ status: "not_installed" })).toBe("error");
    expect(verificationOutcome({ status: "pass" })).toBe("pass");
  });
});

describe("spawn stops", () => {
  it("each stop maps to an infrastructure kind", () => {
    expect(infrastructureKindOfStop("timeout")).toBe("timeout");
    expect(infrastructureKindOfStop("output_limit")).toBe("output_limit");
    expect(infrastructureKindOfStop("resource_limit")).toBe("resource_limit");
    expect(infrastructureKindOfStop("not_found")).toBe("not_installed");
    expect(infrastructureKindOfStop("spawn_error")).toBe("not_installed");
  });
  it("a normal exit, even a failing one, is not infrastructure", () => {
    expect(infrastructureResultOfSpawn({}, "pytest")).toBeUndefined();
  });
  it("a real timeout becomes an infrastructure result that no repair will chase", () => {
    const r = spawnSync(["node", "-e", "setTimeout(()=>{}, 8000)"], { deadlineMs: 300 });
    const infra = infrastructureResultOfSpawn(r, "the test run");
    expect(infra?.infrastructure).toBe("timeout");
    expect(infra?.reason).toContain("not a failure of your code");
    expect(isRepairEligibleKind(infra!.kind)).toBe(false);
  });
});
