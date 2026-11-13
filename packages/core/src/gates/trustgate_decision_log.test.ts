// A2a-1: the trust gate takes two optional inputs now (filled by A6) and every decision is logged with its inputs.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRmSync } from "../platform/fs_retry.js";
import { closeDb } from "../manifest/store.js";
import { readAuditChain, verifyAuditChain } from "../security/audit_tamper_evidence.js";
import { evaluateTrustGate, recordTrustGateDecision, type TrustGateInput } from "./trustgate.js";

const base = (): TrustGateInput => ({ confidence: 0.9, contractChanging: false, hasCoverage: true, testIntegrity: { flagged: false } });

describe("trust gate inputs and decision log", () => {
  let cwd: string;
  let dir: string;
  beforeEach(() => {
    cwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "purix-tg-"));
    process.chdir(dir);
  });
  afterEach(() => {
    closeDb();
    process.chdir(cwd);
    safeRmSync(dir);
  });

  it("changedLineCoverage and testBaseline do not change any decision yet (the auto-commit rule waits for A3 and A6 numbers)", () => {
    const plain = evaluateTrustGate(base());
    const withFields = evaluateTrustGate({ ...base(), changedLineCoverage: 0.0, testBaseline: { passed: 0, failed: 9, skipped: 0 } });
    expect(withFields).toEqual(plain);
    expect(plain.action).toBe("auto_commit");
  });

  it("a logged decision carries the action, the reason and every input", () => {
    const input: TrustGateInput = { ...base(), isolation: "none", changedLineCoverage: 0.5, testBaseline: { passed: 10, failed: 0, skipped: 1 } };
    const decision = evaluateTrustGate(input);
    recordTrustGateDecision(input, decision, { source: "instruction", componentIds: ["alpha"], files: ["src/a.ts"], floor: { hit: false } });
    const rec = readAuditChain().rows.map((r) => JSON.parse(r.payload)).find((p) => p.event === "gate_decision");
    expect(rec).toMatchObject({
      event: "gate_decision",
      gate: "TrustGate",
      action: decision.action,
      reason: decision.reason,
      source: "instruction",
      component_ids: ["alpha"],
      files: ["src/a.ts"],
      floor: { hit: false },
      inputs: { confidence: 0.9, contract_changing: false, has_coverage: true, test_integrity_flagged: false, isolation: "none", changed_line_coverage: 0.5, test_baseline: { passed: 10, failed: 0, skipped: 1 } },
    });
    expect(verifyAuditChain().valid).toBe(true);
  });

  it("a floor hit is logged with the path and pattern that held the change", () => {
    const input = base();
    const decision = { action: "human_confirm" as const, reason: "floor" };
    recordTrustGateDecision(input, decision, { source: "diff", floor: { hit: true, matchedPath: "src/auth/a.ts", matchedPattern: "**/auth/**" } });
    const rec = readAuditChain().rows.map((r) => JSON.parse(r.payload)).find((p) => p.event === "gate_decision");
    expect(rec.floor).toEqual({ hit: true, matchedPath: "src/auth/a.ts", matchedPattern: "**/auth/**" });
  });

  it("logging never throws into the caller: a failed append returns false and tells the sink", () => {
    const seen: string[] = [];
    const ok = recordTrustGateDecision(base(), { action: "auto_commit", reason: "x" }, {
      source: "instruction",
      append: () => {
        throw new Error("disk full");
      },
      onFailure: (m) => seen.push(m),
    });
    expect(ok).toBe(false);
    expect(seen.join(" ")).toMatch(/disk full/);
  });
});
