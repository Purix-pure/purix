// packages/core/src/language/registry_cache.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../manifest/store";
import {
  rebuildLanguageRegistryCache,
  readLanguageRegistryCache,
  setLanguageCertified,
  getCachedOrRescan,
} from "./registry_cache";
import type { DiscoveredLanguage } from "./discovery";
import { safeRmSync } from "../platform/fs_retry.js";

function makeDiscovered(id: string, version = "1.0.0"): DiscoveredLanguage {
  return {
    manifest: {
      id,
      minSupportedVersion: version,
      tier: "free",
      scaffoldExtensions: [`.${id}`],
      capabilities: {
        compileOrTypeCheck: true,
        testExecution: true,
        testIntegrityCheck: true,
        idiomCheck: true,
        dependencyVulnScan: true,
      },
    },
    manifestPath: `/fake/${id}/purix.language.json`,
    installRoot: `/fake/${id}`,
  };
}

let originalCwd: string;
let tmpDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), "purix-lang-registry-cache-test-"));
  process.chdir(tmpDir);
});

afterEach(() => {
  closeDb();
  process.chdir(originalCwd);
  safeRmSync(tmpDir);
});

describe("rebuildLanguageRegistryCache / readLanguageRegistryCache", () => {
  it("writes discovered languages and reads them back faithfully", () => {
    rebuildLanguageRegistryCache([makeDiscovered("go"), makeDiscovered("rust")]);
    const rows = readLanguageRegistryCache();
    const ids = rows.map((r) => r.languageId).sort();
    expect(ids).toEqual(["go", "rust"]);
  });

  it("round-trips capabilities and scaffoldExtensions correctly through JSON columns", () => {
    rebuildLanguageRegistryCache([makeDiscovered("go")]);
    const [row] = readLanguageRegistryCache();
    expect(row!.capabilities.compileOrTypeCheck).toBe(true);
    expect(row!.scaffoldExtensions).toEqual([".go"]);
  });

  it("a language that disappears from a rescan is removed from the cache (uninstall requires no separate cleanup step)", () => {
    rebuildLanguageRegistryCache([makeDiscovered("go"), makeDiscovered("rust")]);
    expect(readLanguageRegistryCache().length).toBe(2);

    // Simulate "rust" being uninstalled: a second rescan discovers only "go"
    rebuildLanguageRegistryCache([makeDiscovered("go")]);
    const rows = readLanguageRegistryCache();
    expect(rows.map((r) => r.languageId)).toEqual(["go"]);
  });

  it("a newly discovered language requires no manual cache entry — it just appears on the next rebuild", () => {
    rebuildLanguageRegistryCache([makeDiscovered("go")]);
    expect(readLanguageRegistryCache().length).toBe(1);

    rebuildLanguageRegistryCache([makeDiscovered("go"), makeDiscovered("ruby")]);
    const ids = readLanguageRegistryCache().map((r) => r.languageId).sort();
    expect(ids).toEqual(["go", "ruby"]);
  });

  it("starts a newly discovered language as uncertified by default (fail-closed)", () => {
    rebuildLanguageRegistryCache([makeDiscovered("go")]);
    const [row] = readLanguageRegistryCache();
    expect(row!.certified).toBe(false);
  });

  it("preserves an existing language's certified bit across a rescan that doesn't remove it", () => {
    rebuildLanguageRegistryCache([makeDiscovered("go")]);
    setLanguageCertified("go", true);
    expect(readLanguageRegistryCache()[0]!.certified).toBe(true);

    // Rescan with "go" still present (plus a new language) — go's
    // certification must survive, it didn't stop being certified just
    // because another language was also discovered this time.
    rebuildLanguageRegistryCache([makeDiscovered("go"), makeDiscovered("rust")]);
    const goRow = readLanguageRegistryCache().find((r) => r.languageId === "go");
    expect(goRow!.certified).toBe(true);
  });

  it("does NOT carry a certified bit over to a language that was removed and later re-added (re-added means re-certify)", () => {
    rebuildLanguageRegistryCache([makeDiscovered("go")]);
    setLanguageCertified("go", true);

    rebuildLanguageRegistryCache([]); // go uninstalled
    rebuildLanguageRegistryCache([makeDiscovered("go")]); // go reinstalled, fresh row

    const goRow = readLanguageRegistryCache().find((r) => r.languageId === "go");
    expect(goRow!.certified).toBe(false);
  });
});

describe("getCachedOrRescan", () => {
  it("rebuilds when the cache is empty", () => {
    // Uses the real shipped manifests (typescript, python) since
    // getCachedOrRescan() calls discoverLanguages() with no override.
    const rows = getCachedOrRescan();
    const ids = rows.map((r) => r.languageId).sort();
    expect(ids).toEqual(["python", "typescript"]);
  });

  it("reuses the cache on a second call without a discovery-hash-changing event", () => {
    const first = getCachedOrRescan();
    const second = getCachedOrRescan();
    expect(second.map((r) => r.languageId).sort()).toEqual(first.map((r) => r.languageId).sort());
    // Same discoveryHash on both — the cache path was taken, not a
    // pointless rebuild-with-identical-data.
    expect(second[0]!.discoveryHash).toBe(first[0]!.discoveryHash);
  });
});
