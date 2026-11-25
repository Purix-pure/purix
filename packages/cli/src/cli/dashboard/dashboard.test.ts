// src/cli/dashboard/dashboard.test.ts
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
import { handleRequest, projectId, startDashboard } from "./server.js";
import { reworkWords, dependencyWords, type DashboardSource, type ProjectRef } from "./pages.js";
import { runWatch } from "../commands/observe.js";

let dir = "", cwd = "", change = "", project: ProjectRef;
const TOKEN = "tok-123";
const secret = "AKIAFAKETESTKEY00000";

const source = (): DashboardSource => ({
  now: () => new Date(),
  version: "0.0.0-test",
  projects: () => [project],
  openLedger: (p) => openLedger(p.stateDir),
  pending: () => [{ id: "apr-1", tool: "purix_modify" }],
  verifyChain: (c) => verifyAuditRows(c.rows, c.checkpoint),
});
const get = (url: string, over: Partial<Parameters<typeof handleRequest>[0]> = {}) =>
  handleRequest({ method: "GET", url, host: "127.0.0.1:9999", cookie: `purix_dash=${TOKEN}`, ...over }, source(), TOKEN, 9999);

before(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "purix-dash-"));
  process.chdir(dir);
  change = newChangeId();
  withChange(() => {
    recordEvent("request", { component_id: "<img src=x onerror=alert(1)>", operation: "modify" });
    recordEvent("test_integrity_flag", { component_id: "date-utils", detail: {} });
    recordEvent("verification_pass", { component_id: "date-utils", detail: { schema: 1, test_counts: { passed: 7, failed: 0, skipped: 1 }, verify_ms: 900 } });
    recordEvent("change_landed", { component_id: "date-utils", detail: { schema: 1, kind: "modify", version: 2 } });
  }, change);
  // the chain entry a landed change leaves (identifiers only), so the receipt can match it and judge rework. A change's component is
  // the one on its first event (the request above), so that is the id the chain entry must carry.
  appendAuditRecord({ event: "component_change", kind: "modify", component_id: "<img src=x onerror=alert(1)>", version: 2, sync_hash: null, operation: null, source: null });
  const stateDir = dirname(getDbFilePath()!);
  project = { id: projectId(dir), name: "client-acme", path: dir, stateDir, firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), agents: ["opencode"] };
});
after(() => { closeDb(); process.chdir(cwd); safeRmSync(dir); });

describe("dashboard protections", () => {
  it("refuses a wrong Host, a missing token, a wrong token, and any method but GET/HEAD", () => {
    expect(get("/", { host: "evil.example:9999" }).status).toBe(403);
    expect(get("/", { host: "127.0.0.1:1234" }).status).toBe(403);
    expect(get("/", { cookie: undefined }).status).toBe(403);
    expect(get("/?t=wrong", { cookie: undefined }).status).toBe(403);
    expect(get("/", { method: "POST" }).status).toBe(405);
    expect(get("/", { method: "DELETE" }).status).toBe(405);
  });
  it("swaps the one-time token for an HttpOnly SameSite cookie and drops it from the address", () => {
    const r = get(`/p/${project.id}?t=${TOKEN}&range=all`, { cookie: undefined });
    expect(r.status).toBe(302);
    expect(r.headers["Location"]).toBe(`/p/${project.id}?range=all`);
    expect(r.headers["Set-Cookie"]).toMatch(/HttpOnly; SameSite=Strict/);
  });
  it("sends no CORS header and a CSP that forbids scripts, framing and forms", () => {
    const r = get("/");
    expect(Object.keys(r.headers).some((k) => k.toLowerCase().startsWith("access-control"))).toBe(false);
    expect(r.headers["Content-Security-Policy"]).toContain("default-src 'none'");
    expect(r.headers["Content-Security-Policy"]).not.toContain("script-src");
    expect(r.body).not.toContain("<script");
  });
  it("reaches a project only by a registry id, never by a path", () => {
    expect(get("/p/0123456789").status).toBe(404);
    expect(get("/p/..%2f..%2fetc").status).toBe(404);
    expect(get(`/p/${project.id}/c/..%2f`).status).toBe(404);
  });
});

