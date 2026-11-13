// src/evidence/anchor.test.ts
// The case this file exists for: a chain with its newest records deleted is still a valid chain. Before the anchor,
// `audit-log verify` called that "no tampering detected". Real SQLite store, real git repository, no mocks.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { closeDb, getDbCompat as getDb } from "../manifest/store";
import { appendAuditRecord, pruneAuditChain, readAuditChain } from "../security/audit_tamper_evidence";
import { GENESIS_HASH } from "./evidence";
import { describeVerdict, findAnchorInGit, judgeChain, parseAnchorHead, parseSuppliedHead } from "./anchor";

let cwd: string;
let dir: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
}
function commit(message: string): void {
  writeFileSync(join(dir, "f.txt"), `${Math.random()}`);
  git("add", "-A");
  git("commit", "-q", "-m", message);
}
function seed(n: number): string[] {
  const heads: string[] = [];
  for (let i = 0; i < n; i++) heads.push(appendAuditRecord({ event: `e${i}` }).hash);
  return heads;
}

beforeEach(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "purix-anchor-"));
  process.chdir(dir);
  git("init", "-q");
});
afterEach(() => {
  closeDb();
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

const lookupFor = (head: string) => ({ found: true as const, anchor: { head, source: "abc1234" } });

describe("parsing", () => {
  it("reads the head from a commit message and ignores anything that is not a full sha256 hex", () => {
    const h = "a".repeat(64);
    expect(parseAnchorHead(`Fix\n\nPurix-Evidence: sha256:${h}\nPurix-Records: 3`)).toBe(h);
    expect(parseAnchorHead(`Fix\r\n\r\nPurix-Evidence: sha256:${h}\r\n`)).toBe(h);
    expect(parseAnchorHead("Fix\n\nPurix-Evidence: sha256:abc")).toBeNull();
    expect(parseAnchorHead("Fix, mentioning Purix-Evidence: sha256 in prose")).toBeNull();
  });
  it("accepts a supplied head with or without the sha256: prefix and rejects the rest", () => {
    const h = "b".repeat(64);
    expect(parseSuppliedHead(`sha256:${h}`)).toBe(h);
    expect(parseSuppliedHead(h.toUpperCase())).toBe(h);
    expect(parseSuppliedHead("nope")).toBeNull();
  });
});

describe("judgeChain", () => {
  it("anchored when the chain holds the recorded head, and counts the newer unanchored records", () => {
    const heads = seed(5);
    const { rows, checkpoint } = readAuditChain();
    const v = judgeChain(rows, checkpoint, lookupFor(heads[2]!));
    expect(v.state).toBe("anchored");
    if (v.state === "anchored") expect(v.newerRecords).toBe(2);
    expect(describeVerdict(v)).toMatch(/^VERIFIED: 5 records/);
    expect(describeVerdict(v)).toContain("2 newer records are valid but not anchored yet");
  });

  it("THE BUG: records cut off the end leave a valid chain; without an anchor that is CONSISTENT, NOT ANCHORED, never VERIFIED", () => {
    seed(5);
    getDb().run(`DELETE FROM audit_chain WHERE id > 3`);
    const { rows, checkpoint } = readAuditChain();
    const v = judgeChain(rows, checkpoint, { found: false, reason: "no commit" });
    expect(v.state).toBe("not_anchored");
    expect(describeVerdict(v)).toMatch(/^CONSISTENT, NOT ANCHORED/);
    expect(describeVerdict(v)).not.toMatch(/VERIFIED|passed/);
  });

  it("FAILED when the anchored head is gone because the end of the chain was removed", () => {
    const heads = seed(5);
    getDb().run(`DELETE FROM audit_chain WHERE id > 3`);
    const { rows, checkpoint } = readAuditChain();
    const v = judgeChain(rows, checkpoint, lookupFor(heads[4]!));
    expect(v.state).toBe("failed");
    expect(describeVerdict(v)).toContain("removed from the end");
  });

  it("FAILED, with the record index, when a record was edited", () => {
    const heads = seed(4);
    getDb().run(`UPDATE audit_chain SET payload = '{"event":"forged"}' WHERE id = 2`);
    const { rows, checkpoint } = readAuditChain();
    const v = judgeChain(rows, checkpoint, lookupFor(heads[3]!));
    expect(v.state).toBe("failed");
    if (v.state === "failed") expect(v.compromisedIndex).toBe(1);
  });

  it("an anchor whose record was pruned away is still honoured through the checkpoint hash", () => {
    const heads = seed(3);
    pruneAuditChain(-1000); // a cutoff in the future: every record is older than it
    const { rows, checkpoint } = readAuditChain();
    expect(rows.length).toBe(0);
    expect(judgeChain(rows, checkpoint, lookupFor(heads[2]!)).state).toBe("anchored");
  });

  it("an anchor from before the first record vouches for nothing but does not fail the chain", () => {
    seed(2);
    const { rows, checkpoint } = readAuditChain();
    expect(judgeChain(rows, checkpoint, lookupFor(GENESIS_HASH)).state).toBe("anchored");
  });
});

describe("findAnchorInGit (real repository)", () => {
  it("returns the newest commit that has a trailer, even when later commits have none", () => {
    const h1 = "1".repeat(64);
    const h2 = "2".repeat(64);
    commit(`first\n\nPurix-Evidence: sha256:${h1}\nPurix-Records: 1`);
    commit(`second\n\nPurix-Evidence: sha256:${h2}\nPurix-Records: 2`);
    commit("third, no trailer");
    const r = findAnchorInGit(dir);
    expect(r.found).toBe(true);
    if (r.found) expect(r.anchor.head).toBe(h2);
  });

  it("with an exact commit, a commit without a trailer is reported, not skipped past", () => {
    commit(`first\n\nPurix-Evidence: sha256:${"1".repeat(64)}`);
    commit("second, no trailer");
    const r = findAnchorInGit(dir, { ref: "HEAD", exact: true });
    expect(r.found).toBe(false);
    if (!r.found) expect(r.reason).toContain("no Purix-Evidence trailer");
  });

  it("reports a repository with no commits, an unknown ref, an option-shaped ref, and a folder that is not a repository", () => {
    expect(findAnchorInGit(dir)).toEqual({ found: false, reason: "this repository has no commits yet." });
    commit("x");
    const missing = findAnchorInGit(dir, { ref: "no-such-ref", exact: true });
    expect(missing.found).toBe(false);
    const evil = findAnchorInGit(dir, { ref: "--output=/tmp/x", exact: true });
    expect(evil).toEqual({ found: false, reason: `"--output=/tmp/x" is not a commit reference.` });
    const elsewhere = mkdtempSync(join(tmpdir(), "purix-notgit-"));
    try {
      expect(findAnchorInGit(elsewhere)).toEqual({ found: false, reason: "this folder is not a git repository." });
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
