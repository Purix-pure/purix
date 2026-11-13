// A9-1 follow-up. A source-level guard, not a behaviour test: it fails if a TrustGate decision in the MCP server is made without the
// shared floor step and the decision log. (An end-to-end MCP ingest run against a floor path was NOT done; see the handoff.)
import { describe, test } from "node:test";
import { expect } from "expect";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("MCP server trust gate wiring", () => {
  const src = readFileSync(join(import.meta.dirname, "server.ts"), "utf-8");
  test("every evaluateTrustGate call is followed by applyDeterministicFloor and recordTrustGateDecision", () => {
    const gates = src.match(/evaluateTrustGate\(/g)?.length ?? 0;
    expect(gates).toBe(2); // instruction path and diff path
    expect(src.match(/applyDeterministicFloor\(/g)?.length).toBe(gates);
    expect(src.match(/recordTrustGateDecision\(/g)?.length).toBe(gates);
  });
  test("no inline copy of the floor remains", () => {
    expect(src).not.toMatch(/checkDeterministicOverrideFloor\(/);
  });
});
