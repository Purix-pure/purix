// A2a-1: head-hash receipt. A chain with its newest records cut off is still internally valid (research 08, finding 2).
// The receipt, a file outside the database, remembers the newest head, so the cut is seen without a git anchor.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDbCompat } from "../manifest/store.js";
import { appendAuditRecord, readAuditChain, verifyAuditChain, verifyAuditChainWithReceipt, verifyAuditReceipt, auditReceiptPath, readAuditReceipt, pruneAuditChain } from "./audit_tamper_evidence.js";
import { safeRmSync } from "../platform/fs_retry.js";

describe("audit head receipt", () => {
  let cwd: string;
  let dir: string;
  beforeEach(() => {
    cwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "purix-receipt-"));
    process.chdir(dir);
  });
  afterEach(() => {
    closeDb();
    process.chdir(cwd);
    safeRmSync(dir);
  });

  it("every append writes a receipt holding the newest head", () => {
    const a = appendAuditRecord({ n: 1 });
    const b = appendAuditRecord({ n: 2 });
    expect(existsSync(auditReceiptPath())).toBe(true);
    const r = readAuditReceipt();
    expect(r?.head).toBe(b.hash);
    expect(r?.head).not.toBe(a.hash);
  });

  it("plain verify cannot see a cut tail (today's behaviour) but the receipt check does", () => {
    for (let i = 0; i < 20; i++) appendAuditRecord({ n: i });
    getDbCompat().run(`DELETE FROM audit_chain WHERE id > 15`);
    expect(verifyAuditChain().valid).toBe(true); // internally consistent, which is the weakness
    const v = verifyAuditChainWithReceipt();
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/removed from the end|receipt/i);
  });

  it("an intact chain with a receipt verifies, and reports no receipt as 'no receipt' rather than a pass", () => {
    appendAuditRecord({ n: 1 });
    expect(verifyAuditChainWithReceipt()).toMatchObject({ valid: true, receipt: "matches" });
    writeFileSync(auditReceiptPath(), "");
    // unreadable receipt is reported, not silently accepted
    expect(verifyAuditChainWithReceipt().receipt).toBe("unreadable");
  });

  it("a chain that has no receipt yet (older install) is valid but says so", () => {
    appendAuditRecord({ n: 1 });
    
    unlinkSync(auditReceiptPath());
    expect(verifyAuditChainWithReceipt()).toMatchObject({ valid: true, receipt: "absent" });
  });

  it("a receipt that is behind the chain is fine (a later append raced it); one that is ahead is a cut", () => {
    const rows: { id: number; payload: string; timestamp: string; prev_hash: string; hash: string }[] = [];
    for (let i = 0; i < 3; i++) appendAuditRecord({ n: i });
    rows.push(...readAuditChain().rows);
    const head = rows[2]!.hash;
    expect(verifyAuditReceipt(rows, null, { schema: 1, head: rows[0]!.hash, id: rows[0]!.id, recordedAt: "x" }).state).toBe("behind");
    expect(verifyAuditReceipt(rows, null, { schema: 1, head, id: rows[2]!.id, recordedAt: "x" }).state).toBe("matches");
    expect(verifyAuditReceipt(rows, null, { schema: 1, head: "a".repeat(64), id: 9, recordedAt: "x" }).state).toBe("ahead_of_chain");
  });

  it("prune keeps the receipt valid: the checkpoint hash may be the receipt head", () => {
    for (let i = 0; i < 4; i++) appendAuditRecord({ n: i });
    getDbCompat().run(`UPDATE audit_chain SET timestamp='2000-01-01T00:00:00.000Z'`);
    pruneAuditChain(1000);
    expect(readAuditChain().rows.length).toBe(0);
    expect(verifyAuditChainWithReceipt().valid).toBe(true);
    appendAuditRecord({ n: 99 });
    expect(verifyAuditChainWithReceipt()).toMatchObject({ valid: true, receipt: "matches" });
    expect(readFileSync(auditReceiptPath(), "utf-8")).toContain("head");
  });
});
