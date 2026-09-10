// src/security/override_audit.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordOverrideAudit, getOverrideAudits } from "./override_audit";
import { closeDb } from "../manifest/store";

describe("ADR-039 Override-with-Audit Escape Hatch", () => {
  let originalCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), "purix-override-test-"));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    closeDb();
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects an empty or whitespace-only reason", () => {
    expect(() => recordOverrideAudit("SecurityGate", "", "secret found")).toThrow(/reason cannot be empty/);
    expect(() => recordOverrideAudit("SecurityGate", "   ", "secret found")).toThrow(/reason cannot be empty/);
  });

  it("records a valid override audit entry and persists across connection restarts", () => {
    const entry = recordOverrideAudit("SecurityGate", "Emergency hotfix for production bug", "Critical secret");
    expect(entry.reason).toBe("Emergency hotfix for production bug");
    expect(entry.gate_name).toBe("SecurityGate");

    closeDb(); // simulate process restart / db close

    const audits = getOverrideAudits();
    expect(audits.length).toBe(1);
    expect(audits[0]?.reason).toBe("Emergency hotfix for production bug");
    expect(audits[0]?.finding).toBe("Critical secret");
  });
});
