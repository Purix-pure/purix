// src/entrypoints/check_next_steps.test.ts
//
// `purix check` tells a person what to DO about each problem, in their words (their files, a command to run), not only what is wrong.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManifestEntry } from "../manifest/schema";
import { closeDb, writeManifest } from "../manifest/store";
import { appendAuditRecord } from "../security/audit_tamper_evidence";
import { computeSyncHash } from "../state/hash";
import { safeRmSync } from "../platform/fs_retry.js";
import { runCheck } from "./check";

let originalCwd: string;
let dir: string;
const SRC = "export const a = 1;\n";

function governed(): void {
  writeFileSync(join(dir, "a.ts"), SRC);
  const e: ManifestEntry = {
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
  };
  writeManifest(e);
  appendAuditRecord({ event: "test_setup" });
  closeDb();
}

beforeEach(() => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "purix-check-next-"));
  process.chdir(dir);
});
afterEach(() => {
  closeDb();
  process.chdir(originalCwd);
  safeRmSync(dir);
});

describe("purix check: a next step on every drift failure", () => {
  it("a deleted file says how to get it back and how to accept the deletion", () => {
    governed();
    rmSync(join(dir, "a.ts"));
    const item = runCheck().sections.find((s) => s.id === "drift")!.items[0]!;
    expect(item.message).toMatch(/a\.ts: file is missing/);
    expect(item.next).toMatch(/restore it from version control/);
    expect(item.next).toContain('purix migration accept-drift comp-a');
    expect(item.next).toMatch(/yourself in a terminal/);
  });

  it("an edited file says to review it, then accept or revert", () => {
    governed();
    writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
    const item = runCheck().sections.find((s) => s.id === "drift")!.items[0]!;
    expect(item.next).toMatch(/Review the change/);
    expect(item.next).toContain("purix migration accept-drift comp-a");
  });

  it("a clean project has no next steps at all", () => {
    governed();
    const r = runCheck();
    expect(r.sections.flatMap((s) => s.items).filter((i) => i.next !== undefined)).toEqual([]);
  });
});
