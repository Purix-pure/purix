// packages/core/src/llm/python_model_baseline.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { PYTHON_MODEL_BASELINES, evaluateModelBaseline } from "./python_model_baseline";

describe("ADR-044 Python Model Escalation Baseline (ADR-044 Amendment)", () => {
  it("evaluates python baseline fixtures successfully", () => {
    for (const fixture of PYTHON_MODEL_BASELINES) {
      const sampleResponse = '{"reasoning": "Fixed python bug", "edits": [], "python": true}';
      const result = evaluateModelBaseline(fixture, sampleResponse);
      expect(result.ok).toBe(true);
    }
  });

  it("flags python baseline regression when keywords missing", () => {
    const fixture = PYTHON_MODEL_BASELINES[0]!;
    const badResponse = '{"reasoning": "incomplete"}';
    const result = evaluateModelBaseline(fixture, badResponse);
    expect(result.ok).toBe(false);
    expect(result.missingKeywords).toContain("python");
  });
});
