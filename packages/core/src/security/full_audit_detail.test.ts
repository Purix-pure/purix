import { describe, it } from "node:test";
import { expect } from "expect";
import { auditRunDetail, type FullAuditResult } from "./full_audit.js";
import type { VulnScanResult } from "./deps_audit.js";

const base: FullAuditResult = { pinning: [], vulnScanFormatted: "", trackedFileCount: 3, idiom: { ran: true, findings: [] } };

describe("auditRunDetail", () => {
  it("counts findings by severity when the scan ran", () => {
    const vuln: VulnScanResult = {
      ran: true,
      findings: [
        { severity: "high", module: "a", range: "<1", title: "t" },
        { severity: "high", module: "b", range: "<1", title: "t" },
        { severity: "low", module: "c", range: "<1", title: "t" },
      ] as VulnScanResult["findings"],
    };
    expect(auditRunDetail(base, vuln)).toEqual({
      pinning_findings: 0,
      vuln: { ran: true, findings: 3, by_severity: { high: 2, low: 1 } },
      tracked_files: 3,
      idiom: { ran: true, findings: 0 },
    });
  });

  it("a scan that did not run is stored as not-run with its reason, never as zero findings", () => {
    const d = auditRunDetail(base, { ran: false, reason: "no lockfile", findings: [] });
    expect(d["vuln"]).toEqual({ ran: false, reason: "no lockfile" });
  });

  it("an idiom check that was skipped, or had nothing to check, says so", () => {
    expect(auditRunDetail({ ...base, idiom: null, trackedFileCount: 0 }, { ran: true, findings: [] })["idiom"]).toEqual({ ran: false, reason: "no manifest-tracked files" });
    expect(auditRunDetail({ ...base, idiom: { ran: false, findings: [] }, idiomSkippedReason: "no registered language for x.rb" }, { ran: true, findings: [] })["idiom"]).toEqual({ ran: false, reason: "no registered language for x.rb" });
  });
});
