// packages/core/src/language/registry_cache.ts
//
// Read/write layer for the `language_registry` SQLite table (schema
// created in manifest/store.ts's getDb()). This is a CACHE of what
// discoverLanguages() found — see design doc §3.2 and §5.1
// (docs/adr-drafts/language-plugin-architecture.md). Disk (the
// manifests discoverLanguages() reads) is the source of truth; this
// table exists only so most commands don't have to re-scan the
// filesystem and re-parse every manifest on every invocation. Nothing
// in this file ever treats a cache row as authoritative over a fresh
// discoverLanguages() + computeDiscoveryHash() result — see
// getCachedOrRescan() below, which is the one function everything else
// should call.
import { getDb } from "../manifest/store.js";
import { discoverLanguages, computeDiscoveryHash, type DiscoveredLanguage } from "./discovery.js";

export interface LanguageRegistryRow {
  languageId: string;
  minSupportedVersion: string;
  tier: string;
  capabilities: DiscoveredLanguage["manifest"]["capabilities"];
  scaffoldExtensions: string[];
  installRoot: string;
  manifestPath: string;
  certified: boolean;
  discoveryHash: string;
  lastScannedAt: string;
}

function rowFromDiscovered(d: DiscoveredLanguage, discoveryHash: string, certified: boolean, scannedAt: string): LanguageRegistryRow {
  return {
    languageId: d.manifest.id,
    minSupportedVersion: d.manifest.minSupportedVersion,
    tier: d.manifest.tier,
    capabilities: d.manifest.capabilities,
    scaffoldExtensions: d.manifest.scaffoldExtensions,
    installRoot: d.installRoot,
    manifestPath: d.manifestPath,
    certified,
    discoveryHash,
    lastScannedAt: scannedAt,
  };
}

/**
 * Overwrites the entire language_registry table with exactly what was
 * just discovered. A full replace (delete-then-insert inside one
 * transaction), not an upsert-and-leave-stale-rows — a language that's
 * no longer discoverable (uninstalled) must disappear from this table
 * the same run it disappears from disk, per the person's explicit
 * requirement that removing a language needs no separate cleanup step.
 * Preserves each row's existing `certified` bit across a rescan (a
 * language doesn't lose its certification just because its version
 * string didn't change) unless the language wasn't in the table before,
 * in which case it starts uncertified (fail-closed default — see design
 * doc §3.3).
 */
export function rebuildLanguageRegistryCache(discovered: DiscoveredLanguage[] = discoverLanguages()): LanguageRegistryRow[] {
  const db = getDb();
  const hash = computeDiscoveryHash(discovered);
  const now = new Date().toISOString();

  const existingCertified = new Map<string, boolean>();
  for (const row of readLanguageRegistryCache()) {
    existingCertified.set(row.languageId, row.certified);
  }

  const rows = discovered.map((d) => rowFromDiscovered(d, hash, existingCertified.get(d.manifest.id) ?? false, now));

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM language_registry");
    const insert = db.prepare(`
      INSERT INTO language_registry
        (language_id, min_supported_version, tier, capabilities, scaffold_extensions, install_root, manifest_path, certified, discovery_hash, last_scanned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      insert.run(
        row.languageId,
        row.minSupportedVersion,
        row.tier,
        JSON.stringify(row.capabilities),
        JSON.stringify(row.scaffoldExtensions),
        row.installRoot,
        row.manifestPath,
        row.certified ? 1 : 0,
        row.discoveryHash,
        row.lastScannedAt
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return rows;
}

export function readLanguageRegistryCache(): LanguageRegistryRow[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM language_registry`).all() as any[];
  return rows.map((r) => ({
    languageId: r.language_id,
    minSupportedVersion: r.min_supported_version,
    tier: r.tier,
    capabilities: JSON.parse(r.capabilities),
    scaffoldExtensions: JSON.parse(r.scaffold_extensions),
    installRoot: r.install_root,
    manifestPath: r.manifest_path,
    certified: r.certified === 1,
    discoveryHash: r.discovery_hash,
    lastScannedAt: r.last_scanned_at,
  }));
}

export function setLanguageCertified(languageId: string, certified: boolean): void {
  const db = getDb();
  db.prepare(`UPDATE language_registry SET certified = ? WHERE language_id = ?`).run(certified ? 1 : 0, languageId);
}

/**
 * The one function most callers should use. Reads the cache; if it's
 * empty OR its stored discovery_hash no longer matches a fresh
 * discoverLanguages() scan, rebuilds it first. This is the content-hash
 * check from design doc §5.1 — not a TTL, so a cache never goes stale
 * just because time passed, only because something actually changed on
 * disk (a language package installed or removed).
 */
export function getCachedOrRescan(): LanguageRegistryRow[] {
  const cached = readLanguageRegistryCache();
  const currentHash = computeDiscoveryHash(discoverLanguages());

  if (cached.length > 0 && cached.every((r) => r.discoveryHash === currentHash)) {
    return cached;
  }

  return rebuildLanguageRegistryCache();
}
