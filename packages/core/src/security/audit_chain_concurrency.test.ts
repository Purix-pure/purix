// A2a-1: concurrent writers must not fork the audit chain (research 08, finding 1: 5 of 5 runs forked, verify said "tampering").
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../manifest/store.js";
import { readAuditChain, verifyAuditChain, appendAuditRecord } from "./audit_tamper_evidence.js";
import { resolveTsxCommand } from "../test-support/real_node_modules.js";
import { safeRmSync } from "../platform/fs_retry.js";

const worker = join(import.meta.dirname, "audit_chain_worker.ts");

function runWorker(dir: string, count: number, label: string): Promise<number | null> {
  const [cmd, ...pre] = resolveTsxCommand();
  return new Promise((resolve) => {
    const child = spawn(cmd!, [...pre, worker, dir, String(count), label], { stdio: "ignore" });
    child.on("exit", (code) => resolve(code));
  });
}

function forkPoints(rows: { prev_hash: string }[]): number {
  const seen = new Set<string>();
  let forks = 0;
  for (const r of rows) {
    if (seen.has(r.prev_hash)) forks++;
    seen.add(r.prev_hash);
  }
  return forks;
}

describe("audit chain under concurrent writers", () => {
  let cwd: string;
  let dir: string;
  beforeEach(() => {
    cwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "purix-chain-conc-"));
    mkdirSync(join(dir, ".purix"), { recursive: true });
    process.chdir(dir);
  });
  afterEach(() => {
    closeDb();
    process.chdir(cwd);
    safeRmSync(dir);
  });

  it("4 processes x 60 appends leave one unbroken chain, zero fork points", async () => {
    appendAuditRecord({ seed: true });
    closeDb();
    const codes = await Promise.all(["a", "b", "c", "d"].map((w) => runWorker(dir, 60, w)));
    expect(codes).toEqual([0, 0, 0, 0]);
    const { rows } = readAuditChain();
    expect(rows.length).toBe(241);
    expect(forkPoints(rows)).toBe(0);
    expect(verifyAuditChain().valid).toBe(true);
  });

  it("the store refuses two records on one predecessor (UNIQUE prev_hash)", async () => {
    const first = appendAuditRecord({ n: 1 });
    const { getDbCompat } = await import("../manifest/store.js");
    expect(() =>
      getDbCompat().run(`INSERT INTO audit_chain (payload, timestamp, prev_hash, hash) VALUES (?, ?, ?, ?)`, ["{}", new Date().toISOString(), "0".repeat(64), "f".repeat(64)]),
    ).toThrow(/UNIQUE/i);
    expect(first.prev_hash).toBe("0".repeat(64));
  });

  it("an append inside someone else's transaction joins it and does not throw", async () => {
    const { getDbCompat } = await import("../manifest/store.js");
    const db = getDbCompat();
    db.run("BEGIN IMMEDIATE");
    appendAuditRecord({ inside: 1 });
    appendAuditRecord({ inside: 2 });
    db.run("COMMIT");
    expect(readAuditChain().rows.length).toBe(2);
    expect(verifyAuditChain().valid).toBe(true);
  });
});
