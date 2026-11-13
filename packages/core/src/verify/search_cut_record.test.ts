// F06-05 (remainder): a test search that hit its file limit is said aloud at run time (sandbox_not_tested.test.ts), but the stored
// verification_pass event, `purix check` and the evidence report still used the generic "no test is related" sentence, which for a
// cut-off search is a claim nobody checked. These tests pin that the flag travels: sandbox result -> event -> check and evidence.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManifestEntry } from "../manifest/schema";
import { closeDb, writeManifest } from "../manifest/store.js";
import { listEvents, recordEvent } from "../manifest/events.js";
import { appendAuditRecord } from "../security/audit_tamper_evidence.js";
import { computeSyncHash } from "../state/hash.js";
import { safeRmSync } from "../platform/fs_retry.js";
import { typescriptProvider } from "../language/providers/typescript.js";
import { resolveVerification } from "../recovery/resolve_verification.js";
import { buildEvidenceBundle, renderPrReport, verifyBundleChain } from "../evidence/evidence.js";
import { runCheck } from "../entrypoints/check.js";

let cwd: string, dir: string, logs: string[], realLog: typeof console.log;
beforeEach(() => { cwd = process.cwd(); dir = mkdtempSync(join(tmpdir(), "purix-cut-rec-")); process.chdir(dir); logs = []; realLog = console.log; console.log = (...a: unknown[]) => { logs.push(a.join(" ")); }; });
afterEach(() => { console.log = realLog; closeDb(); process.chdir(cwd); safeRmSync(dir); });

const SRC = "export const a = 1;\n";
function entry(): ManifestEntry {
  return {
    component_id: "comp-a", component_type: "module", current_version: 1, schema_version: 5,
    parts: { tools: [], config: {} }, files: ["a.ts"], depends_on: [], depended_on_by: [], version_history: [],
    verification_status: "pass", last_synced_hash: computeSyncHash([{ path: "a.ts", content: SRC }]),
  };
}
function governedWithPass(detail: Record<string, unknown>): void {
  writeFileSync(join(dir, "a.ts"), SRC);
  writeManifest(entry());
  recordEvent("verification_pass", { component_id: "comp-a", operation: "modify", detail });
  appendAuditRecord({ event: "test_setup" });
  closeDb();
}

describe("F06-05: the cut-off search reaches the stored record", () => {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const real = { verify: typescriptProvider.verify, runTests: typescriptProvider.runTests, checkIdiom: typescriptProvider.checkIdiom };
  afterEach(() => { Object.assign(typescriptProvider, real); });

  const stubTests = (truncated: boolean) => {
    typescriptProvider.verify = () => ({ status: "pass", isolation: "none" });
    typescriptProvider.runTests = () => ({ status: "pass", quarantinedFailures: [], discovery: { tests: ["a.test.ts"], uncovered: [], truncated } });
    typescriptProvider.checkIdiom = () => ({ ran: true, findings: [] });
  };
  const run = (component: string) =>
    resolveVerification(component, "update_prompt_text", [{ path: "src/a.ts", content: "a" }], [{ path: "src/a.ts", new_content: "b" }], "direct_patch", "x", dir);

  it("a pass whose test search was cut off records test_search_cut on the verification_pass event", async () => {
    stubTests(true);
    const r = await run("comp-cut");
    expect("verification" in r && r.verification.status === "pass" && r.verification.testSearchCut).toBe(true);
    const ev = listEvents({ kind: "verification_pass", componentId: "comp-cut" });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.detail.not_tested).toEqual(["src/a.ts"]);
    expect(ev[0]!.detail.test_search_cut).toBe(true);
  });

  it("a finished search records no test_search_cut field", async () => {
    stubTests(false);
    const r = await run("comp-done");
    expect("verification" in r && r.verification.status === "pass" && r.verification.testSearchCut).toBeFalsy();
    const ev = listEvents({ kind: "verification_pass", componentId: "comp-done" });
    expect(ev).toHaveLength(1);
    expect("test_search_cut" in ev[0]!.detail).toBe(false);
  });
});

