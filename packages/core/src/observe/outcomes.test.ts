// Outcome fields added to the ledger reader: changed-line coverage, dependency lookup per change (rework risk per change is `reworkOfChange` in state/rework.ts, tested there), the four-week trend,
// and the process counts. Every figure reads a stored fact; a missing fact reads as "not recorded", never as zero.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeDb, getDbFilePath } from "../manifest/store.js";
import { recordEvent } from "../manifest/events.js";
import { newChangeId, withChange } from "./change_context.js";
import { openLedger } from "./ledger_reader.js";
import { metricsDetail } from "../verify/metrics_detail.js";
import { safeRmSync } from "../platform/fs_retry.js";

describe("metricsDetail coverage", () => {
  it("keeps counts and a ratio, never a file name", () => {
    const d = metricsDetail({ changedCoverage: { covered: 8, total: 10, ratio: 0.8, uncovered: { "src/secret-client-name.ts": [4, 9] }, notMeasured: ["a.ts"] } });
    expect(d.changed_coverage).toEqual({ covered: 8, total: 10, ratio: 0.8, uncovered_files: 1, uncovered_lines: 2, not_measured_files: 1 });
    expect(JSON.stringify(d)).not.toContain("secret-client-name");
  });
  it("leaves the field out when coverage was not measured, and rejects nonsense counts", () => {
    expect(metricsDetail({}).changed_coverage).toBeUndefined();
    expect(metricsDetail({ changedCoverage: { covered: -1, total: 3 } }).changed_coverage).toBeUndefined();
    expect(metricsDetail({ changedCoverage: { covered: 0.5, total: 3 } }).changed_coverage).toBeUndefined();
  });
});

describe("ledger outcome fields", () => {
  let dir = "", cwd = "";
  beforeEach(() => { cwd = process.cwd(); dir = mkdtempSync(join(tmpdir(), "purix-outc-")); process.chdir(dir); });
  afterEach(() => { closeDb(); process.chdir(cwd); safeRmSync(dir); });

  it("puts coverage, the dependency lookup and agent on the change, and counts process events", () => {
    const id = newChangeId();
    withChange(() => {
      recordEvent("request", { component_id: "date-utils", operation: "modify", detail: { agent_id: "opencode" } });
      recordEvent("verification_failure", { component_id: "date-utils", detail: { reason: "type error" } });
      recordEvent("escalation_start", { component_id: "date-utils" });
      recordEvent("escalation_outcome", { component_id: "date-utils", detail: { outcome: "library_hit" } });
      recordEvent("compile_retry", { component_id: "date-utils", detail: { outcome: "recovered" } });
      recordEvent("dependency_lookup", { component_id: "date-utils", detail: { names: 3, registry: { missing: 1, unanswered: 1 }, advisories: { with_advisories: 2, unanswered: 0 } } });
      recordEvent("verification_pass", { component_id: "date-utils", detail: { schema: 1, test_counts: { passed: 5, failed: 0, skipped: 0 }, changed_coverage: { covered: 6, total: 8, ratio: 0.75, uncovered_files: 1, uncovered_lines: 2, not_measured_files: 0 } } });
      recordEvent("change_landed", { component_id: "date-utils", detail: { schema: 1, kind: "modify", version: 2 } });
    }, id);
    recordEvent("reconciliation", { component_id: "date-utils", detail: { source: "accept_drift" } });
    recordEvent("memory_recorded", { detail: { scope: "repo" } });
    recordEvent("confirm_response", { component_id: "date-utils", detail: { approved: true, checkpoint_kind: "risky_file" } });

    const l = openLedger(dirname(getDbFilePath()!))!;
    try {
      const c = l.change(id)!;
      expect(c.changedCoverage).toEqual({ covered: 6, total: 8, ratio: 0.75, uncoveredFiles: 1, uncoveredLines: 2, notMeasuredFiles: 0, why: null });
      expect(c.dependencies).toEqual({ mode: { osv: false, registry: false }, names: 3, registry: { exists: 0, missing: 1, unanswered: 1 }, advisories: { pairs: 0, withAdvisories: 2, unanswered: 0 }, missingNames: [], vulnerable: [] });
      const s = l.summary();
      expect(s.landedByAgent).toEqual({ opencode: 1 });
      expect(s.repairs).toEqual({ escalations: 1, outcomes: { library_hit: 1 }, compileRetries: 1, earlyStops: 0 });
      expect(s.reuse).toEqual({ libraryHits: 1, escalations: 1 });
      expect(s.driftAccepted).toBe(1);
      expect(s.notesKept).toBe(1);
      expect(s.approvalsByKind).toEqual({ risky_file: 1 });
      expect(s.changedCoverage).toEqual({ runs: 1, covered: 6, total: 8, runsWithoutMeasure: 0 });
    } finally { l.close(); }
  });

  it("a change with no lookup and no coverage reads as not recorded, not as zero", () => {
    const id = newChangeId();
    withChange(() => {
      recordEvent("request", { component_id: "a", operation: "modify" });
      recordEvent("verification_pass", { component_id: "a", detail: { schema: 1 } });
    }, id);
    const l = openLedger(dirname(getDbFilePath()!))!;
    try {
      const c = l.change(id)!;
      expect(c.changedCoverage).toBeNull();
      expect(c.dependencies).toBeNull();
      expect(l.summary().changedCoverage).toEqual({ runs: 0, covered: 0, total: 0, runsWithoutMeasure: 1 });
    } finally { l.close(); }
  });

  it("the trend is four weekly buckets, oldest first, and a change lands in the week it started", () => {
    const id = newChangeId();
    withChange(() => {
      recordEvent("request", { component_id: "a", operation: "modify" });
      recordEvent("verification_pass", { component_id: "a", detail: { schema: 1 } });
      recordEvent("change_landed", { component_id: "a", detail: { schema: 1, kind: "modify", version: 1 } });
      recordEvent("precheck_block", { component_id: "a", detail: {} });
    }, id);
    const l = openLedger(dirname(getDbFilePath()!))!;
    try {
      const t = l.trend(new Date());
      expect(t).toHaveLength(4);
      expect(t[0]!.from < t[3]!.from).toBe(true);
      expect(t[3]).toMatchObject({ changes: 1, landed: 1, stopped: 1, verified: 1, passedFirstTime: 1 });
      expect(t.slice(0, 3).every((b) => b.changes === 0 && b.landed === 0)).toBe(true);
    } finally { l.close(); }
  });
});
