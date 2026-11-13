// src/state/governed_lock.test.ts
//
// Real stores in real temp directories. Covers: the committed lock lets `purix check --strict` verify a fresh
// checkout (no store), a stale lock fails, drift names the changed file, a landed change reaches the hash chain,
// and `git init` no longer hides an existing store.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManifestEntry } from "../manifest/schema";
import { closeDb, writeManifest, readStoreSnapshot } from "../manifest/store";
import { appendAuditRecord, verifyAuditRows } from "../security/audit_tamper_evidence";
import { computeSyncHash } from "./hash";
import { resolveSharedStateDir } from "./git_common_dir";
import { safeRmSync } from "../platform/fs_retry.js";
import { runCheck } from "../entrypoints/check";
import { buildLock, readLock, writeLock, hashGovernedContent, LOCK_FILENAME } from "./governed_lock";
import { recordLandedChange } from "./landed_change";

let originalCwd: string;
let dir: string;
const A = "export const a = 1;\n";
const B = "export const b = 2;\n";

function entry(over: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    component_id: "comp-a",
    component_type: "module",
    current_version: 1,
    schema_version: 5,
    parts: { tools: [], config: {} },
    files: ["a.ts", "b.ts"],
    depends_on: [],
    depended_on_by: [],
    version_history: [],
    verification_status: "pass",
    last_synced_hash: computeSyncHash([{ path: "a.ts", content: A }, { path: "b.ts", content: B }]),
    ...over,
  };
}

function governed(): void {
  writeFileSync(join(dir, "a.ts"), A);
  writeFileSync(join(dir, "b.ts"), B);
  writeManifest(entry());
  appendAuditRecord({ event: "test_setup" });
  closeDb();
}

function writeTheLock(): void {
  const r = readStoreSnapshot();
  if (r.state !== "ok") throw new Error("no store");
  writeLock(dir, buildLock(r.snapshot.manifest, dir));
  closeDb();
}

/** What a fresh CI checkout looks like: the files and the lock, but no store. */
function freshCheckout(): void {
  closeDb();
  rmSync(join(dir, ".purix"), { recursive: true, force: true });
}

beforeEach(() => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "purix-lock-"));
  process.chdir(dir);
});
afterEach(() => {
  closeDb();
  process.chdir(originalCwd);
  safeRmSync(dir);
});