describe("F06-05: purix check and the evidence report use the words that are true", () => {
  it("purix check says the search stopped at its file limit, not that no test is related", () => {
    governedWithPass({ stage: "direct_patch", isolation: "none", not_tested: ["a.ts"], test_search_cut: true });
    const msg = runCheck().sections.find((s) => s.id === "verification")!.items.map((i) => i.message).join("\n");
    expect(msg).toContain("file limit");
    expect(msg).not.toContain("no test is related");
  });

  it("purix check keeps the generic sentence when the search finished", () => {
    governedWithPass({ stage: "direct_patch", isolation: "none", not_tested: ["a.ts"] });
    const msg = runCheck().sections.find((s) => s.id === "verification")!.items.map((i) => i.message).join("\n");
    expect(msg).toContain("no test is related to a.ts");
    expect(msg).not.toContain("file limit");
  });

  it("a later pass whose search finished clears the cut-off flag", () => {
    writeFileSync(join(dir, "a.ts"), SRC);
    writeManifest(entry());
    recordEvent("verification_pass", { component_id: "comp-a", detail: { not_tested: ["a.ts"], test_search_cut: true } });
    recordEvent("verification_pass", { component_id: "comp-a", detail: { not_tested: ["a.ts"] } });
    appendAuditRecord({ event: "test_setup" });
    closeDb();
    const msg = runCheck().sections.find((s) => s.id === "verification")!.items.map((i) => i.message).join("\n");
    expect(msg).not.toContain("file limit");
  });

  it("the evidence bundle marks the component and the PR report says the search was cut off", () => {
    governedWithPass({ stage: "direct_patch", isolation: "none", not_tested: ["a.ts"], test_search_cut: true });
    const res = buildEvidenceBundle();
    expect(res.state).toBe("ok");
    if (res.state !== "ok") return;
    expect(res.bundle.components[0]!.test_search_cut).toBe(true);
    const report = renderPrReport(res.bundle, verifyBundleChain(res.bundle));
    expect(report).toContain("file limit");
    expect(report).not.toContain("no test is related");
  });

  it("the evidence bundle has no test_search_cut field when the search finished", () => {
    governedWithPass({ stage: "direct_patch", isolation: "none", not_tested: ["a.ts"] });
    const res = buildEvidenceBundle();
    if (res.state !== "ok") throw new Error("bundle not ok");
    expect("test_search_cut" in res.bundle.components[0]!).toBe(false);
  });
});

// C3 item 4: one language's search cut, another's finished. Only the files the cut search covered are worded as cut.
describe("C3 item 4: the per-file cut list reaches check and evidence", () => {
  it("check and the PR report word only the cut file as cut", () => {
    governedWithPass({ not_tested: ["a.ts", "b.py"], test_search_cut: true, test_search_cut_files: ["b.py"] });
    const check = runCheck().sections.find((x) => x.id === "verification")!.items.map((i) => i.message).join("\n");
    expect(check).toContain("no test is related to a.ts");
    expect(check).toContain("stopped at its file limit, so no test could be shown to cover b.py");
    const r = buildEvidenceBundle();
    expect(r.state).toBe("ok");
    if (r.state === "ok") {
      expect(r.bundle.components[0]!.test_search_cut_files).toEqual(["b.py"]);
      const report = renderPrReport(r.bundle, verifyBundleChain(r.bundle));
      expect(report).toContain("no test is related to a.ts");
      expect(report).toContain("so no test could be shown to cover b.py");
    }
  });

  it("an older record with no list still words every untested file as cut", () => {
    governedWithPass({ not_tested: ["a.ts", "b.py"], test_search_cut: true });
    const check = runCheck().sections.find((x) => x.id === "verification")!.items.map((i) => i.message).join("\n");
    expect(check).toContain("so no test could be shown to cover a.ts, b.py");
  });
});

describe("C4 follow-up: security notes reach the stored record and purix check", () => {
  it("the latest pass's advisories and unread files are listed in the verification section, as notes (pass), not failures", () => {
    governedWithPass({ stage: "test", isolation: "none", security_advisories: [{ path: "package.json", line: 1, category: "Scan Limit" }], security_not_read: ["ci.yml"] });
    const items = runCheck().sections.find((x) => x.id === "verification")!.items.filter((i) => i.subject === "comp-a");
    expect(items.map((i) => i.outcome)).toEqual(["pass", "pass"]);
    expect(items[0]!.message).toMatch(/Scan Limit in package\.json:1/);
    expect(items[1]!.message).toMatch(/did not read 1 file\(s\): ci\.yml/);
  });
  it("a later pass that saw nothing erases the earlier note", () => {
    writeFileSync(join(dir, "a.ts"), SRC);
    writeManifest(entry());
    recordEvent("verification_pass", { component_id: "comp-a", operation: "modify", detail: { security_not_read: ["ci.yml"] } });
    recordEvent("verification_pass", { component_id: "comp-a", operation: "modify", detail: { stage: "test" } });
    appendAuditRecord({ event: "test_setup" });
    closeDb();
    expect(runCheck().sections.find((x) => x.id === "verification")!.items.filter((i) => i.subject === "comp-a")).toEqual([]);
  });
});
