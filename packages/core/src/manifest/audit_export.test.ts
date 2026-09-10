// src/manifest/audit_export.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { buildAuditTrail, formatAuditTrailJson } from "./audit_export";

describe("Audit Export", () => {
  it("builds audit trail report", () => {
    const report = buildAuditTrail();
    expect(report).toBeTruthy();
    const json = formatAuditTrailJson(report);
    expect(typeof json).toBe("string");
  });
});
