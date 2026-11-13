// packages/core/src/security/override_audit_id.test.ts
//
// H3 (catalogue, "randomness"): an override id was `ovr_<ms>_<5 characters of Math.random>`. Two overrides recorded in the same
// millisecond with the same five characters share an id; the table's primary key then refuses the second, and the override the
// person asked for is lost with an error. The chance in real use is small (about 1 in 60 million per pair in one millisecond); the
// point is that uniqueness was by luck. Math.random is not a source of unique ids. Real SQLite in a throwaway folder, Linux.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordOverrideAudit, getOverrideAudits } from "./override_audit.js";
import { closeDb } from "../manifest/store.js";
import { safeRmSync } from "../platform/fs_retry.js";

let originalCwd: string;
let dir: string;
beforeEach(() => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "purix-override-id-"));
  process.chdir(dir);
});
afterEach(() => {
  closeDb();
  process.chdir(originalCwd);
  safeRmSync(dir);
});

describe("override audit ids", () => {
  it("two overrides in the same millisecond with the same Math.random value are both recorded", () => {
    const realNow = Date.now;
    const realRandom = Math.random;
    Date.now = () => 1_700_000_000_000;
    Math.random = () => 0.123456789;
    try {
      const a = recordOverrideAudit("SecurityGate", "first reason", "finding one");
      const b = recordOverrideAudit("BudgetGuard", "second reason", "finding two");
      expect(a.id).not.toBe(b.id);
    } finally {
      Date.now = realNow;
      Math.random = realRandom;
    }
    expect(getOverrideAudits()).toHaveLength(2);
  });

  it("keeps the ovr_ prefix and is not built from Math.random", () => {
    const realRandom = Math.random;
    let touched = 0;
    Math.random = () => { touched++; return 0.5; };
    try {
      const e = recordOverrideAudit("SecurityGate", "a reason", "a finding");
      expect(e.id).toMatch(/^ovr_[0-9a-z_-]+$/i);
    } finally {
      Math.random = realRandom;
    }
    expect(touched).toBe(0);
  });

  it("200 overrides in a row all get different ids", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) ids.add(recordOverrideAudit("SecurityGate", `reason ${i}`, `finding ${i}`).id);
    expect(ids.size).toBe(200);
  });
});
