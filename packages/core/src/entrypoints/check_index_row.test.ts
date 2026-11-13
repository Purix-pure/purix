// F05-09: the aggregate `purix-codebase-index` row is Purix's own listing of indexed files, not a governed component. Its status
// ("fail" when any indexed file failed verification) must not make `purix check` or the evidence bundle report a failure, or count
// as a governed component. A governed component that fails still fails.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManifestEntry } from "../manifest/schema";
import { closeDb, writeManifest } from "../manifest/store";
import { appendAuditRecord } from "../security/audit_tamper_evidence";
import { computeSyncHash } from "../state/hash";
import { safeRmSync } from "../platform/fs_retry.js";
import { buildEvidenceBundle, overallOutcome, trailerLines } from "../evidence/evidence.js";
import { runCheck } from "./check";

let originalCwd: string;
let dir: string;
const SRC = "export const a = 1;\n";
const BROKEN = "export const b = ;\n";

function entry(over: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    component_id: "comp-a", component_type: "module", current_version: 1, schema_version: 5,
    parts: { tools: [], config: {} }, files: ["a.ts"], depends_on: [], depended_on_by: [], version_history: [],
    verification_status: "pass", last_synced_hash: computeSyncHash([{ path: "a.ts", content: SRC }]), ...over,
  };
}

/** What `purix index` leaves behind when one indexed file is broken: a passing governed component plus an index row that says "fail". */
function governedPlusFailedIndex(): void {
  writeFileSync(join(dir, "a.ts"), SRC);
  writeFileSync(join(dir, "broken.ts"), BROKEN);
  writeManifest(entry());
  writeManifest(entry({
    component_id: "purix-codebase-index", component_type: "codebase_index", files: ["broken.ts"],
    verification_status: "fail", last_synced_hash: computeSyncHash([{ path: "broken.ts", content: BROKEN }]),
  }));
  appendAuditRecord({ event: "test_setup" });
  closeDb();
}

beforeEach(() => { originalCwd = process.cwd(); dir = mkdtempSync(join(tmpdir(), "purix-check-index-")); process.chdir(dir); });
afterEach(() => { closeDb(); process.chdir(originalCwd); safeRmSync(dir); });

describe("F05-09: the index row is not a governed component", () => {
  it("purix check does not fail, or count it, because the index row's status is fail", () => {
    governedPlusFailedIndex();
    const r = runCheck();
    const verification = r.sections.find((s) => s.id === "verification")!;
    expect(verification.items.filter((i) => i.subject === "purix-codebase-index")).toEqual([]);
    expect(r.outcome).not.toBe("fail");
    expect(r.exitCode).toBe(0);
    expect(r.summary).toMatch(/1 governed component/);
  });

  it("a governed component that fails verification still fails the check", () => {
    governedPlusFailedIndex();
    writeManifest(entry({ verification_status: "fail" }));
    closeDb();
    const r = runCheck();
    expect(r.outcome).toBe("fail");
    const items = r.sections.find((s) => s.id === "verification")!.items;
    expect(items.map((i) => i.subject)).toEqual(["comp-a"]);
    expect(r.summary).toMatch(/1 problem\(s\) across 1 governed component/);
  });

  it("the evidence bundle leaves the index row out, so the trailer does not say fail for it", () => {
    governedPlusFailedIndex();
    const res = buildEvidenceBundle();
    expect(res.state).toBe("ok");
    if (res.state !== "ok") return;
    expect(res.bundle.components.map((c) => c.id)).toEqual(["comp-a"]);
    expect(overallOutcome(res.bundle.components)).toBe("pass");
    expect(trailerLines(res.bundle)).toContain("Purix-Verified: pass");
  });

  it("a project with only the index row governs nothing", () => {
    writeFileSync(join(dir, "broken.ts"), BROKEN);
    writeManifest(entry({
      component_id: "purix-codebase-index", component_type: "codebase_index", files: ["broken.ts"],
      verification_status: "fail", last_synced_hash: computeSyncHash([{ path: "broken.ts", content: BROKEN }]),
    }));
    appendAuditRecord({ event: "test_setup" });
    closeDb();
    const r = runCheck();
    expect(r.summary).toMatch(/Nothing was checked|0 governed/);
    expect(r.sections.find((s) => s.id === "verification")!.items).toEqual([]);
  });
});

// Found by a Linux run on 2026-11-11 (previous session's note, reproduced here): after `purix index`, hand-editing any indexed file made plain
// `purix check` fail in "Edits made outside Purix: purix-codebase-index changed ... across 0 governed components", while the hook said the same
// file is "not governed". F05-09 took the index row out of the verification section only; the drift section still walked it. The index row is
// Purix's own listing, not a governed component, so a change to a file it lists is not drift. (Edits an agent makes to such a file are named by
// the C5 "unadopted write" item instead.)
describe("F05-09 (drift section): editing an indexed file is not drift on the index row", () => {
  it("purix check passes, and names no drift item for the index row, after an indexed file is edited", () => {
    governedPlusFailedIndex();
    writeManifest(entry({
      component_id: "purix-codebase-index", component_type: "codebase_index", files: ["broken.ts"],
      verification_status: "pass", last_synced_hash: computeSyncHash([{ path: "broken.ts", content: BROKEN }]),
    }));
    closeDb();
    writeFileSync(join(dir, "broken.ts"), "export const b = 2;\n"); // edited by hand after the index
    const r = runCheck();
    const drift = r.sections.find((s) => s.id === "drift")!;
    expect(drift.items.filter((i) => i.subject === "purix-codebase-index")).toEqual([]);
    expect(r.exitCode).toBe(0);
  });
  it("control: a governed component edited outside Purix is still drift and still fails", () => {
    governedPlusFailedIndex();
    writeFileSync(join(dir, "a.ts"), "export const a = 99;\n");
    const r = runCheck();
    const drift = r.sections.find((s) => s.id === "drift")!;
    expect(drift.items.some((i) => i.subject === "comp-a" && i.outcome === "fail")).toBe(true);
    expect(r.exitCode).not.toBe(0);
  });
});
