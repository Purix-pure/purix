// src/observe/observe.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateCwdForFile } from "../test-support/isolated_cwd.js";
import { recordEvent } from "../manifest/events.js";
import { getDbFilePath } from "../manifest/store.js";
import { recordLlmCall } from "../llm/call_log.js";
import { safeRmSync } from "../platform/fs_retry.js";
import { currentChangeId, newChangeId, withChange } from "./change_context.js";
import { openLedger } from "./ledger_reader.js";
import { formatResultLine, resultLineForChange } from "./result_line.js";
import { eventLine } from "./event_lines.js";
import { listProjects, pruneRegistry, readRegistry, registryPath, touchProject } from "./registry.js";
import { metricsDetail } from "../verify/metrics_detail.js";
import { LEDGER_SCHEMA_VERSION } from "./ledger_version.js";
import { dirname } from "node:path";
import { appendAuditRecord } from "../security/audit_tamper_evidence.js";

isolateCwdForFile();

const call = (cost: number) => ({ callType: "escalation", tier: "low", provider: "p", model: "m", promptChars: 400, inputTokens: 100, outputTokens: 20, latencyMs: 5, costUsd: cost, status: "ok" }) as never;

function stateDir(): string {
  const p = getDbFilePath();
  if (!p) throw new Error("no store");
  return dirname(p);
}

describe("change context", () => {
  it("is null outside a change and shared by events and model calls inside one", async () => {
    expect(currentChangeId()).toBeNull();
    const id = newChangeId();
    await withChange(async () => {
      await Promise.resolve();
      expect(currentChangeId()).toBe(id);
      recordEvent("request", { component_id: "a", operation: "modify", detail: { x: 1 } });
      recordLlmCall(call(0.03));
    }, id);
    expect(currentChangeId()).toBeNull();
    const ledger = openLedger(stateDir())!;
    const c = ledger.change(id)!;
    expect(c.modelCalls).toBe(1);
    expect(c.costUsd).toBeCloseTo(0.03);
    ledger.close();
  });
  it("keeps an explicit change_id the caller set", () => {
    withChange(() => recordEvent("change_feedback", { detail: { change_id: "chg-explicit", helped: true } }));
    const ledger = openLedger(stateDir())!;
    expect(ledger.change("chg-explicit")?.helped).toBe(true);
    ledger.close();
  });
});

describe("ledger reader", () => {
  it("builds a receipt and a summary from stored events, and never writes", () => {
    const id = newChangeId();
    withChange(() => {
      recordEvent("request", { component_id: "date-utils", operation: "modify" });
      recordEvent("verification_failure", { component_id: "date-utils", detail: { reason: "type error" } });
      recordEvent("test_integrity_flag", { component_id: "date-utils", detail: {} });
      recordEvent("verification_pass", { component_id: "date-utils", detail: { ...metricsDetail({ testCounts: { passed: 41, failed: 0, skipped: 2 }, verifyMs: 3100 }), isolation: "none", not_tested: ["a.go"] } });
      recordEvent("change_landed", { component_id: "date-utils", detail: { schema: 1, kind: "modify", version: 3 } });
      recordLlmCall(call(0.04)); recordLlmCall(call(0.02));
    }, id);
    const before = readFileSync(getDbFilePath()!).length;
    const ledger = openLedger(stateDir())!;
    const c = ledger.change(id)!;
    expect(c.result).toBe("landed");
    expect(c.failedBeforePass).toBe(1);
    expect(c.testCounts).toEqual({ passed: 41, failed: 0, skipped: 2 });
    expect(c.verifyMs).toBe(3100);
    expect(c.isolation).toBe("none");
    expect(c.notTested).toEqual(["a.go"]);
    expect(c.stops).toHaveLength(1);
    expect(c.modelCalls).toBe(2);
    expect(c.costUsd).toBeCloseTo(0.06);
    const s = ledger.summary();
    expect(s.tests.totals.passed).toBeGreaterThanOrEqual(41);
    expect(s.stopped.byKind["test_integrity_flag"]).toBe(1);
    expect(s.firstAttemptPass.of).toBeGreaterThanOrEqual(1);
    expect(s.schemaVersion).toBe(LEDGER_SCHEMA_VERSION);
    expect(ledger.exportAll().changes.length).toBeGreaterThan(0);
    ledger.close();
    expect(readFileSync(getDbFilePath()!).length).toBe(before);
  });
  it("returns null for a folder with no record", () => {
    expect(openLedger(mkdtempSync(join(tmpdir(), "purix-none-")))).toBeNull();
  });
  it("tails new events by row id", () => {
    const ledger = openLedger(stateDir())!;
    const max = ledger.maxEventRowid();
    recordEvent("request", { component_id: "tail", operation: "create" });
    const next = ledger.eventsAfter(max);
    expect(next.map((e) => e.componentId)).toContain("tail");
    ledger.close();
  });
});

