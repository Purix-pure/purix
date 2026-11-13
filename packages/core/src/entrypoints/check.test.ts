// src/entrypoints/check.test.ts
//
// Real SQLite stores in real temp directories, no mocks: the claims under test are about what `purix check`
// does and does NOT do to a real store (it must change nothing), so a mocked store would prove nothing.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManifestEntry } from "../manifest/schema";
import { closeDb, getDb, writeManifest, createPendingOperation } from "../manifest/store";
import { resolveSharedStateDir } from "../state/git_common_dir";
import { appendAuditRecord } from "../security/audit_tamper_evidence";
import { recordEvent } from "../manifest/events";
import { computeSyncHash } from "../state/hash";
import { safeRmSync } from "../platform/fs_retry.js";
import { toolsDir } from "../tools/state";
import { runCheck, CHECK_SECTION_ORDER } from "./check";

let originalCwd: string;
let dir: string;

const SRC = "export const a = 1;\n";

function entry(over: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    component_id: "comp-a",
    component_type: "module",
    current_version: 1,
    schema_version: 5,
    parts: { tools: [], config: {} },
    files: ["a.ts"],
    depends_on: [],
    depended_on_by: [],
    version_history: [],
    verification_status: "pass",
    last_synced_hash: computeSyncHash([{ path: "a.ts", content: SRC }]),
    ...over,
  };
}

/** A governed project: one component whose file matches its recorded hash, and one audit record. */
function governed(over: Partial<ManifestEntry> = {}): void {
  writeFileSync(join(dir, "a.ts"), SRC);
  writeManifest(entry(over));
  appendAuditRecord({ event: "test_setup" });
  closeDb();
}

function stateFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string, prefix: string) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      if (name.name === "a.ts" || name.name === "package.json") continue;
      if (name.isDirectory()) walk(join(d, name.name), `${prefix}${name.name}/`);
      else out.push(`${prefix}${name.name}`);
    }
  };
  walk(dir, "");
  return out.sort();
}

beforeEach(() => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "purix-check-"));
  process.chdir(dir);
});

afterEach(() => {
  closeDb();
  process.chdir(originalCwd);
  safeRmSync(dir);
});

