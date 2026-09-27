// TEST-REPORT F4: a classifier-reported prompt-injection flag must force human confirmation.
import { describe, it } from "node:test";
import { expect } from "expect";
import { evaluateTrustGate } from "./trustgate";

const clean = { confidence: 0.95, contractChanging: false, hasCoverage: true, testIntegrity: { flagged: false } };

describe("evaluateTrustGate — injectionSuspected", () => {
  it("auto-commits a clean, high-confidence change (baseline)", () => {
    expect(evaluateTrustGate(clean).action).toBe("auto_commit");
  });
  it("requires a human even at high confidence when injection is suspected", () => {
    const decision = evaluateTrustGate({ ...clean, injectionSuspected: true });
    expect(decision.action).toBe("human_confirm");
    expect(decision.reason).toContain("prompt injection");
  });
  it("treats an absent flag the same as false (existing callers keep working)", () => {
    expect(evaluateTrustGate({ ...clean, injectionSuspected: false }).action).toBe("auto_commit");
  });
});
