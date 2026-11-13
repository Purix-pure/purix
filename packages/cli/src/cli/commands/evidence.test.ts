// The independent verifier against chains built here with plain crypto, and against a real git repository.
// The verifier shares no code with Purix, so these tests build their own chains rather than call Purix to make them.
import { describe, it, before, after } from "node:test";
import { expect } from "expect";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { registerEvidenceCommands } from "./evidence";
import { applyTrailers, trailerLines, bundleFromSnapshot } from "@purix/core/evidence/evidence";
import { verifyAuditRows } from "@purix/core/security/audit_tamper_evidence";

const VERIFIER = resolve(import.meta.dirname, "..", "..", "..", "verifier", "purix-evidence-verify.mjs");
const GENESIS = "0".repeat(64);

function chain(n: number, start = 1, prev = GENESIS) {
  const rows: { id: number; payload: string; timestamp: string; prev_hash: string; hash: string }[] = [];
  for (let i = 0; i < n; i++) {
    const payload = JSON.stringify({ event: `e${start + i}` });
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, start + i)).toISOString();
    const hash = createHash("sha256").update(`${prev}|${timestamp}|${payload}`).digest("hex");
    rows.push({ id: start + i, payload, timestamp, prev_hash: prev, hash });
    prev = hash;
  }
  return rows;
}

function bundleOf(rows: ReturnType<typeof chain>, checkpoint: { last_pruned_id: number; checkpoint_hash: string } | null = null) {
  return {
    schema: "purix.evidence/1",
    generated_at: "2026-10-06T00:00:00.000Z",
    chain: { rows, checkpoint },
    head: { hash: rows.length ? rows[rows.length - 1]!.hash : GENESIS, record_count: rows.length },
    components: [],
  };
}

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), "purix-verifier-")); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