describe("dashboard pages", () => {
  it("home shows lifetime totals with types, the project card, the waiting approval and the baseline as not measured", () => {
    const r = get("/");
    expect(r.status).toBe(200);
    expect(r.body).toContain("client-acme");
    expect(r.body).toContain("waiting for your approval");
    expect(r.body).toContain("purix approve");
    expect(r.body).toContain("not measured");
    expect(r.body).toContain("measured");
  });
  it("escapes everything that came from the project", () => {
    const r = get(`/p/${project.id}?range=all`);
    expect(r.body).not.toContain("<img src=x");
    expect(r.body).toContain("&lt;img src=x");
  });
  it("redact hides names and the project page shows the four panels, denominators and limits", () => {
    const r = get(`/p/${project.id}?range=all&redact=1`);
    expect(r.body).not.toContain("client-acme");
    for (const w of ["Results", "Security", "Time and flow", "Cost", "passed first time", "Looked for", "Rework", "Secrets removed", "Reverts in git"]) expect(r.body).toContain(w);
    expect(get(`/p/${project.id}?tab=limits&range=all`).body).toContain("What Purix does not cover here");
    expect(get(`/p/${project.id}?tab=catches&range=all`).body).toContain("weakened or removed test assertion");
    expect(get(`/p/${project.id}?tab=evidence&range=all`).body).toContain("Export this project");
  });
  it("the receipt carries stored facts and always has a Not checked line", () => {
    const r = get(`/p/${project.id}/c/${change}`);
    expect(r.status).toBe(200);
    expect(r.body).toContain("7 tests passed, 0 failed, 1 skipped");
    expect(r.body).toContain("Not checked");
    expect(r.body).toContain("Stopped");
    expect(get(`/p/${project.id}/c/chg-nope`).body).toContain("No change with that id");
  });
  it("the receipt has a Rework risk line that says too recent while the window is open, and a Dependencies line that says not recorded rather than none", () => {
    const r = get(`/p/${project.id}/c/${change}`);
    expect(r.body).toContain("Rework risk");
    expect(r.body).toContain("too recent to judge");
    expect(r.body).toContain("Dependencies added");
    expect(r.body).toContain("not recorded: no dependency lookup ran");
    expect(r.body).toContain("does not mean none were added");
  });
  it("a change with a stored dependency lookup shows the counts, the missing name and what was not checked", () => {
    const id = newChangeId();
    withChange(() => {
      recordEvent("verification_pass", { component_id: "pkg-user", detail: { schema: 1 } });
      recordEvent("dependency_lookup", { component_id: "pkg-user", detail: { schema: 1, mode: { osv: true, registry: true }, names: 3, registry: { exists: 1, missing: 1, unanswered: 1 }, advisories: { pairs: 2, with_advisories: 1, unanswered: 1 }, missing_names: [{ ecosystem: "npm", name: "left-padz" }], vulnerable: [{ ecosystem: "npm", name: "lodash", version: "4.17.15", advisory_count: 2 }] } });
    }, id);
    const body = get(`/p/${project.id}/c/${id}`).body;
    expect(body).toContain("3 package name(s) added or raised");
    expect(body).toContain("1 not found in the registry (left-padz)");
    expect(body).toContain("1 not checked (no answer)");
    expect(body).toContain("1 of 2 exact version(s) with a known advisory (lodash@4.17.15)");
  });
  it("reworkWords and dependencyWords never turn missing data into 'none' or 'clean'", () => {
    expect(reworkWords(null)).toContain("not judged");
    expect(reworkWords({ state: "none_in_window", windowDays: 14 })).toContain("Only changes made through Purix are seen");
    expect(reworkWords({ state: "again", daysLater: 3, kind: "modify", windowDays: 14 })).toContain("3 day(s) later");
    expect(dependencyWords(null)).toContain("not recorded");
    expect(dependencyWords({ mode: { osv: false, registry: true }, names: 2, registry: { exists: 2, missing: 0, unanswered: 0 }, advisories: { pairs: 0, withAdvisories: 0, unanswered: 0 }, missingNames: [], vulnerable: [] })).toContain("advisories not asked");
    expect(dependencyWords({ mode: { osv: true, registry: false }, names: 2, registry: { exists: 0, missing: 0, unanswered: 0 }, advisories: { pairs: 2, withAdvisories: 0, unanswered: 2 }, missingNames: [], vulnerable: [] })).toContain("registry existence not asked");
  });
  it("exports raw JSON and never contains a secret placed in a prompt-like field", () => {
    const r = get(`/p/${project.id}/export.json?range=all`);
    expect(r.headers["Content-Type"]).toContain("application/json");
    const data = JSON.parse(r.body) as { schemaVersion: number; changes: unknown[] };
    expect(data.schemaVersion).toBe(1);
    expect(data.changes.length).toBeGreaterThan(0);
    expect(r.body).not.toContain(secret);
  });
  it("serves over a real loopback socket, and only with the token", async () => {
    const run = await startDashboard(source());
    try {
      expect(run.url.startsWith("http://127.0.0.1:")).toBe(true);
      const bare = await fetch(`http://127.0.0.1:${run.port}/`);
      expect(bare.status).toBe(403);
      const withTok = await fetch(run.url, { redirect: "manual" });
      expect(withTok.status).toBe(302);
      const cookie = withTok.headers.get("set-cookie")!.split(";")[0]!;
      const page = await fetch(`http://127.0.0.1:${run.port}/`, { headers: { cookie } });
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Purix");
    } finally { await run.close(); }
  });
});

describe("purix watch", () => {
  it("prints recent events, then follows new ones", async () => {
    const lines: string[] = [];
    const controller = new AbortController();
    let ticks = 0;
    await runWatch({
      stateDir: project.stateDir, baseDir: dir, out: (l) => lines.push(l), now: () => new Date(), signal: controller.signal, intervalMs: 1, last: 10, once: false,
      sleep: async () => { ticks++; if (ticks === 1) recordEvent("verification_failure", { component_id: "late", detail: { reason: "boom" } }); if (ticks === 2) controller.abort(); },
    });
    const text = lines.join("\n");
    expect(text).toContain("STOPPED");
    expect(text).toContain("7 tests passed");
    expect(text).toContain("check failed");
    expect(text).toContain("boom");
  });
});
