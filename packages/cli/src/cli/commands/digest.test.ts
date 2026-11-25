// `purix digest`: a short, plain-words summary of a period of the project's record, set beside the period before it.
// The formatter is pure: two summaries in, text out. The wording rule of the observability layer applies: say what was measured,
// never "safe", "correct" or "fixed"; a figure that was not recorded says so, and is never shown as zero.
import { describe, test } from "node:test";
import { expect } from "expect";
import type { ProjectSummary } from "@purix/core/observe/ledger_reader";
import { formatDigest, digestWindows, digestCoverage } from "./digest";

function summary(over: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    schemaVersion: 1, generatedAt: "2026-11-22T00:00:00.000Z", range: { from: null, to: null }, firstEventAt: "2026-01-01T00:00:00.000Z", components: 12,
    changesLanded: 40, changesLandedInRange: 6, changesWithId: 6, verificationPasses: 9, verificationFailures: 3,
    firstAttemptPass: { passed: 4, of: 6 }, stopped: { total: 0, byKind: {}, gateEvaluations: 0 },
    tests: { totals: { passed: 120, failed: 0, skipped: 2 }, verificationsWithCounts: 5, verificationsWithoutCounts: 1 },
    approvals: { asked: 4, approved: 3, denied: 1, medianWaitMs: 42_000, waitsRecorded: 4 },
    spend: { spentUsd: 1.234, ceilingUsd: 5, leftUsd: 3.766, calls: 20, failedCalls: 1, tokensIn: 1000, tokensOut: 500, tokensCached: 0, costOfUnlandedUsd: 0.2, modelTierSavingUsd: null, byModel: [], byCallType: [] },
    isolation: {}, notTestedFiles: 0, notCheckedFiles: 0, unadoptedWrites: 0, hookDenials: 0,
    rework: { windowDays: 14, considered: 5, reworked: 1, tooRecent: 1 },
    secretsRemoved: { outbound: 0, inbound: 0, byFormat: {} }, rolledBack: { total: 0, undoFailed: 0 },
    dependencies: { runs: 0, namesChecked: 0, missing: 0, withAdvisories: 0, unanswered: 0 },
    lastAudit: null, auditRuns: 0, securityAdvisories: 0, agents: {}, landedByAgent: {}, repairs: { escalations: 0, outcomes: {}, compileRetries: 0, earlyStops: 0 }, reuse: { libraryHits: 0, escalations: 0 }, driftAccepted: 0, notesKept: 0, approvalsByKind: {}, changedCoverage: { runs: 0, covered: 0, total: 0, runsWithoutMeasure: 0 }, feedback: { helped: 0, notHelped: 0 }, sources: [],
    ...over,
  };
}
const opts = { days: 7, now: new Date("2026-11-22T10:00:00Z"), version: "1.2.3" };

describe("digestWindows", () => {
  test("the period is the last N whole days to now, and the one before it has the same length", () => {
    const w = digestWindows(new Date("2026-11-22T10:00:00Z"), 7);
    expect(w.current).toEqual({ since: "2026-11-15T10:00:00.000Z", until: "2026-11-22T10:00:00.000Z" });
    expect(w.previous).toEqual({ since: "2026-11-08T10:00:00.000Z", until: "2026-11-15T10:00:00.000Z" });
  });
});

