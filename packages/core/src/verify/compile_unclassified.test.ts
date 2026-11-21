// src/verify/compile_unclassified.test.ts
//
// Register item 12: the dry run was refused with `operation "unclassified" cannot be applied automatically yet`, which says nothing about
// what to do and wrongly suggests the operation will be supported later. The refusal now says what the classifier could not do and how to
// phrase the request. The prefix is part of the contract: recovery/classify_and_compile.ts skips the re-ask on it.
import { describe, it } from "node:test";
import { expect } from "expect";
import { compilePatch } from "./compile";
import { isRetryableCompileReason } from "../recovery/classify_and_compile";
import type { ChangeVerdict } from "../llm/classify";

const verdict = { operation: "unclassified", edits: [], contract_changing: false, confidence: 0.4, reasoning: "unclear", suspicious_injected_instruction: false } as unknown as ChangeVerdict;

describe("compilePatch, unclassified verdict", () => {
  const r = compilePatch(verdict, [{ path: "a.ts", content: "export const a = 1;\n" }]);

  it("refuses, changes nothing, and says how to rephrase", () => {
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/^operation "unclassified" cannot be applied automatically, so nothing was changed/);
    expect(r.reason).toMatch(/naming the file/);
    expect(r.reason).toMatch(/one change per run/);
    expect(r.reason).not.toMatch(/yet/);
  });

  it("is still not retried (asking the model again would give the same answer)", () => {
    if (r.ok) throw new Error("expected a refusal");
    expect(isRetryableCompileReason(r.reason)).toBe(false);
  });
});
