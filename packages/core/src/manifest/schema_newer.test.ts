// src/manifest/schema_newer.test.ts
//
// H4, schema version skew. An entry stamped by a NEWER Purix used to be read as if it were current: `purix check` printed a green
// "Verification status" for a status this version does not know, and `purix lock` wrote it. Reproduced 2026-11-12 with schema_version 9.
// Rule (Terraform's, and the same for npm's lockfileVersion): an older tool refuses a record from a newer one and says which way
// out there is. It never guesses, and it never writes such a record back.
import { describe, it } from "node:test";
import { expect } from "expect";
import { migrateManifestEntry, CURRENT_SCHEMA_VERSION } from "./schema_migrations";
import { describeStoreProblem } from "../platform/disk_full";
import type { ManifestEntry } from "./schema";

const base = (v: number): ManifestEntry =>
  ({ component_id: "a", component_type: "module", current_version: 1, schema_version: v, parts: { tools: [], config: {} }, files: [], depends_on: [], depended_on_by: [], version_history: [], verification_status: "pending", last_synced_hash: "x", language: "typescript" }) as unknown as ManifestEntry;

describe("migrateManifestEntry and a newer schema", () => {
  it("refuses an entry whose schema_version is above this version, and names both numbers and the way out", () => {
    const fn = () => migrateManifestEntry(base(CURRENT_SCHEMA_VERSION + 1));
    expect(fn).toThrow(/written by a newer Purix/);
    expect(fn).toThrow(new RegExp(`schema_version is ${CURRENT_SCHEMA_VERSION + 1}`));
    expect(fn).toThrow(new RegExp(`up to ${CURRENT_SCHEMA_VERSION}`));
    expect(fn).toThrow(/Upgrade Purix/);
  });

  it("throws a plain Error, so the CLI shows it as an expected failure and not as 'Unhandled error'", () => {
    let thrown: unknown = null;
    try {
      migrateManifestEntry(base(99));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).constructor).toBe(Error);
  });

  it("still returns a current entry unchanged and still migrates an older one", () => {
    const cur = migrateManifestEntry(base(CURRENT_SCHEMA_VERSION));
    expect(cur.migrated).toBe(false);
    const old = migrateManifestEntry(base(1));
    expect(old.migrated).toBe(true);
    expect(old.entry.schema_version).toBe(CURRENT_SCHEMA_VERSION);
  });
});

describe("describeStoreProblem and a newer schema", () => {
  it("says the store came from a newer Purix, not that it is damaged", () => {
    let detail = "";
    try {
      migrateManifestEntry(base(CURRENT_SCHEMA_VERSION + 1));
    } catch (e) {
      detail = (e as Error).message;
    }
    const s = describeStoreProblem(detail, "/x", () => 50_000_000);
    expect(s).not.toMatch(/damaged/);
    expect(s).toMatch(/newer Purix/);
    expect(s).toMatch(/Upgrade Purix/);
  });
});
