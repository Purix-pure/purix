// src/manifest/audit_export_overrides.test.ts
//
// C3 item 8 (plan v4): `purix audit-log trail` did not show override rows, although F03-09 relies on them as the record of a person
// skipping a gate. Overrides carry no component id, so the trail attaches an override to a landed commit by time: it belongs to the
// version whose window (previous version's timestamp, this version's timestamp] holds it.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAuditTrail, formatAuditTrailJson, formatAuditTrailMarkdown } from "./audit_export";
import { closeDb, writeManifest, getDbCompat } from "./store";
import { recordOverrideAudit } from "../security/override_audit";

function entry(history: { version: number; timestamp: string }[]) {
  return {
    component_id: "greet", component_type: "module" as const, current_version: history.length, schema_version: 4,
    parts: { tools: [], config: {} }, files: ["greet.ts"], depends_on: [], depended_on_by: [],
    version_history: history.map((h) => ({ ...h, operation: "modify", patch_ref: "p" + h.version, contract_changed: false, provenance: { source_type: "instruction" as const, source_agent: "x" } })),
    verification_status: "pass" as const, last_synced_hash: null, language: "typescript",
  };
}

describe("audit trail shows overrides (C3 item 8)", () => {
  let cwd: string;
  let dir: string;
  beforeEach(() => { cwd = process.cwd(); dir = mkdtempSync(join(tmpdir(), "purix-trail-ovr-")); process.chdir(dir); });
  afterEach(() => { closeDb(); process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); });

  it("lists the override that fell inside a landed version's window, with gate, reason and actor", () => {
    const t1 = "2026-11-01T10:00:00.000Z";
    const t2 = "2026-11-01T12:00:00.000Z";
    writeManifest(entry([{ version: 1, timestamp: t1 }, { version: 2, timestamp: t2 }]));
    const o = recordOverrideAudit("SecurityGate", "md5 is only a cache key here", "Weak Cryptography");
    // place the override between the two versions, as a real run would (override recorded, then the change lands)
    getDbCompat().run(`UPDATE override_audits SET timestamp = ? WHERE id = ?`, ["2026-11-01T11:00:00.000Z", o.id]);
    const report = buildAuditTrail();
    const v1 = report.entries.find((e) => e.version === 1)!;
    const v2 = report.entries.find((e) => e.version === 2)!;
    expect(v1.gate_evidence.overrides).toEqual([]);
    expect(v2.gate_evidence.overrides.map((x) => [x.gate_name, x.reason, x.actor])).toEqual([["SecurityGate", "md5 is only a cache key here", "operator"]]);
    expect(formatAuditTrailJson(report)).toContain("md5 is only a cache key here");
    expect(formatAuditTrailMarkdown(report)).toMatch(/Overrides in this window:[\s\S]*SecurityGate[\s\S]*md5 is only a cache key here/);
  });

  it("says plainly when no override was recorded", () => {
    writeManifest(entry([{ version: 1, timestamp: "2026-11-01T10:00:00.000Z" }]));
    expect(formatAuditTrailMarkdown(buildAuditTrail())).toMatch(/Overrides in this window: none recorded/);
  });

  it("an override that matches no landed version is still reported, not dropped", () => {
    writeManifest(entry([{ version: 1, timestamp: "2026-11-01T10:00:00.000Z" }]));
    const o = recordOverrideAudit("BudgetGate", "finish the release", "cost ceiling");
    getDbCompat().run(`UPDATE override_audits SET timestamp = ? WHERE id = ?`, ["2026-11-05T10:00:00.000Z", o.id]);
    const report = buildAuditTrail();
    expect(report.overrides_not_attached.map((x) => x.reason)).toEqual(["finish the release"]);
    expect(formatAuditTrailMarkdown(report)).toMatch(/Overrides not tied to a landed version[\s\S]*finish the release/);
  });
});
