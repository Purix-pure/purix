// The outcome lines the plan asked for: changed-line coverage, dependencies added and rework risk on the receipt; a four-week trend and a
// process panel on the project page; the telemetry preview; and a "how" page that no longer calls finished work "not built yet".
import { describe, it, before, after } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeDb, getDbFilePath } from "@purix/core/manifest/store";
import { recordEvent } from "@purix/core/manifest/events";
import { newChangeId, withChange } from "@purix/core/observe/change_context";
import { openLedger } from "@purix/core/observe/ledger_reader";
import { verifyAuditRows, appendAuditRecord } from "@purix/core/security/audit_tamper_evidence";
import { safeRmSync } from "@purix/core/platform/fs_retry";
import { handleRequest, projectId } from "./server.js";
import type { DashboardSource, ProjectRef } from "./pages.js";

let dir = "", cwd = "", withLookup = "", plain = "", project: ProjectRef;
const TOKEN = "tok-outc";

const source = (telemetry = true): DashboardSource => ({
  now: () => new Date(),
  version: "0.0.0-test",
  projects: () => [project],
  openLedger: (p) => openLedger(p.stateDir),
  pending: () => [],
  verifyChain: (c) => verifyAuditRows(c.rows, c.checkpoint),
  ...(telemetry ? { telemetry: () => ({ state: "off", sharingNow: "off (you have not enabled it)", payload: { schema: 1, counts: { commands: 3 } } }) } : {}),
});
const get = (url: string, src = source()) => handleRequest({ method: "GET", url, host: "127.0.0.1:9999", cookie: `purix_dash=${TOKEN}` }, src, TOKEN, 9999);

before(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "purix-dashout-"));
  process.chdir(dir);
  withLookup = newChangeId();
  withChange(() => {
    recordEvent("request", { component_id: "date-utils", operation: "modify", detail: { agent_id: "opencode" } });
    recordEvent("escalation_start", { component_id: "date-utils" });
    recordEvent("escalation_outcome", { component_id: "date-utils", detail: { outcome: "library_hit" } });
    recordEvent("dependency_lookup", { component_id: "date-utils", detail: { mode: { osv: true, registry: true }, names: 2, registry: { exists: 1, missing: 1, unanswered: 0 }, advisories: { pairs: 2, with_advisories: 0, unanswered: 1 }, missing_names: [{ ecosystem: "npm", name: "left-padz" }], vulnerable: [] } });
    recordEvent("verification_pass", { component_id: "date-utils", detail: { schema: 1, test_counts: { passed: 9, failed: 0, skipped: 0 }, changed_coverage: { covered: 3, total: 4, ratio: 0.75, uncovered_files: 1, uncovered_lines: 1, not_measured_files: 0 } } });
    recordEvent("change_landed", { component_id: "date-utils", detail: { schema: 1, kind: "modify", version: 2 } });
  }, withLookup);
  // the chain entry a landed change leaves (identifiers only), so the receipt can match it and judge rework
  appendAuditRecord({ event: "component_change", kind: "modify", component_id: "date-utils", version: 2, sync_hash: null, operation: null, source: null });
  plain = newChangeId();
  withChange(() => {
    recordEvent("request", { component_id: "slug", operation: "create" });
    recordEvent("verification_pass", { component_id: "slug", detail: { schema: 1 } });
  }, plain);
  const stateDir = dirname(getDbFilePath()!);
  project = { id: projectId(dir), name: "acme", path: dir, stateDir, firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), agents: ["opencode"] };
});
after(() => { closeDb(); process.chdir(cwd); safeRmSync(dir); });

describe("change receipt outcome lines", () => {
  it("states coverage, dependencies and rework risk from stored facts", () => {
    const body = get(`/p/${project.id}/c/${withLookup}`).body;
    expect(body).toContain("Changed lines");
    expect(body).toContain("a passing run ran 3 of 4 changed executable lines (75%)");
    expect(body).toContain("1 line(s) in 1 file(s) no test ran");
    expect(body).toContain("A finder of gaps, not a target");
    expect(body).toContain("Dependencies added");
    expect(body).toContain("2 package name(s) added or raised; 1 not found in the registry (left-padz); no known advisory among 2 exact version(s), 1 not checked (no answer)");
    expect(body).toContain("Rework risk");
    expect(body).toContain("too recent to judge");
  });
  it("says not measured and not checked when nothing was recorded, never none or covered", () => {
    const body = get(`/p/${project.id}/c/${plain}`).body;
    expect(body).toContain("not measured (only JavaScript and TypeScript runs");
    expect(body).toContain("not recorded: no dependency lookup ran for this change");
    expect(body).toContain("This does not mean none were added");
    expect(body).toContain("not judged: the change did not land, or its record entry was not matched");
  });
});

describe("project page", () => {
  it("shows the four-week trend and the process panel with its denominators", () => {
    const body = get(`/p/${project.id}`).body;
    expect(body).toContain("Four weeks");
    expect(body).toContain("Counts, not a score");
    expect(body).toContain("Process");
    expect(body).toContain("1 repair escalation(s)");
    expect(body).toContain("1 library hit(s) among 1 escalation(s)");
    expect(body).toContain("3 of 4 across 1 run(s)");
    expect(body).toContain("opencode 1");
    expect(body).not.toMatch(/\bscore out of\b/i);
  });
});

