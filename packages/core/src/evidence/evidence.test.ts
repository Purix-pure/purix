// src/evidence/evidence.test.ts
// Real SQLite store in a real temp directory: the bundle must come from the real chain, and the read must change nothing.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManifestEntry } from "../manifest/schema";
import { closeDb, getDbCompat as getDb, writeManifest } from "../manifest/store";
import { appendAuditRecord, pruneAuditChain, verifyAuditRows } from "../security/audit_tamper_evidence";
import { recordEvent } from "../manifest/events";
import { computeSyncHash } from "../state/hash";
import { buildEvidenceBundle, bundleFromSnapshot, overallOutcome, trailerLines, applyTrailers, renderPrReport, verifyBundleChain, GENESIS_HASH } from "./evidence";

let cwd: string;
let dir: string;

function entry(id: string, over: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    component_id: id, component_type: "module", current_version: 1, schema_version: 5,
    parts: { tools: [], config: {} }, files: [`${id}.ts`], depends_on: [], depended_on_by: [], version_history: [],
    verification_status: "pass", last_synced_hash: computeSyncHash([{ path: `${id}.ts`, content: "x" }]), ...over,
  };
}

beforeEach(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "purix-evidence-"));
  process.chdir(dir);
});
afterEach(() => {
  closeDb();
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

function seed() {
  writeManifest(entry("alpha"));
  writeManifest(entry("beta"));
  recordEvent("verification_pass", { component_id: "beta", detail: { not_tested: ["beta.ts"] } });
  appendAuditRecord({ event: "one" });
  appendAuditRecord({ event: "two" });
  closeDb();
}

describe("evidence bundle", () => {
  it("is absent when there is no store, and never creates one", () => {
    expect(buildEvidenceBundle().state).toBe("absent");
    expect(buildEvidenceBundle().state).toBe("absent");
  });

  it("carries the real chain, its head, and per-component gaps", () => {
    seed();
    const r = buildEvidenceBundle();
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect(r.bundle.schema).toBe("purix.evidence/1");
    expect(r.bundle.head.record_count).toBe(2);
    expect(r.bundle.head.hash).toBe(r.bundle.chain.rows[1]!.hash);
    expect(verifyBundleChain(r.bundle).valid).toBe(true);
    expect(r.bundle.components.map((c) => c.id)).toEqual(["alpha", "beta"]);
    expect(r.bundle.components.find((c) => c.id === "beta")!.not_tested).toEqual(["beta.ts"]);
    expect(r.bundle.components.find((c) => c.id === "alpha")!.not_tested).toEqual([]);
  });

  it("an empty chain has the genesis head", () => {
    writeManifest(entry("alpha"));
    closeDb();
    const r = buildEvidenceBundle();
    if (r.state !== "ok") throw new Error("expected ok");
    expect(r.bundle.head).toEqual({ hash: GENESIS_HASH, record_count: 0 });
  });

  it("reading changes nothing in the store file", () => {
    seed();
    const before = readFileSync(join(dir, ".purix", "manifest.db"));
    buildEvidenceBundle();
    expect(readFileSync(join(dir, ".purix", "manifest.db")).equals(before)).toBe(true);
  });
});

describe("overallOutcome and trailer lines", () => {
  const c = (status: string, not_tested: string[] = []) => ({ id: "x", version: 1, status, files: ["x.ts"], not_tested });
  it("fail beats skipped beats pass; nothing governed is not-applicable", () => {
    expect(overallOutcome([])).toBe("not-applicable");
    expect(overallOutcome([c("pass")])).toBe("pass");
    expect(overallOutcome([c("pass", ["x.ts"])])).toBe("skipped");
    expect(overallOutcome([c("pending")])).toBe("skipped");
    expect(overallOutcome([c("pass", ["x.ts"]), c("fail")])).toBe("fail");
  });
  it("a skipped component never renders as verified in the trailer", () => {
    seed();
    const r = buildEvidenceBundle();
    if (r.state !== "ok") throw new Error("expected ok");
    const lines = trailerLines(r.bundle);
    expect(lines[0]).toBe(`Purix-Evidence: sha256:${r.bundle.head.hash}`);
    expect(lines).toContain("Purix-Records: 2");
    expect(lines).toContain("Purix-Verified: skipped");
    expect(lines).toContain("Purix-Not-Tested: 1 file(s)");
  });
});

describe("applyTrailers", () => {
  const L = ["Purix-Evidence: sha256:" + "a".repeat(64), "Purix-Records: 2", "Purix-Verified: pass"];
  it("adds a trailer block after a blank line and is idempotent", () => {
    const once = applyTrailers("Add parser\n\nLonger body.\n", L);
    expect(once).toBe("Add parser\n\nLonger body.\n\n" + L.join("\n") + "\n");
    expect(applyTrailers(once, L)).toBe(once);
  });
  it("replaces older Purix trailers and keeps other trailers", () => {
    const old = "Fix\n\nSigned-off-by: A <a@b.c>\nPurix-Evidence: sha256:" + "b".repeat(64) + "\nPurix-Records: 1\n";
    const next = applyTrailers(old, L);
    expect(next.match(/Purix-Evidence/g)!.length).toBe(1);
    expect(next).toContain("Signed-off-by: A <a@b.c>");
    expect(next).toContain("Purix-Records: 2");
  });
  it("handles an empty message and CRLF", () => {
    expect(applyTrailers("", L)).toBe(L.join("\n") + "\n");
    expect(applyTrailers("Fix\r\n", L)).toBe("Fix\r\n\r\n" + L.join("\r\n") + "\r\n");
  });
});

describe("renderPrReport", () => {
  it("says what was not verified and what the evidence does not show", () => {
    seed();
    const r = buildEvidenceBundle();
    if (r.state !== "ok") throw new Error("expected ok");
    const report = renderPrReport(r.bundle, verifyBundleChain(r.bundle));
    expect(report).toContain("**Result: skipped.**");
    expect(report).toContain("Not tested: no test is related to beta.ts");
    expect(report).toContain(r.bundle.head.hash);
    expect(report).toContain("does not show the tests were meaningful");
    expect(report).not.toMatch(/<[a-z]/i); // no HTML
  });
  it("reports a broken chain as not intact", () => {
    seed();
    const r = buildEvidenceBundle();
    if (r.state !== "ok") throw new Error("expected ok");
    r.bundle.chain.rows[0]!.payload = '{"event":"forged"}';
    const report = renderPrReport(r.bundle, verifyBundleChain(r.bundle));
    expect(report).toContain("**not intact**");
  });
});

describe("chain rule (the verifier's twin)", () => {
  it("detects records cut off the front with no checkpoint, which the old rule missed", () => {
    appendAuditRecord({ event: "a" });
    appendAuditRecord({ event: "b" });
    appendAuditRecord({ event: "c" });
    getDb().run("DELETE FROM audit_chain WHERE id = 1");
    closeDb();
    const r = buildEvidenceBundle();
    if (r.state !== "ok") throw new Error("expected ok");
    const v = verifyBundleChain(r.bundle);
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/does not start at its beginning/);
  });
  it("a pruned chain with its checkpoint still verifies, and the same rows without it do not", () => {
    appendAuditRecord({ event: "a" });
    appendAuditRecord({ event: "b" });
    pruneAuditChain(-60_000); // a cutoff in the future prunes everything so far
    appendAuditRecord({ event: "c" });
    closeDb();
    const r = buildEvidenceBundle();
    if (r.state !== "ok") throw new Error("expected ok");
    expect(r.bundle.chain.checkpoint).not.toBeNull();
    expect(r.bundle.head.record_count).toBe(1);
    expect(verifyBundleChain(r.bundle).valid).toBe(true);
    const withoutCheckpoint = { ...r.bundle, chain: { ...r.bundle.chain, checkpoint: null } };
    expect(verifyBundleChain(withoutCheckpoint).valid).toBe(false);
  });
  it("bundleFromSnapshot works on an empty snapshot", () => {
    const b = bundleFromSnapshot({ manifest: [], pending: [], verificationPasses: [], auditRows: [], auditCheckpoint: null }, new Date(0));
    expect(b.head.hash).toBe(GENESIS_HASH);
    expect(overallOutcome(b.components)).toBe("not-applicable");
  });
});
