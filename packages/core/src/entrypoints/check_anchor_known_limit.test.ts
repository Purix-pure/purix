// F08-02 (known limit, pinned): someone who edits the audit store AND its head receipt together removes the newest records without
// `purix check` seeing it, because check compares the chain with the receipt only. The git anchor (evidence/anchor.ts) does see it.
// This file pins both halves so the gap is measured, not assumed. It is NOT a statement that the gap is acceptable: whether check
// should also run the git anchor is an open decision (a teammate's commit trailer holds THEIR machine's head, which this store may
// never contain, so a check that fails on it could fail on a healthy store). If check starts running the anchor, the first test
// below is the one that must change.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { closeDb, getDbCompat as getDb } from "../manifest/store";
import { appendAuditRecord, readAuditChain, resetAuditReceipt, writeAuditReceiptFromDb } from "../security/audit_tamper_evidence";
import { findAnchorInGit, judgeChain } from "../evidence/anchor";
import { runCheck } from "./check";

let cwd: string, dir: string;
const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...a], { cwd: dir, encoding: "utf8" });

beforeEach(() => { cwd = process.cwd(); dir = mkdtempSync(join(tmpdir(), "purix-anchor-limit-")); process.chdir(dir); git("init", "-q"); });
afterEach(() => { closeDb(); process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); });

function cutTailAndRewriteReceipt(): void {
  const heads = [1, 2, 3].map((i) => appendAuditRecord({ event: `e${i}` }).hash);
  writeFileSync(join(dir, "f.txt"), "x");
  git("add", "-A");
  git("commit", "-q", "-m", `work\n\nPurix-Evidence: sha256:${heads[2]}\nPurix-Records: 3`);
  getDb().run(`DELETE FROM audit_chain WHERE id = (SELECT MAX(id) FROM audit_chain)`);
  resetAuditReceipt();
  writeAuditReceiptFromDb();
  closeDb();
}

describe("F08-02: editing the store and the receipt together", () => {
  it("purix check does not report the removed record (known limit)", () => {
    cutTailAndRewriteReceipt();
    const audit = runCheck({ baseDir: dir }).sections.find((s) => s.id === "audit-chain")!;
    expect(audit.items).toEqual([]);
  });

  it("the git anchor does: the chain no longer contains the head the commit recorded", () => {
    cutTailAndRewriteReceipt();
    const { rows, checkpoint } = readAuditChain();
    expect(rows).toHaveLength(2);
    const verdict = judgeChain(rows, checkpoint, findAnchorInGit(dir));
    expect(verdict.state).toBe("failed");
  });
});
