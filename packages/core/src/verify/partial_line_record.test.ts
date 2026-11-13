// F04-04 (remainder): the partial-line flag must reach every place a person reads a verdict, not only the MCP approval message.
// Pinned here: the pure rule for "which components' latest pass followed a partial-line edit", the one function the MCP handler uses to
// decide what to pass on, and the three readers (purix check, the evidence bundle and PR report, purix status).
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManifestEntry } from "../manifest/schema";
import { closeDb, writeManifest } from "../manifest/store.js";
import { recordEvent } from "../manifest/events.js";
import { appendAuditRecord } from "../security/audit_tamper_evidence.js";
import { computeSyncHash } from "../state/hash.js";
import { safeRmSync } from "../platform/fs_retry.js";
import { buildEvidenceBundle, renderPrReport, verifyBundleChain } from "../evidence/evidence.js";
import { runCheck } from "../entrypoints/check.js";
import { latestPartialLineByComponent } from "../manifest/not_tested.js";
import { latestPartialLine, partialLinePathsFor } from "./partial_line_record.js";
import type { CompileResult } from "./compile.js";

const ev = (kind: string, component_id: string | null, detail: Record<string, unknown> = {}) => ({ kind, component_id, detail });
const partial = (c: string, paths: string[]) => ev("anchor_match", c, { outcome: "partial_line", paths });

describe("latestPartialLine: the latest pass carries the flag only if a partial-line edit came after the pass before it", () => {
  it("a partial-line compile followed by a pass is flagged", () => {
    expect(latestPartialLine([partial("c", ["a.ts"]), ev("verification_pass", "c")]).get("c")).toEqual(["a.ts"]);
  });
  it("a later pass with no partial-line edit clears it", () => {
    const m = latestPartialLine([partial("c", ["a.ts"]), ev("verification_pass", "c"), ev("verification_pass", "c")]);
    expect(m.has("c")).toBe(false);
  });
  it("a partial-line edit that never reached a pass is not reported", () => {
    expect(latestPartialLine([partial("c", ["a.ts"])]).has("c")).toBe(false);
  });
  it("components do not leak into each other, and other anchor outcomes and bad details are ignored", () => {
    const m = latestPartialLine([
      partial("c", ["a.ts"]), ev("anchor_match", "d", { outcome: "rescued" }), ev("anchor_match", "d", { outcome: "partial_line", paths: "x" }),
      ev("anchor_match", null, { outcome: "partial_line", paths: ["z.ts"] }), ev("verification_pass", "d"), ev("verification_pass", "c"),
    ]);
    expect([...m.keys()]).toEqual(["c"]);
  });
  it("two partial-line edits before one pass are merged without repeats", () => {
    const m = latestPartialLine([partial("c", ["a.ts"]), partial("c", ["a.ts", "b.ts"]), ev("verification_pass", "c")]);
    expect(m.get("c")).toEqual(["a.ts", "b.ts"]);
  });
});

describe("partialLinePathsFor: what the MCP handler passes on", () => {
  const ok = (p?: string[]): CompileResult => ({ ok: true, files: [], ...(p ? { partialLinePaths: p } : {}) });
  it("passes the paths of a deterministic compile", () => expect(partialLinePathsFor(ok(["a.ts"]), false)).toEqual(["a.ts"]));
  it("passes nothing for an escalation-authored result", () => expect(partialLinePathsFor(ok(["a.ts"]), true)).toBeUndefined());
  it("passes nothing for a refused compile or a compile with no partial edit", () => {
    expect(partialLinePathsFor({ ok: false, reason: "r" }, false)).toBeUndefined();
    expect(partialLinePathsFor(ok(), false)).toBeUndefined();
  });
});

let cwd: string, dir: string;
beforeEach(() => { cwd = process.cwd(); dir = mkdtempSync(join(tmpdir(), "purix-partial-")); process.chdir(dir); });
afterEach(() => { closeDb(); process.chdir(cwd); safeRmSync(dir); });

const SRC = "export const a = 1;\n";
function entry(): ManifestEntry {
  return {
    component_id: "comp-a", component_type: "module", current_version: 1, schema_version: 5,
    parts: { tools: [], config: {} }, files: ["a.ts"], depends_on: [], depended_on_by: [], version_history: [],
    verification_status: "pass", last_synced_hash: computeSyncHash([{ path: "a.ts", content: SRC }]),
  };
}
function governed(withPartial: boolean, secondPass = false): void {
  writeFileSync(join(dir, "a.ts"), SRC);
  writeManifest(entry());
  if (withPartial) recordEvent("anchor_match", { component_id: "comp-a", detail: { outcome: "partial_line", paths: ["a.ts"] } });
  recordEvent("verification_pass", { component_id: "comp-a", operation: "modify", detail: { stage: "direct_patch", isolation: "none" } });
  if (secondPass) recordEvent("verification_pass", { component_id: "comp-a", operation: "modify", detail: { stage: "direct_patch", isolation: "none" } });
  appendAuditRecord({ event: "test_setup" });
  closeDb();
}
const checkText = () => runCheck().sections.find((s) => s.id === "verification")!.items.map((i) => i.message).join("\n");

describe("purix check", () => {
  it("says an edit left the rest of a line in place, and does not turn the check into a failure", () => {
    governed(true);
    const r = runCheck();
    const v = r.sections.find((s) => s.id === "verification")!;
    expect(checkText()).toContain("rest of that line");
    expect(v.outcome).toBe("pass");
  });
  it("says nothing when no edit was partial, or when a later pass followed", () => {
    governed(false);
    expect(checkText()).not.toContain("rest of that line");
  });
  it("a later pass clears it", () => {
    governed(true, true);
    expect(checkText()).not.toContain("rest of that line");
  });
});

describe("evidence bundle and PR report", () => {
  it("marks the component and lists it as a review note, without changing the outcome", () => {
    governed(true);
    const res = buildEvidenceBundle();
    if (res.state !== "ok") throw new Error("bundle not ok");
    expect(res.bundle.components[0]!.partial_line).toEqual(["a.ts"]);
    const report = renderPrReport(res.bundle, verifyBundleChain(res.bundle));
    expect(report).toContain("rest of that line");
    expect(report).toContain("**Result: pass.**");
  });
  it("has no field when nothing was partial", () => {
    governed(false);
    const res = buildEvidenceBundle();
    if (res.state !== "ok") throw new Error("bundle not ok");
    expect("partial_line" in res.bundle.components[0]!).toBe(false);
    expect(renderPrReport(res.bundle, verifyBundleChain(res.bundle))).not.toContain("rest of that line");
  });
});

describe("purix status", () => {
  it("latestPartialLineByComponent reads the stored events", () => {
    governed(true);
    expect(latestPartialLineByComponent().get("comp-a")).toEqual(["a.ts"]);
  });
});

describe("partialLinePathsFor: paths reported by repair or escalation during the run (C3 item 3)", () => {
  const ok = (paths: string[]) => ({ ok: true as const, files: [], partialLinePaths: paths });
  it("an escalation-authored result still names the run's own paths", () => expect(partialLinePathsFor(ok(["a.ts"]), true, ["b.ts"])).toEqual(["b.ts"]));
  it("merges compile and run paths without repeats", () => expect(partialLinePathsFor(ok(["a.ts"]), false, ["a.ts", "b.ts"])).toEqual(["a.ts", "b.ts"]));
  it("a refused compile with run paths still names them", () => expect(partialLinePathsFor({ ok: false, reason: "r" }, true, ["b.ts"])).toEqual(["b.ts"]));
});
