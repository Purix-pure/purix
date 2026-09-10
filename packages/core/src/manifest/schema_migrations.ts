// src/manifest/schema_migrations.ts
import type { ManifestEntry } from "./schema.js";

export const CURRENT_SCHEMA_VERSION = 5;

type Migration = (entry: any) => any;

/**
 * v1.0 §4.2: "a migration path is required whenever the schema changes."
 * Keyed by the version a migration upgrades FROM.
 *
 * Migration 1 -> 2: adds the Provenance field (§4.1 Must-Have) to every
 * existing version_history entry.
 *
 * Migration 2 -> 3: adds the language field per ADR-052. Existing components default to typescript.
 *
 * Migration 3 -> 4: adds component-level fields (components array) for purix index.
 *
 * Migration 4 -> 5: adds the decision-rationale ("why") field to every existing
 * component record, defaulting to null (no rationale attached yet). See
 * RationaleNote in schema.ts.
 */
const MIGRATIONS: Record<number, Migration> = {
  1: (v1entry) => ({
    ...v1entry,
    schema_version: 2,
    version_history: (v1entry.version_history ?? []).map((v: any) => ({
      ...v,
      provenance: v.provenance ?? { source_type: "instruction", source_agent: null },
    })),
  }),
  2: (v2entry) => ({
    ...v2entry,
    schema_version: 3,
    language: v2entry.language ?? "typescript",
  }),
  3: (v3entry) => ({
    ...v3entry,
    schema_version: 4,
    components: v3entry.components ?? [],
  }),
  4: (v4entry) => ({
    ...v4entry,
    schema_version: 5,
    components: (v4entry.components ?? []).map((c: any) => ({
      ...c,
      rationale: c.rationale ?? null,
    })),
  }),
};

export function migrateManifestEntry(entry: ManifestEntry): { entry: ManifestEntry; migrated: boolean } {
  let current: any = { ...entry, schema_version: entry.schema_version ?? 1 };
  let migrated = false;

  while (current.schema_version < CURRENT_SCHEMA_VERSION) {
    const migration = MIGRATIONS[current.schema_version];
    if (!migration) {
      throw new Error(
        `Manifest entry "${current.component_id}" is at schema_version ${current.schema_version}, ` +
          `but no migration is registered to advance it toward ${CURRENT_SCHEMA_VERSION}. ` +
          `Refusing to guess — add a migration in schema_migrations.ts before this entry can be read again.`
      );
    }
    current = migration(current);
    migrated = true;
  }

  return { entry: current as ManifestEntry, migrated };
}