describe("runCheck: what it reports", () => {
  it("no Purix state: skipped (never pass), exit 0, exit 1 under --strict, and it creates nothing", () => {
    const before = stateFiles();
    const r = runCheck();
    expect(r.outcome).toBe("skipped");
    expect(r.exitCode).toBe(0);
    expect(r.summary).toMatch(/Nothing was checked/);
    expect(runCheck({ strict: true }).exitCode).toBe(1);
    expect(stateFiles()).toEqual(before);
  });

  it("a governed project that matches what Purix recorded passes", () => {
    governed();
    const r = runCheck({ strict: true });
    expect(r.outcome).toBe("pass");
    expect(r.exitCode).toBe(0);
    expect(r.sections.map((s) => s.id)).toEqual(CHECK_SECTION_ORDER);
    expect(r.summary).toMatch(/1 governed component/);
  });

  it("a file edited outside Purix fails and names the component and file", () => {
    governed();
    writeFileSync(join(dir, "a.ts"), "export const a = 2; // an agent edited this directly\n");
    const r = runCheck();
    expect(r.outcome).toBe("fail");
    expect(r.exitCode).toBe(1);
    const item = r.sections.find((s) => s.id === "drift")!.items[0]!;
    expect(item.subject).toBe("comp-a");
    expect(item.message).toMatch(/changed outside Purix/);
    expect(item.message).toMatch(/a\.ts/);
  });

  it("a governed file that was deleted fails (not silently dropped from the hash)", () => {
    governed();
    rmSync(join(dir, "a.ts"));
    const item = runCheck().sections.find((s) => s.id === "drift")!.items[0]!;
    expect(item.outcome).toBe("fail");
    expect(item.message).toMatch(/a\.ts: file is missing/);
  });

  it("a manifest path that leaves the project is reported and never read", () => {
    governed({ files: ["../outside.ts"] });
    writeFileSync(join(dir, "..", "outside.ts"), "secret");
    try {
      const item = runCheck().sections.find((s) => s.id === "drift")!.items[0]!;
      expect(item.outcome).toBe("fail");
      expect(item.message).toMatch(/leaves the project directory/);
    } finally {
      rmSync(join(dir, "..", "outside.ts"), { force: true });
    }
  });

  it("a component that was never synced is skipped, not passed", () => {
    governed({ last_synced_hash: null });
    const r = runCheck();
    expect(r.outcome).toBe("skipped");
    expect(r.exitCode).toBe(0);
    expect(runCheck({ strict: true }).exitCode).toBe(1);
  });

  it("failed and pending verification: fail is a failure, pending is skipped and says not tested", () => {
    governed({ verification_status: "fail" });
    expect(runCheck().exitCode).toBe(1);
    closeDb();
    writeManifest(entry({ verification_status: "pending" }));
    closeDb();
    const r = runCheck();
    expect(r.outcome).toBe("skipped");
    expect(r.sections.find((s) => s.id === "verification")!.items[0]!.message).toMatch(/pending, not tested/);
  });

  it("a passing component whose latest verification left files untested is skipped, with the not-tested wording", () => {
    governed();
    recordEvent("verification_pass", { component_id: "comp-a", detail: { not_tested: ["a.ts"] } });
    closeDb();
    const r = runCheck({ strict: true });
    expect(r.outcome).toBe("skipped");
    expect(r.exitCode).toBe(1);
    expect(r.sections.find((s) => s.id === "verification")!.items[0]!.message).toMatch(/not tested: no test is related to a\.ts/);
    // A later clean pass clears it.
    recordEvent("verification_pass", { component_id: "comp-a", detail: { not_tested: [] } });
    closeDb();
    expect(runCheck({ strict: true }).outcome).toBe("pass");
  });

  it("a tampered audit record fails with the same rule the audit verifier uses", () => {
    governed();
    appendAuditRecord({ event: "second" });
    getDb().prepare("UPDATE audit_chain SET payload = ? WHERE id = 1").run('{"event":"rewritten"}');
    closeDb();
    const item = runCheck().sections.find((s) => s.id === "audit-chain")!.items[0]!;
    expect(item.outcome).toBe("fail");
    expect(item.message).toMatch(/tamper detected/);
  });

  // Security review: a chain with its newest records deleted, or emptied altogether, is still internally valid. The head receipt beside
  // the store is what remembers the newest record, so `purix check` must read it.
  describe("records removed from the audit chain", () => {
    const chainItem = () => runCheck().sections.find((s) => s.id === "audit-chain")!.items[0]!;

    it("the newest record deleted: fails, and says records were removed", () => {
      governed();
      appendAuditRecord({ event: "second" });
      appendAuditRecord({ event: "third" });
      getDb().prepare("DELETE FROM audit_chain WHERE id = (SELECT MAX(id) FROM audit_chain)").run();
      closeDb();
      const r = runCheck();
      const item = r.sections.find((s) => s.id === "audit-chain")!.items[0]!;
      expect(item.outcome).toBe("fail");
      expect(item.message).toMatch(/Records were removed from the end of the chain/);
      expect(r.exitCode).toBe(1);
    });

    it("every record deleted: fails instead of reading as an empty chain", () => {
      governed();
      appendAuditRecord({ event: "second" });
      getDb().prepare("DELETE FROM audit_chain").run();
      closeDb();
      const item = chainItem();
      expect(item.outcome).toBe("fail");
      expect(item.message).toMatch(/Records were removed from the end of the chain/);
    });

    it("empty chain, governed components and no receipt: not a pass and not a quiet \"nothing yet\"", () => {
      writeFileSync(join(dir, "a.ts"), SRC);
      writeManifest(entry());
      closeDb();
      const item = chainItem();
      expect(item.outcome).toBe("skipped");
      expect(item.message).toMatch(/no head receipt/);
    });

    it("an unreadable receipt is reported as not vouching for the end of the chain", () => {
      governed();
      writeFileSync(join(resolveSharedStateDir(dir), "audit-head.json"), "not json");
      const item = chainItem();
      expect(item.outcome).toBe("skipped");
      expect(item.message).toMatch(/cannot be read/);
    });

    // Nov 7 re-check (F08-02): with the receipt file gone and records still in the chain, check used to say nothing at all. Cutting the
    // tail and deleting the receipt then looked exactly like a healthy chain.
    it("receipt file deleted while the chain still has records: skipped, says the end of the chain is not vouched for", () => {
      governed();
      appendAuditRecord({ event: "second" });
      rmSync(join(resolveSharedStateDir(dir), "audit-head.json"));
      const r = runCheck({ strict: true });
      const item = r.sections.find((s) => s.id === "audit-chain")!.items[0];
      expect(item).toBeDefined();
      expect(item!.outcome).toBe("skipped");
      expect(item!.message).toMatch(/no head receipt/);
      expect(item!.message).toMatch(/not vouched for/);
      expect(r.exitCode).toBe(1); // strict: a skipped check is not a pass
    });

    it("a receipt that matches the chain still passes", () => {
      governed();
      expect(runCheck({ strict: true }).outcome).toBe("pass");
    });
  });

  it("an interrupted operation that never finished fails", () => {
    governed();
    createPendingOperation({ component_id: "comp-a", before_snapshot: [], after_snapshot: [], new_version: 2, operation: "modify", contract_changed: false });
    closeDb();
    const r = runCheck();
    expect(r.outcome).toBe("fail");
    expect(r.sections.find((s) => s.id === "pending-operations")!.items[0]!.message).toMatch(/never finished/);
  });

  it("a store with no components governs nothing: skipped, not a vacuous pass", () => {
    getDb();
    appendAuditRecord({ event: "x" });
    closeDb();
    const r = runCheck();
    expect(r.outcome).toBe("skipped");
    expect(r.summary).toMatch(/no registered components/);
  });

  it("a tampered installed tool fails; a lock that is unreadable fails", () => {
    governed();
    // T1: Purix's tool state is in the user's folder, not the project.
    const state = toolsDir(dir);
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "lock.json"), "{ this is not json");
    const item = runCheck().sections.find((s) => s.id === "tools")!.items[0]!;
    expect(item.outcome).toBe("fail");
    expect(item.message).toMatch(/unreadable/);
  });

  it("T1: a tools folder carried inside the project is not read and is only mentioned, never a failure", () => {
    governed();
    const planted = join(dir, ".purix", "tools");
    mkdirSync(planted, { recursive: true });
    writeFileSync(join(planted, "lock.json"), "{ this is not json");
    const items = runCheck().sections.find((s) => s.id === "tools")!.items;
    expect(items.some((i) => i.outcome === "fail")).toBe(false);
    expect(items.find((i) => i.outcome === "skipped")!.message).toMatch(/not used/);
  });
});