describe("purix.lock.json", () => {
  it("is deterministic, and a CRLF checkout hashes the same as an LF one", () => {
    governed();
    const r = readStoreSnapshot();
    if (r.state !== "ok") throw new Error("no store");
    expect(JSON.stringify(buildLock(r.snapshot.manifest, dir))).toBe(JSON.stringify(buildLock(r.snapshot.manifest, dir)));
    expect(hashGovernedContent("a\r\nb\r\n")).toBe(hashGovernedContent("a\nb\n"));
    expect(hashGovernedContent("a\n")).not.toBe(hashGovernedContent("b\n"));
  });

  it("the internal codebase-index row is never locked, so editing an un-adopted file cannot fail CI", () => {
    governed();
    writeManifest(entry({ component_id: "purix-codebase-index", component_type: "codebase_index", files: ["a.ts", "b.ts", "other.ts"], last_synced_hash: null }));
    writeTheLock();
    expect((readLock(dir) as { lock: { components: { component_id: string }[] } }).lock.components.map((c) => c.component_id)).toEqual(["comp-a"]);
    expect(runCheck().sections.find((s) => s.id === "lock")?.outcome).toBe("pass");
  });

  it("a fresh checkout with the lock passes --strict, and says what it did not check", () => {
    governed();
    writeTheLock();
    freshCheckout();
    const r = runCheck({ strict: true });
    expect(r.outcome).toBe("pass");
    expect(r.exitCode).toBe(0);
    expect(r.summary).toMatch(/match purix\.lock\.json/);
    expect(r.summary).toMatch(/audit chain .* not checked/);
  });

  it("a fresh checkout where a governed file was edited fails, and names that file only", () => {
    governed();
    writeTheLock();
    freshCheckout();
    writeFileSync(join(dir, "b.ts"), B + "// edited by an agent\n");
    const r = runCheck({ strict: true });
    expect(r.exitCode).toBe(1);
    const msgs = r.sections.flatMap((s) => s.items.map((i) => i.message)).join("\n");
    expect(msgs).toMatch(/b\.ts: changed since the lock was written/);
    expect(msgs).not.toMatch(/a\.ts/);
  });

  it("a fresh checkout with a deleted governed file fails", () => {
    governed();
    writeTheLock();
    freshCheckout();
    rmSync(join(dir, "a.ts"));
    expect(runCheck({ strict: true }).exitCode).toBe(1);
  });

  it("no store and no lock: still skipped, exit 1 under --strict, and the message says how to fix it", () => {
    const r = runCheck({ strict: true });
    expect(r.outcome).toBe("skipped");
    expect(r.exitCode).toBe(1);
    expect(JSON.stringify(r)).toMatch(/purix lock/);
  });

  it("a damaged lock fails, with or without a store", () => {
    governed();
    writeFileSync(join(dir, LOCK_FILENAME), "{not json");
    expect(readLock(dir).state).toBe("damaged");
    expect(runCheck().exitCode).toBe(1);
    freshCheckout();
    expect(runCheck().exitCode).toBe(1);
  });

  it("a lock that was not refreshed after a change is reported as out of date", () => {
    governed();
    writeTheLock();
    writeManifest(entry({ current_version: 2, last_synced_hash: "f".repeat(64) }));
    closeDb();
    const r = runCheck();
    expect(r.exitCode).toBe(1);
    expect(JSON.stringify(r)).toMatch(/out of date/);
  });

  it("drift names the changed file when the lock matches, and says it cannot when there is no lock", () => {
    governed();
    writeFileSync(join(dir, "b.ts"), B + "// x\n");
    const noLock = JSON.stringify(runCheck());
    expect(noLock).toMatch(/cannot say which/);
    writeFileSync(join(dir, "b.ts"), B); // restore, write the lock, edit again
    writeTheLock();
    writeFileSync(join(dir, "b.ts"), B + "// x\n");
    const withLock = JSON.stringify(runCheck());
    expect(withLock).toMatch(/changed: b\.ts/);
    expect(withLock).not.toMatch(/changed: a\.ts/);
  });
});

describe("recordLandedChange", () => {
  it("puts the change in the hash chain, and the chain still verifies", () => {
    governed();
    const res = recordLandedChange({ kind: "modify", component_id: "comp-a", version: 2, sync_hash: "abc", operation: "update_prompt_text", source: "human" }, dir);
    expect(res.audited).toBe(true);
    expect(res.lock).toBe(false); // the project keeps no lock
    const r = readStoreSnapshot();
    if (r.state !== "ok") throw new Error("no store");
    const payloads = r.snapshot.auditRows.map((x) => x.payload).join("\n");
    expect(payloads).toMatch(/component_change/);
    expect(payloads).not.toMatch(/export const/); // identifiers and hashes only, never contents
    expect(verifyAuditRows(r.snapshot.auditRows, r.snapshot.auditCheckpoint).valid).toBe(true);
  });

  it("refreshes purix.lock.json only when the project already keeps one", () => {
    governed();
    expect(recordLandedChange({ kind: "create", component_id: "comp-a" }, dir).lock).toBe(false);
    expect(existsSync(join(dir, LOCK_FILENAME))).toBe(false);
    writeTheLock();
    writeFileSync(join(dir, "a.ts"), A + "// v2\n");
    writeManifest(entry({ current_version: 2, last_synced_hash: "e".repeat(64) }));
    expect(recordLandedChange({ kind: "modify", component_id: "comp-a", version: 2 }, dir).lock).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, LOCK_FILENAME), "utf-8")).components[0].version).toBe(2);
    closeDb();
    expect(runCheck().sections.find((s) => s.id === "lock")?.outcome).toBe("pass");
  });
});

describe("state location when git appears later", () => {
  it("a store that existed before `git init` stays in use", () => {
    governed();
    expect(resolveSharedStateDir(dir)).toBe(join(dir, ".purix"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    expect(resolveSharedStateDir(dir)).toBe(join(dir, ".purix"));
    const r = readStoreSnapshot();
    expect(r.state).toBe("ok");
    if (r.state === "ok") expect(r.snapshot.manifest.length).toBe(1);
  });

  it("a new project in a git repository still uses the shared state directory", () => {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    expect(resolveSharedStateDir(dir)).toBe(join(dir, ".git", "purix-state"));
  });
});
