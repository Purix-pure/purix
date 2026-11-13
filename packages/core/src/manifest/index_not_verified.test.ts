// src/manifest/index_not_verified.test.ts
//
// Research 02 (section 3.2, option B) and the F05-03 / F01-05-class finding: `purix index` used to run one whole-project
// verification per file (a full copy and compile each, 2 to 6 s per file, superlinear in the research's own measurements),
// then recorded "pass" or "fail" per symbol. The trace that research 02 asked for before changing it (what reads
// `verification_status` after indexing) found no reader that decides anything from it: check, status, the evidence bundle,
// the hook and the governed lock all skip the index row, and the resolver, adopt and change-target read only file, symbol and
// language. So the index now says what it did: files were listed and their symbols recorded, nothing was compiled or tested,
// and every record reads "pending" (the same word adopt already uses for "registered, not yet verified").
//
// Each test below was written first and failed against the old indexer (the broken file was recorded "fail" and the good file
// "pass", both after a sandbox run).
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndex } from "./indexer";
import { readManifest, writeManifest, closeDb } from "./store";
import type { ManifestEntry } from "./schema";
import { safeRmSync } from "../platform/fs_retry.js";

let originalCwd: string;
let tmpDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), "purix-index-nv-"));
  process.chdir(tmpDir);
  writeFileSync(join(tmpDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "es2022", module: "esnext", moduleResolution: "node", noEmit: true } }));
  writeFileSync(join(tmpDir, "good.ts"), `export function fine(): number {\n  return 1;\n}\n`);
  // A file that does not even parse: the old indexer verified it and recorded "fail".
  writeFileSync(join(tmpDir, "broken.ts"), `export const broken = ;\n`);
});

afterEach(() => {
  closeDb();
  process.chdir(originalCwd);
  safeRmSync(tmpDir);
});

describe("purix index: indexed, not verified", () => {
  it("records every symbol as pending, never as pass or fail, whether or not the file compiles", async () => {
    const result = await runIndex(tmpDir);
    const names = result.components.map((c) => c.symbol_name).sort();
    expect(names).toEqual(["broken", "fine"]);
    for (const c of result.components) expect(c.verification_status).toBe("pending");
  });

  it("says in its result that no verification ran, and does not report a failure count that could read as 'checked, none failed'", async () => {
    const result = (await runIndex(tmpDir)) as unknown as Record<string, unknown>;
    expect(result.verification).toBe("not_run");
    // A count of zero failures would read as "all checked and fine" to an agent reading the MCP JSON.
    expect("failedComponentCount" in result).toBe(false);
    expect("failures" in result).toBe(false);
  });

  it("records the index row itself as pending, and replaces a 'pass' or 'fail' left by an older index run", async () => {
    const stale: ManifestEntry = {
      component_id: "purix-codebase-index", component_type: "codebase_index", current_version: 3, schema_version: 5,
      parts: { tools: [], config: {} }, files: ["old.ts"], depends_on: [], depended_on_by: [], version_history: [],
      verification_status: "pass", last_synced_hash: null, components: [],
    };
    writeManifest(stale);
    await runIndex(tmpDir);
    expect(readManifest("purix-codebase-index")?.verification_status).toBe("pending");
    writeManifest({ ...readManifest("purix-codebase-index")!, verification_status: "fail" });
    await runIndex(tmpDir);
    expect(readManifest("purix-codebase-index")?.verification_status).toBe("pending");
  });

  it("still records the file list, the symbol list and a drift baseline hash, and writes components.json", async () => {
    const result = await runIndex(tmpDir);
    const entry = readManifest("purix-codebase-index")!;
    expect([...entry.files].sort()).toEqual(["broken.ts", "good.ts"]);
    expect(entry.last_synced_hash).not.toBeNull();
    expect(entry.components?.length).toBe(result.components.length);
    expect(JSON.parse(readFileSync(join(tmpDir, ".purix", "components.json"), "utf-8"))).toEqual(result.components);
  });

  it("picks up a file added since the last run (nothing is cached across runs)", async () => {
    await runIndex(tmpDir);
    writeFileSync(join(tmpDir, "later.ts"), `export const later = 2;\n`);
    const second = await runIndex(tmpDir);
    expect(second.components.map((c) => c.symbol_name)).toContain("later");
    expect(readManifest("purix-codebase-index")?.files).toContain("later.ts");
  });

  it("indexes 40 more files inside 5 s (tripwire against per-file verification coming back)", async () => {
    // Not a red test on its own: this temp project has no installed toolchain, so the old indexer also finished quickly here (its
    // "not installed" result is immediate). The red proof is the three tests above. On a project with a working compiler the old
    // indexer needed about 1.5 s per file, so 42 files would have taken about a minute; 5 s for the whole run is a tripwire only.
    for (let i = 0; i < 40; i++) writeFileSync(join(tmpDir, `m${i}.ts`), `export const v${i} = ${i};\n`);
    const t0 = performance.now();
    const result = await runIndex(tmpDir);
    const ms = performance.now() - t0;
    expect(result.fileCount).toBe(42);
    expect(ms).toBeLessThan(5000);
  });
});