describe("metricsDetail", () => {
  it("leaves out what was not recorded and rejects bad numbers", () => {
    expect(metricsDetail({})).toEqual({ schema: LEDGER_SCHEMA_VERSION });
    expect(metricsDetail({ testCounts: { passed: -1, failed: 0, skipped: 0 }, verifyMs: Number.NaN })).toEqual({ schema: LEDGER_SCHEMA_VERSION });
    expect(metricsDetail({ testCounts: { passed: 3, failed: 0, skipped: 1 }, verifyMs: 12.6 })).toEqual({ schema: LEDGER_SCHEMA_VERSION, test_counts: { passed: 3, failed: 0, skipped: 1 }, verify_ms: 13 });
  });
});

describe("result line", () => {
  it("says what ran and never claims more", () => {
    expect(formatResultLine({ tests: { passed: 41, failed: 0, skipped: 2 }, checksPassed: true, stopped: 1, costUsd: 0.03, leftUsd: 1.97, waiting: 0 }))
      .toBe("Purix: 41 tests passed (2 skipped), 1 stopped, $0.03 spent, $1.97 left");
    expect(formatResultLine({ tests: null, checksPassed: true, stopped: 0, costUsd: null, leftUsd: 4, waiting: 1 })).toBe("Purix: checks passed, test counts not recorded, 1 waiting for approval, $4.00 left");
    expect(formatResultLine({ tests: null, checksPassed: false, stopped: 0, costUsd: null, leftUsd: 4, waiting: 0 })).toBeNull();
  });
  it("is off with PURIX_RESULT_LINE=off and builds from the record otherwise", () => {
    const id = newChangeId();
    withChange(() => recordEvent("verification_pass", { detail: metricsDetail({ testCounts: { passed: 5, failed: 0, skipped: 0 } }) }), id);
    expect(resultLineForChange(stateDir(), id, 0)).toContain("5 tests passed");
    process.env.PURIX_RESULT_LINE = "off";
    try { expect(resultLineForChange(stateDir(), id, 0)).toBeNull(); } finally { delete process.env.PURIX_RESULT_LINE; }
  });
});

describe("event lines", () => {
  it("words a stop with its reason and skips bookkeeping", () => {
    const base = { rowid: 1, id: "x", timestamp: "2026-11-22T10:00:00.000Z", componentId: "c", operation: null };
    expect(eventLine({ ...base, kind: "test_integrity_flag", detail: {} })).toContain("STOPPED");
    expect(eventLine({ ...base, kind: "verification_pass", detail: { test_counts: { passed: 4, failed: 0, skipped: 0 }, verify_ms: 1500 } })).toContain("4 tests passed · 1.5s");
    expect(eventLine({ ...base, kind: "gate_evaluation", detail: {} })).toBeNull();
  });
});