describe("telemetry preview and the how page", () => {
  it("shows the exact payload and says nothing is sent", () => {
    const r = get("/telemetry");
    expect(r.status).toBe(200);
    expect(r.body).toContain("Upload is not available in this version");
    expect(r.body).toContain("&quot;commands&quot;: 3");
  });
  it("a source without telemetry information says so instead of failing", () => {
    expect(get("/telemetry", source(false)).body).toContain("no telemetry information");
  });
  it("the telemetry route sits behind the same token and Host checks", () => {
    expect(handleRequest({ method: "GET", url: "/telemetry", host: "evil.example", cookie: `purix_dash=${TOKEN}` }, source(), TOKEN, 9999).status).toBe(403);
    expect(handleRequest({ method: "GET", url: "/telemetry", host: "127.0.0.1:9999", cookie: undefined }, source(), TOKEN, 9999).status).toBe(403);
  });
  it("the how page explains the new numbers and no longer lists built work as not built", () => {
    const body = get("/how").body;
    expect(body).toContain("Changed lines a test ran");
    expect(body).toContain("Four-week trend");
    expect(body).not.toContain("Not built yet");
  });
});

describe("check state on cards and the per-agent split", () => {
  const withCheck = (state: import("./check_state.js").CardCheckState): DashboardSource => ({ ...source(), checkState: () => state });
  it("shows the check state on the home card and asks the browser to reload while it is running", () => {
    const home = get("/", withCheck({ kind: "checking" })).body;
    expect(home).toContain("checking");
    expect(home).toContain('http-equiv="refresh"');
    const done = get("/", withCheck({ kind: "done", outcome: "pass", summary: "Nothing drifted.", at: 0, refreshing: false })).body;
    expect(done).toContain("clean");
    expect(done).toContain("Nothing drifted.");
    expect(done).not.toContain('http-equiv="refresh"');
  });
  it("a failed or slow check is 'could not be checked', and a problem is flagged", () => {
    expect(get("/", withCheck({ kind: "unavailable", why: "took longer than 20 seconds", at: 0, refreshing: false })).body).toContain("could not be checked");
    expect(get(`/p/${project.id}`, withCheck({ kind: "done", outcome: "fail", summary: "2 files drifted", at: 0, refreshing: false })).body).toContain("problem found");
  });
  it("a source with no check state shows no check row", () => {
    expect(get("/").body).not.toContain("purix check</code></dt>");
  });
  it("escapes what the check reports", () => {
    const body = get("/", withCheck({ kind: "done", outcome: "fail", summary: "<img src=x onerror=alert(1)>", at: 0, refreshing: false })).body;
    expect(body).not.toContain("<img src=x");
    expect(body).toContain("&lt;img");
  });
});

import { agentSplit, riskyFilesLine } from "./pages.js";
import type { ChangeRecord } from "@purix/core/observe/ledger_reader";

describe("agentSplit", () => {
  const ch = (o: Partial<ChangeRecord>): ChangeRecord => ({ changeId: "c", startedAt: "", endedAt: "", durationMs: 1000, component: null, operation: null, agent: "opencode", result: "landed", failedBeforePass: 0, testCounts: null, verifyMs: null, isolation: null, notTested: [], notChecked: [], securityAdvisories: 0, stops: [], waitedForPersonMs: null, approvals: { asked: 0, approved: 0, denied: 0 }, modelCalls: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, costUsd: 0.1, landedKind: null, landedVersion: null, helped: null, changedCoverage: null, dependencies: null, ...o });
  it("splits one record by agent, keeps the denominators, and names a missing agent", () => {
    const rows = agentSplit([ch({}), ch({ failedBeforePass: 2, durationMs: 3000 }), ch({ agent: "codex", result: "stopped", failedBeforePass: null, stops: [{ kind: "precheck_block" as never, reason: "r", at: "", component: null, detail: {} }] }), ch({ agent: null })]);
    const oc = rows.find((r) => r.agent === "opencode")!;
    expect(oc).toMatchObject({ changes: 2, landed: 2, verified: 2, passedFirst: 1, medianLandedMs: 2000 });
    expect(oc.costLandedUsd).toBeCloseTo(0.2);
    expect(rows.find((r) => r.agent === "codex")).toMatchObject({ changes: 1, landed: 0, stopped: 1, verified: 0, medianLandedMs: null });
    expect(rows.find((r) => r.agent === "(no agent recorded)")!.changes).toBe(1);
    expect(rows[0]!.agent).toBe("opencode");
  });
});

describe("security panel: risky files by pattern", () => {
  it("says none when nothing was stopped, and otherwise names kinds of file, escaped, never names", () => {
    expect(riskyFilesLine({ stopsWithFiles: 0, stopsWithoutFiles: 0, patterns: [] })).toContain("none in this range");
    const line = riskyFilesLine({ stopsWithFiles: 3, stopsWithoutFiles: 1, patterns: [
      { pattern: ".env*", stops: 2, categories: { "AWS access key": 2, b: 1 } }, { pattern: "*.<b>", stops: 1, categories: {} } ] });
    expect(line).toContain(".env* 2 (AWS access key 2, b 1)");
    expect(line).toContain("*.&lt;b&gt; 1");
    expect(line).toContain("1 stop(s) named no file");
    expect(line).toContain("not a verdict");
  });
});
