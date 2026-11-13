// `purix audit-log verify` as a user runs it: a real git repository, a real store, the real CLI process.
// The case it guards: deleting the newest audit records used to print "no tampering detected".
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { spawnSync, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { closeDb, getDbCompat as getDb } from "@purix/core/manifest/store";
import { appendAuditRecord } from "@purix/core/security/audit_tamper_evidence";

const tsxLoader = createRequire(import.meta.url).resolve("tsx");
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
function verify(...args: string[]): { status: number | null; output: string } {
  const home = join(dir, "home");
  const r = spawnSync(process.execPath, ["--import", pathToFileURL(tsxLoader).href, join(import.meta.dirname, "cli.ts"), "audit-log", "verify", ...args], {
    cwd: dir,
    env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local") },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
function seedChain(n: number): string {
  let head = "";
  for (let i = 0; i < n; i++) head = appendAuditRecord({ event: `e${i}` }).hash;
  closeDb(); // the CLI is a separate process and must see the committed file
  return head;
}

beforeEach(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "purix-verify-e2e-"));
  process.chdir(dir);
  git("init", "-q");
});
afterEach(() => {
  closeDb();
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

describe("purix audit-log verify", () => {
  it("VERIFIED when a commit's trailer matches the chain", () => {
    const head = seedChain(3);
    commit(`work\n\nPurix-Evidence: sha256:${head}\nPurix-Records: 3`);
    const r = verify();
    expect(r.status).toBe(0);
    expect(r.output).toContain("VERIFIED: 3 records");
  });

  it("FAILED, exit 1, when the newest records were deleted after the commit", () => {
    const head = seedChain(3);
    commit(`work\n\nPurix-Evidence: sha256:${head}\nPurix-Records: 3`);
    getDb().run(`DELETE FROM audit_chain WHERE id = 3`);
    closeDb();
    const r = verify();
    expect(r.status).toBe(1);
    expect(r.output).toContain("FAILED");
    expect(r.output).not.toMatch(/no tampering/i);
  });

  it("with no anchor it says CONSISTENT, NOT ANCHORED (exit 0), and --require-anchor turns that into exit 1", () => {
    seedChain(3);
    commit("work, no trailer");
    const soft = verify();
    expect(soft.status).toBe(0);
    expect(soft.output).toContain("CONSISTENT, NOT ANCHORED");
    expect(soft.output).not.toContain("VERIFIED");
    const strict = verify("--require-anchor");
    expect(strict.status).toBe(1);
    expect(strict.output).toContain("NOT ANCHORED");
  });

  it("--expect-head checks a head given directly, and rejects a malformed one", () => {
    const head = seedChain(2);
    expect(verify("--expect-head", `sha256:${head}`).output).toContain("VERIFIED: 2 records");
    expect(verify("--expect-head", "sha256:" + "f".repeat(64)).status).toBe(1);
    const bad = verify("--expect-head", "not-a-hash");
    expect(bad.status).toBe(1);
    expect(bad.output).toContain("--expect-head must be");
  });

  it("--commit on a commit without a trailer is an error, not a pass", () => {
    seedChain(2);
    commit("no trailer");
    const r = verify("--commit", "HEAD");
    expect(r.status).toBe(1);
    expect(r.output).toContain("no Purix-Evidence trailer");
  });
});
