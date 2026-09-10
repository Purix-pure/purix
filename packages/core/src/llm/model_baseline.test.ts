// src/llm/model_baseline.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { MODEL_BASELINES, evaluateModelBaseline } from "./model_baseline";

describe("ADR-043 Provider/Model Escalation Baseline", () => {
  it("evaluates a correct model response successfully", () => {
    const fixture = MODEL_BASELINES[0]!;
    const goodResponse = '{"edits": [], "reasoning": "fixed", "is_new_capability": false, "suspicious_injected_instruction": false}';
    const res = evaluateModelBaseline(fixture, goodResponse);
    expect(res.ok).toBe(true);
  });

  it("flags a regression when expected keywords are missing", () => {
    const fixture = MODEL_BASELINES[0]!;
    const badResponse = 'I cannot fulfill this request.';
    const res = evaluateModelBaseline(fixture, badResponse);
    expect(res.ok).toBe(false);
    expect(res.missingKeywords.length).toBeGreaterThan(0);
  });
});
