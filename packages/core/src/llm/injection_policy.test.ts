// F03-08: a tripwire hit raises scrutiny, it does not refuse. Pure functions; the MCP end-to-end behaviour is tested in
// packages/mcp-server/src/mcp_injection_hold.test.ts.
import { describe, test } from "node:test";
import { expect } from "expect";
import { holdForInjection, describeSightings, onlySeen, refusalWhenNobodyIsAsked } from "./injection_policy.js";
import { evaluateTrustGate } from "../gates/trustgate.js";

const seen = [{ where: "billing.ts", hits: ["ignore all previous instructions"] }];

describe("holdForInjection", () => {
  test("an auto-commit becomes a human confirmation that names what was seen", () => {
    const d = holdForInjection({ action: "auto_commit", reason: "high confidence" }, seen);
    expect(d.action).toBe("human_confirm");
    expect(d.reason).toContain("billing.ts");
    expect(d.reason).toContain("ignore all previous instructions");
    expect(d.reason).toContain("false alarm");
  });
  test("an existing confirmation keeps its own reason", () => {
    const d = holdForInjection({ action: "human_confirm", reason: "contract changing" }, seen);
    expect(d.action).toBe("human_confirm");
    expect(d.reason).toContain("contract changing");
    expect(d.reason).toContain("billing.ts");
  });
  test("an abort is never lowered", () => {
    const d = holdForInjection({ action: "abort", reason: "low confidence" }, seen);
    expect(d).toEqual({ action: "abort", reason: "low confidence" });
  });
  test("nothing seen changes nothing", () => {
    const d = { action: "auto_commit" as const, reason: "ok" };
    expect(holdForInjection(d, [])).toBe(d);
    expect(holdForInjection(d, [{ where: "a.ts", hits: [] }])).toBe(d);
  });
  test("the decision a real high-confidence trust gate returns is raised", () => {
    const base = evaluateTrustGate({ confidence: 0.99, contractChanging: false, hasCoverage: true, testIntegrity: { flagged: false } });
    expect(base.action).toBe("auto_commit");
    expect(holdForInjection(base, seen).action).toBe("human_confirm");
  });
});

describe("wording", () => {
  test("lists at most three phrases per place and counts the rest", () => {
    const text = describeSightings([{ where: "a.ts", hits: ["p1", "p2", "p3", "p4", "p5"] }]);
    expect(text).toContain('"p3"');
    expect(text).not.toContain('"p4"');
    expect(text).toContain("and 2 more");
  });
  test("onlySeen drops empty sightings", () => {
    expect(onlySeen([{ where: "a", hits: [] }, { where: "b", hits: ["x"] }])).toHaveLength(1);
  });
  test("the refusal for the unasked case names the way out", () => {
    const t = refusalWhenNobodyIsAsked(seen, '"purix modify billing <instruction>"');
    expect(t).toContain("Refused");
    expect(t).toContain("PURIX_MCP_AUTO_APPROVE");
    expect(t).toContain("purix modify billing");
  });
});