function run(bundle: unknown, ...args: string[]) {
  const f = join(dir, `b-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, typeof bundle === "string" ? bundle : JSON.stringify(bundle));
  const r = spawnSync(process.execPath, [VERIFIER, f, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe("registerEvidenceCommands", () => {
  it("registers export, report and trailer", async () => {
    const { Command } = await import("commander");
    const p = new Command();
    registerEvidenceCommands(p);
    const ev = p.commands.find((c) => c.name() === "evidence")!;
    expect(ev.commands.map((c) => c.name()).sort()).toEqual(["export", "report", "trailer"]);
  });
});

describe("independent verifier: chain", () => {
  it("verifies an intact chain and says what it did not cover", () => {
    const r = run(bundleOf(chain(4)));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/CONSISTENT, NOT ANCHORED/);
    expect(r.out).not.toMatch(/^VERIFIED/m);
    expect(r.out).toMatch(/4 record/);
    expect(r.out).toMatch(/anchor: none given/);
    expect(run(bundleOf(chain(4)), "--require-anchor").code).toBe(1);
    expect(r.out).toMatch(/not covered/);
  });
  it("an empty chain verifies as zero records, not as a pass on content", () => {
    const r = run(bundleOf([]));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/0 record/);
  });
  it("detects an altered payload", () => {
    const rows = chain(3);
    rows[1]!.payload = '{"event":"forged"}';
    const r = run(bundleOf(rows));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/altered/);
  });
  it("detects a removed middle record", () => {
    const rows = chain(4);
    rows.splice(1, 1);
    const r = run(bundleOf(rows));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/does not link/);
  });
  it("detects records cut off the front", () => {
    const rows = chain(4).slice(1);
    const r = run(bundleOf(rows));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/does not start at its beginning/);
  });
  it("accepts a pruned chain only with its checkpoint", () => {
    const all = chain(5);
    const kept = all.slice(2);
    const cp = { last_pruned_id: 2, checkpoint_hash: all[1]!.hash };
    expect(run(bundleOf(kept, cp)).code).toBe(0);
    expect(run(bundleOf(kept, null)).code).toBe(1);
    expect(run(bundleOf(kept, { ...cp, checkpoint_hash: "e".repeat(64) })).code).toBe(1);
  });
  it("rejects a stated head that does not match the records", () => {
    const b = bundleOf(chain(3));
    b.head.hash = "d".repeat(64);
    expect(run(b).code).toBe(1);
  });
  it("exits 2 for unreadable input, not 0 and not 1", () => {
    expect(run("not json").code).toBe(2);
    expect(run({ schema: "other" }).code).toBe(1);
  });
});

describe("independent verifier: anchor", () => {
  it("accepts a committed head that is in the chain, and counts records added since", () => {
    const rows = chain(5);
    const r = run(bundleOf(rows), "--expect-head", rows[2]!.hash);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^VERIFIED/m);
    expect(r.out).toMatch(/record 3 of 5; 2 later record/);
    expect(run(bundleOf(rows), "--expect-head", rows[2]!.hash, "--require-anchor").code).toBe(0);
  });
  it("fails when the committed head is not in the chain: rewritten or cut back", () => {
    const rows = chain(5);
    const committed = rows[4]!.hash;
    const cutBack = rows.slice(0, 3);
    expect(run(bundleOf(cutBack), "--expect-head", committed).code).toBe(1);
    // a whole rebuilt chain with different content is internally valid but does not contain the committed head
    const rebuilt = chain(5).map((r) => r);
    rebuilt[2] = chain(5, 1, GENESIS)[2]!;
    const forged = chain(6, 100);
    expect(run(bundleOf(forged), "--expect-head", committed).code).toBe(1);
  });
  it("rejects a malformed expected head and giving both anchors", () => {
    expect(run(bundleOf(chain(1)), "--expect-head", "xyz").code).toBe(2);
    expect(run(bundleOf(chain(1)), "--expect-head", "a".repeat(64), "--commit", "HEAD").code).toBe(2);
  });
});

describe("independent verifier: real git commit trailer", () => {
  const git = (cwd: string, ...a: string[]) => spawnSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", ...a], { cwd, encoding: "utf8" });
  it("reads the trailer applyTrailers wrote, using git's own parser, and anchors on it", () => {
    const repo = mkdtempSync(join(tmpdir(), "purix-git-"));
    try {
      expect(git(repo, "init", "-q").status).toBe(0);
      const rows = chain(4);
      const bundle = bundleOf(rows);
      const snap = bundleFromSnapshot({ manifest: [], pending: [], verificationPasses: [], auditRows: rows, auditCheckpoint: null });
      const msg = applyTrailers("Add parser\n\nBody text.\n", trailerLines(snap));
      writeFileSync(join(repo, "f.txt"), "x");
      git(repo, "add", ".");
      const c = git(repo, "commit", "-q", "-m", msg);
      expect(c.status).toBe(0);
      // git's own parser sees our lines as trailers
      const parsed = spawnSync("git", ["log", "-1", "--format=%(trailers:key=Purix-Evidence,valueonly)"], { cwd: repo, encoding: "utf8" });
      expect(parsed.stdout.trim()).toBe(`sha256:${rows[3]!.hash}`);
      const f = join(dir, "git-bundle.json");
      writeFileSync(f, JSON.stringify(bundle));
      const ok = spawnSync(process.execPath, [VERIFIER, f, "--commit", "HEAD"], { cwd: repo, encoding: "utf8" });
      expect(ok.status).toBe(0);
      expect(ok.stdout).toMatch(/record 4 of 4; 0 later/);
      // the same commit against a chain rebuilt after the fact
      writeFileSync(f, JSON.stringify(bundleOf(chain(4, 50))));
      expect(spawnSync(process.execPath, [VERIFIER, f, "--commit", "HEAD"], { cwd: repo, encoding: "utf8" }).status).toBe(1);
      // a commit with no trailer cannot anchor anything: exit 2, not a quiet pass
      writeFileSync(join(repo, "g.txt"), "y");
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "plain commit");
      writeFileSync(f, JSON.stringify(bundle));
      const none = spawnSync(process.execPath, [VERIFIER, f, "--commit", "HEAD"], { cwd: repo, encoding: "utf8" });
      expect(none.status).toBe(2);
      expect(none.stdout).toMatch(/no Purix-Evidence trailer/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("the verifier and Purix agree on what a broken chain is", () => {
  it("same verdict on intact, altered, cut and pruned chains", async () => {
    const { verifyChain } = (await import(pathToFileURL(VERIFIER).href)) as { verifyChain: (rows: any, cp: any) => { ok: boolean } };
    const intact = chain(5);
    const altered = chain(5); altered[2]!.payload = "{}";
    const cutFront = chain(5).slice(1);
    const cutMiddle = chain(5); cutMiddle.splice(2, 1);
    const kept = chain(6).slice(3);
    const cp = { last_pruned_id: 3, checkpoint_hash: chain(6)[2]!.hash };
    const cases: Array<[string, any[], any]> = [
      ["intact", intact, null], ["altered", altered, null], ["cutFront", cutFront, null], ["cutMiddle", cutMiddle, null],
      ["pruned+checkpoint", kept, cp], ["pruned, no checkpoint", kept, null], ["empty", [], null],
    ];
    for (const [name, rows, c] of cases) {
      expect({ name, ok: verifyChain(rows, c).ok }).toEqual({ name, ok: verifyAuditRows(rows, c).valid });
    }
  });
});
