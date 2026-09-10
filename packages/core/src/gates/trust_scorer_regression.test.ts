// packages/core/src/gates/trust_scorer_regression.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateTrustGate, type TrustGateInput } from "./trustgate";

describe("ADR-031 Trust Scorer Regression Harness", () => {
  it("runs trust scorer against golden-set fixtures and verifies actions within stated threshold (delta <= 0.05)", () => {
    const goldenDir = join(import.meta.dirname, "__golden__");
    const files = readdirSync(goldenDir).filter((f) => f.endsWith(".json"));

    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = readFileSync(join(goldenDir, file), "utf-8");
      const fixture = JSON.parse(content) as {
        name: string;
        input: TrustGateInput;
        expectedAction: string;
        expectedConfidence: number;
      };

      const delta = Math.abs(fixture.input.confidence - fixture.expectedConfidence);
      expect(delta).toBeLessThanOrEqual(0.05);

      const decision = evaluateTrustGate(fixture.input);
      expect(decision.action).toBe(fixture.expectedAction);
    }
  });
});
