// AI-16 measurement: the success-by-round curve read from self-heal events.
import { describe, it } from "node:test";
import { expect } from "expect";
import { buildRepairCurve, formatRepairCurve, type RepairEventRow } from "./repair_curve.js";

const heal = (kind: "verification_pass" | "verification_failure", component: string, attempt: number): RepairEventRow =>
  ({ kind, component_id: component, detail: { stage: "self_heal", attempt } });

describe("buildRepairCurve", () => {
  it("counts the round each episode was fixed in and the episodes never fixed", () => {
    const c = buildRepairCurve([
      heal("verification_pass", "a", 1),                                   // fixed in round 1
      heal("verification_failure", "b", 1), heal("verification_pass", "b", 2), // fixed in round 2
      heal("verification_failure", "c", 1), heal("verification_failure", "c", 2), heal("verification_failure", "c", 3), // never
    ]);
    expect(c).toEqual({ episodes: 3, fixedAtRound: [1, 1], notFixed: 1 });
  });

  it("starts a new episode when the same component's attempt number does not go up", () => {
    const c = buildRepairCurve([
      heal("verification_failure", "a", 1), heal("verification_failure", "a", 2),
      heal("verification_failure", "a", 1), heal("verification_pass", "a", 2),
    ]);
    expect(c).toEqual({ episodes: 2, fixedAtRound: [0, 1], notFixed: 1 });
  });

  it("interleaved components are kept apart", () => {
    const c = buildRepairCurve([
      heal("verification_failure", "a", 1), heal("verification_failure", "b", 1),
      heal("verification_pass", "b", 2), heal("verification_pass", "a", 2),
    ]);
    expect(c).toEqual({ episodes: 2, fixedAtRound: [0, 2], notFixed: 0 });
  });

  it("ignores events from other stages, other kinds and malformed attempt numbers", () => {
    const c = buildRepairCurve([
      { kind: "verification_pass", component_id: "a", detail: { stage: "initial" } },
      { kind: "verification_failure", component_id: "a", detail: { stage: "escalation", attempt: 1 } },
      { kind: "classification", component_id: "a", detail: { stage: "self_heal", attempt: 1 } },
      { kind: "verification_pass", component_id: "a", detail: { stage: "self_heal", attempt: "1" } },
      { kind: "verification_pass", component_id: "a", detail: { stage: "self_heal", attempt: 0 } },
    ]);
    expect(c).toEqual({ episodes: 0, fixedAtRound: [], notFixed: 0 });
  });

  it("a pass after a pass on the same component is a new episode", () => {
    const c = buildRepairCurve([heal("verification_pass", "a", 1), heal("verification_pass", "a", 1)]);
    expect(c).toEqual({ episodes: 2, fixedAtRound: [2], notFixed: 0 });
  });
});

describe("formatRepairCurve", () => {
  it("says so when nothing is recorded", () => {
    expect(formatRepairCurve(buildRepairCurve([]))).toContain("no self-heal episodes recorded yet");
  });
  it("prints the cumulative curve, the spend per fixed episode, and that it changes no default", () => {
    const c = buildRepairCurve([heal("verification_pass", "a", 1), heal("verification_failure", "b", 1), heal("verification_pass", "b", 2), heal("verification_failure", "c", 1)]);
    const text = formatRepairCurve(c, { calls: 4, costUsd: 0.02 });
    expect(text).toContain("3 self-heal episode(s), 2 fixed, 1 not fixed");
    expect(text).toContain("round 1: 1 fixed here; 1 of 3 (33%)");
    expect(text).toContain("round 2: 1 fixed here; 2 of 3 (67%)");
    expect(text).toContain("$0.0100 per fixed episode");
    expect(text).toContain("defaults (tier, round cap, early stop) are not changed");
  });
  it("omits the spend line when there is no repair spend or nothing was fixed", () => {
    const none = buildRepairCurve([heal("verification_failure", "a", 1)]);
    expect(formatRepairCurve(none, { calls: 1, costUsd: 0.01 })).not.toContain("Spend:");
    expect(formatRepairCurve(buildRepairCurve([heal("verification_pass", "a", 1)]))).not.toContain("Spend:");
  });
});
