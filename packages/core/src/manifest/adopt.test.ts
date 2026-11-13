// packages/core/src/manifest/adopt.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookupAdoptable, buildAdoptedEntry, deriveAdoptedId, siblingTestFile, normalizeRepoPath, CODEBASE_INDEX_COMPONENT_ID } from "./adopt.js";
import type { ManifestEntry, ComponentRecord } from "./schema.js";
import { computeSyncHash } from "../state/hash.js";

function entry(o: Partial<ManifestEntry> & { component_id: string }): ManifestEntry {
  return {
    component_type: "module", current_version: 1, schema_version: 1, parts: { tools: [], config: {} },
    files: [], depends_on: [], depended_on_by: [], version_history: [], verification_status: "pending", last_synced_hash: null, ...o,
  };
}
function rec(symbol: string, file: string): ComponentRecord {
  return { symbol_name: symbol, file_location: file, signature: `export function ${symbol}`, language: "typescript", verification_status: "pass", last_verified_commit_hash: null, reusable: true, rationale: null };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "purix-adopt-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/slug.ts"), "export const slugify = 1;\n");
  writeFileSync(join(dir, "src/slug.test.ts"), "// test\n");
  writeFileSync(join(dir, "src/lone.ts"), "export const lone = 1;\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const index = (extra: Partial<ManifestEntry> = {}) =>
  entry({ component_id: CODEBASE_INDEX_COMPONENT_ID, component_type: "codebase_index", files: ["src/slug.ts", "src/slug.test.ts", "src/lone.ts"],
    components: [rec("slugify", "src/slug.ts"), rec("lone", "src/lone.ts"), rec("dup", "src/slug.ts"), rec("dup", "src/lone.ts")], ...extra });

describe("lookupAdoptable", () => {
  it("finds an unowned indexed file by path (relative, ./ and absolute forms)", () => {
    for (const t of ["src/slug.ts", "./src/slug.ts", join(dir, "src/slug.ts")]) {
      expect(lookupAdoptable(t, [index()], dir)).toMatchObject({ outcome: "adoptable", file: "src/slug.ts", via: "file_path" });
    }
  });
  it("finds it by exact symbol name only", () => {
    expect(lookupAdoptable("slugify", [index()], dir)).toMatchObject({ outcome: "adoptable", file: "src/slug.ts", via: "symbol_name" });
    expect(lookupAdoptable("Slugify", [index()], dir).outcome).toBe("not_indexed");
  });
  it("reports ambiguity instead of guessing when a symbol lives in two files", () => {
    expect(lookupAdoptable("dup", [index()], dir)).toEqual({ outcome: "ambiguous", candidates: ["src/lone.ts", "src/slug.ts"] });
  });
  it("says already_owned when a component already holds the file", () => {
    const m = [index(), entry({ component_id: "slug", files: ["src/slug.ts"] })];
    expect(lookupAdoptable("src/slug.ts", m, dir)).toEqual({ outcome: "already_owned", file: "src/slug.ts", owner: "slug" });
  });
  it("says not_indexed for unknown targets and when there is no index row at all", () => {
    expect(lookupAdoptable("src/nope.ts", [index()], dir).outcome).toBe("not_indexed");
    expect(lookupAdoptable("src/slug.ts", [], dir).outcome).toBe("not_indexed");
  });
});

describe("buildAdoptedEntry", () => {
  it("creates a pending v1 component with the sibling test, a real baseline hash, and adopt provenance", () => {
    const { entry: e } = buildAdoptedEntry({ file: "src/slug.ts", manifest: [index()], baseDir: dir, now: new Date("2026-10-01T00:00:00Z") });
    expect(e.component_id).toBe("slug");
    expect(e.files).toEqual(["src/slug.ts", "src/slug.test.ts"]);
    expect(e.verification_status).toBe("pending");
    expect(e.current_version).toBe(1);
    expect(e.version_history[0]).toMatchObject({ operation: "adopt", patch_ref: "adopted-from-index" });
    expect(e.last_synced_hash).toBe(computeSyncHash([{ path: "src/slug.test.ts", content: "// test\n" }, { path: "src/slug.ts", content: "export const slugify = 1;\n" }]));
    expect(e.language).toBe("typescript");
  });
  it("adopts just the file when it has no sibling test", () => {
    expect(buildAdoptedEntry({ file: "src/lone.ts", manifest: [index()], baseDir: dir }).entry.files).toEqual(["src/lone.ts"]);
  });
  it("refuses a file another component already owns, and names that component", () => {
    expect(() => buildAdoptedEntry({ file: "src/slug.ts", manifest: [index(), entry({ component_id: "x", files: ["src/slug.ts"] })], baseDir: dir })).toThrow(/already belongs to component "x"/);
  });
  it("refuses a stale index entry whose file is gone", () => {
    rmSync(join(dir, "src/lone.ts"));
    expect(() => buildAdoptedEntry({ file: "src/lone.ts", manifest: [index()], baseDir: dir })).toThrow(/no longer exists/);
  });
  it("does not steal a test file another component owns", () => {
    const m = [index(), entry({ component_id: "t", files: ["src/slug.test.ts"] })];
    expect(buildAdoptedEntry({ file: "src/slug.ts", manifest: m, baseDir: dir }).entry.files).toEqual(["src/slug.ts"]);
  });
});

describe("helpers", () => {
  it("deriveAdoptedId never collides with an existing id or the index row", () => {
    const m = [entry({ component_id: "slug" }), entry({ component_id: "utils-slug" })];
    expect(deriveAdoptedId("src/utils/slug.ts", m)).toBe("utils-slug-2");
    expect(deriveAdoptedId("src/codebase-index.ts", [])).toBe("codebase-index");
    expect(deriveAdoptedId("purix-codebase-index.ts", [])).not.toBe(CODEBASE_INDEX_COMPONENT_ID);
  });
  it("siblingTestFile finds .test/.spec and python test_ files, and never pairs a test with itself", () => {
    writeFileSync(join(dir, "src/b.ts"), ""); writeFileSync(join(dir, "src/b.spec.ts"), "");
    writeFileSync(join(dir, "src/p.py"), ""); writeFileSync(join(dir, "src/test_p.py"), "");
    expect(siblingTestFile("src/b.ts", dir)).toBe("src/b.spec.ts");
    expect(siblingTestFile("src/p.py", dir)).toBe("src/test_p.py");
    expect(siblingTestFile("src/slug.test.ts", dir)).toBeNull();
  });
  it("normalizeRepoPath yields repo-relative POSIX paths", () => {
    expect(normalizeRepoPath("./src/a.ts", dir)).toBe("src/a.ts");
    expect(normalizeRepoPath(join(dir, "src", "a.ts"), dir)).toBe("src/a.ts");
  });
});
