// src/state/drift.test.ts
//
// Same real-sandbox, real-tsc, real-`bun test`, temp-chdir discipline as
// migration.test.ts and store_delete.test.ts — acceptDrift's whole job
// here is setting the trust bar for a new baseline, so a test that mocks
// verifyInSandbox would prove nothing about whether that bar is actually
// "full sandbox pass" rather than "compiles".
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManifestEntry } from "../manifest/schema";
import { acceptDrift } from "./drift";
import { computeSyncHash } from "./hash";
import { closeDb } from "../manifest/store";
import { resolveRealNodeModules } from "../test-support/real_node_modules";

const REAL_NODE_MODULES = resolveRealNodeModules();

const TEST_CONTENT = `import { describe, it } from "node:test";\nimport { expect } from "expect";\nimport { add } from "./component";\n\ndescribe("add", () => {\n  it("adds two numbers", () => {\n    expect(add(2, 3)).toBe(5);\n  });\n});\n`;
// Compiles cleanly but breaks the existing test — the exact class of
// "drift" a compile-only check would have waved through as the new
// trusted baseline.
const LIVE_CONTENT_BREAKS_TEST = `export function add(a: number, b: number): number {\n  return a - b;\n}\n`;
const LIVE_CONTENT_CLEAN = `export function add(a: number, b: number): number {\n  return a + b;\n}\n`;

function makeEntry(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    component_id: "comp-a",
    component_type: "module",
    current_version: 1,
    schema_version: 2,
    parts: { tools: [], config: {} },
    files: ["component.ts"],
    depends_on: [],
    depended_on_by: [],
    version_history: [],
    verification_status: "pass",
    last_synced_hash: "some-prior-hash-that-no-longer-matches",
    ...overrides,
  };
}

let originalCwd: string;
let tmpDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), "purix-drift-test-"));
  writeFileSync(join(tmpDir, "component.test.ts"), TEST_CONTENT);
  if (REAL_NODE_MODULES) {
    try {
      symlinkSync(REAL_NODE_MODULES, join(tmpDir, "node_modules"), "junction");
    } catch {
      // best-effort, same fallback sandbox.ts itself tolerates
    }
  }
  process.chdir(tmpDir);
});

afterEach(() => {
  closeDb();
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("acceptDrift — full sandbox pass as the trust bar for a new baseline", () => {
  it("refuses to accept a new baseline when live content compiles but fails its own test suite", { timeout: 30000 }, async () => {
    writeFileSync(join(tmpDir, "component.ts"), LIVE_CONTENT_BREAKS_TEST);
    const liveFiles = [{ path: "component.ts", content: LIVE_CONTENT_BREAKS_TEST }];
    const liveHash = computeSyncHash(liveFiles);
    const entry = makeEntry();

    const result = await acceptDrift(entry, liveFiles, liveHash, tmpDir);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/sandbox/i);
    // Nothing about the entry advanced — still the pre-drift state.
    expect(entry.current_version).toBe(1);
    expect(entry.last_synced_hash).toBe("some-prior-hash-that-no-longer-matches");
  });

  it("succeeds and adopts the new baseline when live content passes the full sandbox check", { timeout: 30000 }, async () => {
    writeFileSync(join(tmpDir, "component.ts"), LIVE_CONTENT_CLEAN);
    const liveFiles = [{ path: "component.ts", content: LIVE_CONTENT_CLEAN }];
    const liveHash = computeSyncHash(liveFiles);
    const entry = makeEntry();

    const result = await acceptDrift(entry, liveFiles, liveHash, tmpDir);

    expect(result.ok).toBe(true);
    expect(entry.current_version).toBe(2);
    expect(entry.last_synced_hash).toBe(liveHash);
  });
});