describe("runCheck: what it must never do", () => {
  it("a damaged store is reported as an error and is not repaired, moved or rebuilt", () => {
    governed();
    const dbPath = join(resolveSharedStateDir(), "manifest.db");
    const garbage = Buffer.from("this is not a sqlite database at all, just bytes".repeat(20));
    writeFileSync(dbPath, garbage);
    const before = stateFiles();
    const r = runCheck();
    expect(r.outcome).toBe("error");
    expect(r.exitCode).toBe(1);
    expect(r.sections[0]!.items[0]!.message).toMatch(/damaged/);
    expect(readFileSync(dbPath).equals(garbage)).toBe(true);
    expect(stateFiles()).toEqual(before);
  });

  it("changes nothing: the store file is byte-identical, no state is created, and the only files that may appear are SQLite's own -wal/-shm sidecars", () => {
    governed();
    const dbPath = join(resolveSharedStateDir(), "manifest.db");
    const bytesBefore = readFileSync(dbPath);
    const filesBefore = stateFiles();
    const first = runCheck();
    const second = runCheck();
    expect(readFileSync(dbPath).equals(bytesBefore)).toBe(true);
    // Opening a WAL-mode database read-only makes SQLite create empty -wal/-shm sidecars; nothing else may appear.
    const added = stateFiles().filter((f) => !filesBefore.includes(f));
    for (const f of added) expect(f).toMatch(/^\.purix\/manifest\.db-(wal|shm)$/);
    expect(stateFiles().filter((f) => filesBefore.includes(f))).toEqual(filesBefore);
    // Deterministic: same disk, same report.
    expect(second).toEqual(first);
  });

  it("does not write a migrated manifest entry back (older schemas are migrated in memory only)", () => {
    governed();
    const raw = JSON.stringify(entry({ schema_version: 4 }));
    getDb().prepare("UPDATE manifest SET data = ? WHERE component_id = 'comp-a'").run(raw);
    closeDb();
    const r = runCheck();
    expect(r.sections.find((s) => s.id === "drift")!.items).toEqual([]);
    const stored = getDb().prepare("SELECT data FROM manifest WHERE component_id = 'comp-a'").get() as { data: string };
    expect(JSON.parse(stored.data).schema_version).toBe(4);
  });

  it("a drifted component does not append to the audit chain (unlike checkDrift)", () => {
    governed();
    writeFileSync(join(dir, "a.ts"), "changed\n");
    runCheck();
    const n = getDb().prepare("SELECT COUNT(*) AS n FROM audit_chain").get() as { n: number };
    expect(n.n).toBe(1);
  });
});
