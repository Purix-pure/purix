// src/security/audit_prune_clock.test.ts
// H4: the clock going backwards. Retention prunes by timestamp, and a chain written across a clock change has timestamps that
// do not rise with the record id. Pruning must delete only a leading run of records that are all older than the cutoff: it
// must never delete a record that the retention rule does not select just because a later record has an old stamp.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../manifest/store";
import { appendAuditRecord, pruneAuditChain, readAuditChain, verifyAuditRows } from "./audit_tamper_evidence";

const DAY = 86_400_000;
const RealDate = Date;
let cwd: string;
let dir: string;

function stampedAt(daysFromNow: number, payload: object): void {
  const t = RealDate.now() + daysFromNow * DAY;
  (globalThis as { Date: unknown }).Date = class extends RealDate {
    constructor(...a: unknown[]) {
      super(...((a.length ? a : [t]) as [number]));
    }
    static override now(): number {
      return t;
    }
  };
  try {
    appendAuditRecord(payload);
  } finally {
    (globalThis as { Date: unknown }).Date = RealDate;
  }
}
const ids = (): number[] => readAuditChain().rows.map((r) => r.id);
const chainValid = (): boolean => {
  const { rows, checkpoint } = readAuditChain();
  return verifyAuditRows(rows, checkpoint).valid;
};

beforeEach(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "purix-prune-clock-"));
  process.chdir(dir);
});
afterEach(() => {
  closeDb();
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

describe("pruneAuditChain with timestamps that do not rise", () => {
  it("an ordinary chain: removes exactly the records older than the cutoff", () => {
    stampedAt(-60, { n: 1 });
    stampedAt(-45, { n: 2 });
    stampedAt(-10, { n: 3 });
    pruneAuditChain(30 * DAY);
    expect(ids()).toEqual([3]);
    expect(chainValid()).toBe(true);
  });

  it("a record stamped by a clock that was ahead is not deleted because a later record is old", () => {
    stampedAt(-60, { n: 1 });
    stampedAt(+400, { n: 2 }); // clock a year ahead: its stamp is not older than any cutoff
    stampedAt(-50, { n: 3 }); // clock corrected: old again
    stampedAt(-1, { n: 4 });
    pruneAuditChain(30 * DAY);
    expect(ids()).toEqual([2, 3, 4]);
    expect(chainValid()).toBe(true);
  });

  it("a record stamped by a clock that was far behind does not take recent records with it", () => {
    stampedAt(-5, { n: 1 });
    stampedAt(-3, { n: 2 });
    stampedAt(-20000, { n: 3 }); // clock reset to the 1970s
    stampedAt(-1, { n: 4 });
    pruneAuditChain(30 * DAY);
    expect(ids()).toEqual([1, 2, 3, 4]);
    expect(chainValid()).toBe(true);
  });

  it("after a partial prune the chain still verifies and a later prune continues from the checkpoint", () => {
    stampedAt(-90, { n: 1 });
    stampedAt(+400, { n: 2 });
    stampedAt(-80, { n: 3 });
    pruneAuditChain(30 * DAY);
    expect(ids()).toEqual([2, 3]);
    expect(chainValid()).toBe(true);
    stampedAt(-1, { n: 4 });
    pruneAuditChain(30 * DAY);
    expect(ids()).toEqual([2, 3, 4]);
    expect(chainValid()).toBe(true);
  });
});