describe("formatDigest", () => {
  test("states the period and what landed, beside the period before", () => {
    const text = formatDigest(summary(), summary({ changesLandedInRange: 4 }), opts);
    expect(text).toContain("Purix digest: 15 Nov to 22 Nov 2026 (7 days)");
    expect(text).toContain("Changes landed: 6 (4 the period before)");
  });

  test("tests passed are the sum of recorded counts, and runs without counts are named, not hidden", () => {
    const text = formatDigest(summary(), null, opts);
    expect(text).toContain("120 tests passed, 0 failed, 2 skipped across 5 verified run(s); 1 run(s) did not record test counts");
  });

  test("spend is called an estimate and shows what is left", () => {
    const text = formatDigest(summary(), null, opts);
    expect(text).toContain("Estimated spend: $1.23 of a $5.00 ceiling ($3.77 left)");
  });

  test("with no spend record it says none was recorded", () => {
    expect(formatDigest(summary({ spend: null }), null, opts)).toContain("Spend: none recorded");
  });

  test("stops are listed by reason, and a period with none says none", () => {
    const stopped = formatDigest(summary({ stopped: { total: 3, byKind: { policy_block: 2, precheck_block: 1 }, gateEvaluations: 9 } }), null, opts);
    expect(stopped).toContain("Stopped before landing: 3");
    expect(stopped).toContain("2 × The secret scan or the security gate refused a change before any test ran");
    expect(formatDigest(summary(), null, opts)).toContain("Stopped before landing: none");
  });

  test("approvals show the median wait only when waits were recorded", () => {
    expect(formatDigest(summary(), null, opts)).toContain("Approvals: 4 asked, 3 approved, 1 declined, median wait 42s");
    const none = formatDigest(summary({ approvals: { asked: 2, approved: 2, denied: 0, medianWaitMs: null, waitsRecorded: 0 } }), null, opts);
    expect(none).toContain("wait not recorded");
  });

  test("an audit that did not run is not-checked, never clean", () => {
    const text = formatDigest(summary({ lastAudit: { at: "2026-11-20T00:00:00Z", pinningFindings: 0, vulnFindings: null, vulnReason: "offline", idiomFindings: 0, idiomReason: null }, auditRuns: 1 }), null, opts);
    expect(text).toContain("vulnerability scan not run (offline)");
    expect(text).not.toMatch(/\bclean\b/);
  });

  test("rework is labelled all-time and a correlation, and a young project says nothing is old enough to judge", () => {
    expect(formatDigest(summary(), null, opts)).toContain("Rework (all time): 1 of 5 landed changes had another change to the same component within 14 days; 1 too recent to judge. A correlation, not a cause.");
    expect(formatDigest(summary({ rework: { windowDays: 14, considered: 0, reworked: 0, tooRecent: 2 } }), null, opts)).toContain("Rework (all time): nothing old enough to judge yet");
  });

  test("never claims safety or correctness", () => {
    const text = formatDigest(summary(), summary(), opts);
    expect(text).not.toMatch(/\b(safe|correct|fixed|secure)\b/i);
  });

  test("a project with no landed changes in the period says so plainly", () => {
    const text = formatDigest(summary({ changesLandedInRange: 0, changesWithId: 0, tests: { totals: { passed: 0, failed: 0, skipped: 0 }, verificationsWithCounts: 0, verificationsWithoutCounts: 0 } }), null, opts);
    expect(text).toContain("Changes landed: 0");
    expect(text).toContain("Tests: none recorded in this period");
  });

  test("is left-aligned plain text with no centered or padded layout", () => {
    const text = formatDigest(summary(), null, opts);
    for (const line of text.split("\n")) expect(line).toBe(line.trimEnd());
    expect(text.split("\n").every((l) => !l.startsWith("   "))).toBe(true);
  });
});

describe("digest coverage of the period before", () => {
  const now = new Date("2026-11-22T10:00:00Z"); // current period starts 15 Nov 10:00, the one before starts 8 Nov 10:00

  test("full when the record starts before the earlier period", () => {
    expect(digestCoverage("2026-11-01T00:00:00.000Z", now, 7)).toEqual({ kind: "full" });
    expect(formatDigest(summary(), summary({ changesLandedInRange: 4 }), opts)).not.toContain("Note:");
  });

  test("partial when it starts inside the earlier period: says where the record starts and calls the figures lower bounds", () => {
    const text = formatDigest(summary({ firstEventAt: "2026-11-12T00:00:00.000Z" }), summary({ changesLandedInRange: 4 }), opts);
    expect(text).toContain("Changes landed: 6 (4 the period before)");
    expect(text).toContain("Note: the record starts on 12 Nov 2026");
    expect(text).toContain("lower bounds");
    expect(text).toContain("365 days");
  });

  test("none when the record starts inside this period: no '0 the period before', and the reason is given", () => {
    const text = formatDigest(summary({ firstEventAt: "2026-11-18T00:00:00.000Z" }), summary({ changesLandedInRange: 0 }), opts);
    expect(text).toContain("Changes landed: 6\n");
    expect(text).not.toContain("the period before)");
    expect(text).toContain("inside this period");
  });

  test("none with no events at all", () => {
    expect(digestCoverage(null, now, 7)).toEqual({ kind: "none", firstEventAt: null });
    expect(formatDigest(summary({ firstEventAt: null }), null, opts)).toContain("no events are recorded yet");
  });

  test("boundaries: starting exactly when the period before starts is full; one second later is partial", () => {
    expect(digestCoverage("2026-11-08T10:00:00.000Z", now, 7)).toEqual({ kind: "full" });
    expect(digestCoverage("2026-11-08T10:00:01.000Z", now, 7).kind).toBe("partial");
    expect(digestCoverage("2026-11-15T10:00:00.000Z", now, 7).kind).toBe("none");
  });
});
