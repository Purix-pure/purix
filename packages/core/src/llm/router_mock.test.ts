// src/llm/router_mock.test.ts
import { describe, it, beforeEach } from "node:test";
import { expect } from "expect";
import { routeTier } from "./router";
import { recordCircuitFailure, recordCircuitSuccess, assertCircuitClosed } from "./circuit";

describe("LLM Router & Circuit Breaker Mock Integration", () => {
  beforeEach(() => {
    recordCircuitSuccess();
  });

  it("selects correct tier for router calls", () => {
    const dec1 = routeTier("intent_refinement");
    expect(dec1.tier).toBe("high");

    const dec2 = routeTier("change_classification");
    expect(dec2.tier).toBe("low");
  });

  it("circuit breaker trips after 5 consecutive failures and blocks calls", () => {
    expect(() => assertCircuitClosed()).not.toThrow();

    for (let i = 0; i < 5; i++) {
      recordCircuitFailure();
    }

    expect(() => assertCircuitClosed()).toThrow(/Circuit breaker open/);
  });

  it("circuit breaker resets on success", () => {
    for (let i = 0; i < 5; i++) {
      recordCircuitFailure();
    }
    expect(() => assertCircuitClosed()).toThrow(/Circuit breaker open/);

    recordCircuitSuccess();
    expect(() => assertCircuitClosed()).not.toThrow();
  });
});
