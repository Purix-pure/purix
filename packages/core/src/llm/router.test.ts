// src/llm/router.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { routeTier } from "./router";
import { isolateCwdForFile } from "../test-support/isolated_cwd.js";

// N-14: this file reaches the project state store, so it runs in a throwaway directory.
isolateCwdForFile();

describe("LLM Router", () => {
  it("routes change_classification to low tier by default", () => {
    const decision = routeTier("change_classification");
    expect(decision.tier).toBe("low");
  });

  it("routes intent_refinement to high tier by default", () => {
    const decision = routeTier("intent_refinement");
    expect(decision.tier).toBe("high");
  });

  it("routes escalation to high tier by default", () => {
    const decision = routeTier("escalation");
    expect(decision.tier).toBe("high");
  });
});