describe("project registry", () => {
  let user: string; let proj: string;
  beforeEach(() => { user = mkdtempSync(join(tmpdir(), "purix-reg-user-")); proj = mkdtempSync(join(tmpdir(), "purix-reg-proj-")); });
  afterEach(() => { safeRmSync(user); safeRmSync(proj); });

  it("lists a project once, throttles repeats, and ignores folders that are not projects", () => {
    expect(touchProject({ cwd: proj, dir: user })).toBe(false); // no marker above it
    mkdirSync(join(proj, ".git"));
    const t0 = new Date("2026-11-22T10:00:00Z");
    expect(touchProject({ cwd: proj, dir: user, agent: "opencode", now: t0 })).toBe(true);
    expect(touchProject({ cwd: proj, dir: user, agent: "opencode", now: new Date(t0.getTime() + 5000) })).toBe(false);
    expect(touchProject({ cwd: proj, dir: user, agent: "codex", now: new Date(t0.getTime() + 6000) })).toBe(true);
    const list = listProjects(user);
    expect(list).toHaveLength(1);
    expect(list[0]!.agents.sort()).toEqual(["codex", "opencode"]);
    expect(JSON.stringify(readRegistry(user))).not.toContain("prompt");
  });
  it("survives a damaged file and prunes folders that are gone", () => {
    mkdirSync(join(proj, ".git"));
    writeFileSync(registryPath(user), "{not json");
    expect(readRegistry(user).projects).toEqual([]);
    touchProject({ cwd: proj, dir: user });
    safeRmSync(proj);
    expect(pruneRegistry(user)).toBe(1);
    expect(existsSync(registryPath(user))).toBe(true);
  });
});

describe("events from the other session, read by the ledger", () => {
  it("summarises secrets removed, undone changes, dependency lookups and the last audit without ever holding a value", () => {
    recordEvent("secrets_scrubbed", { operation: "escalation", detail: { direction: "outbound", count: 2, formats: { aws_key: 2 } } });
    recordEvent("secrets_scrubbed", { operation: "escalation", detail: { direction: "inbound", count: 1, formats: { aws_key: 1 } } });
    recordEvent("apply_rolled_back", { component_id: "r", detail: { reason: "file_write_failed", rollback_failed: true } });
    recordEvent("dependency_lookup", { component_id: "r", detail: { names: 3, registry: { exists: 1, missing: 1, unanswered: 1 }, advisories: { pairs: 2, with_advisories: 1, unanswered: 0 } } });
    recordEvent("audit_run", { operation: "audit", detail: { pinning_findings: 2, vuln: { ran: false, reason: "no osv-scanner" }, idiom: { ran: true, findings: 4 } } });
    const ledger = openLedger(stateDir())!;
    const s = ledger.summary();
    expect(s.secretsRemoved).toEqual({ outbound: 2, inbound: 1, byFormat: { aws_key: 3 } });
    expect(s.rolledBack).toEqual({ total: 1, undoFailed: 1 });
    expect(s.dependencies).toMatchObject({ runs: 1, namesChecked: 3, missing: 1, withAdvisories: 1, unanswered: 1 });
    expect(s.lastAudit).toMatchObject({ pinningFindings: 2, vulnFindings: null, vulnReason: "no osv-scanner", idiomFindings: 4 });
    ledger.close();
  });
  it("reads approval waits and rework from the audit chain", () => {
    appendAuditRecord({ event: "approval", state: "requested", approval_id: "apr-t1", tool: "purix_modify", component_id: "w", at: new Date(Date.now() - 4000).toISOString() });
    appendAuditRecord({ event: "approval", state: "approved", approval_id: "apr-t1", tool: "purix_modify", component_id: "w", at: new Date().toISOString() });
    appendAuditRecord({ event: "component_change", component_id: "w", kind: "modify", version: 1 });
    appendAuditRecord({ event: "component_change", component_id: "w", kind: "modify", version: 2 });
    const ledger = openLedger(stateDir())!;
    const s = ledger.summary();
    expect(s.approvals.waitsRecorded).toBeGreaterThanOrEqual(1);
    expect(s.approvals.medianWaitMs).not.toBeNull();
    expect(s.rework.tooRecent).toBeGreaterThanOrEqual(2); // a window that is still open is in neither number
    expect(s.rework.reworked).toBe(0);
    ledger.close();
  });
});
