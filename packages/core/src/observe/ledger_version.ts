// packages/core/src/observe/ledger_version.ts
//
// The version of the record the dashboard, the watch feed and the result line read. It is written into the detail of the events
// this round added (`schema`), so a reader can tell a row written by an older Purix from one written by this one, and a developer
// who upgrades mid-project keeps a readable history. A row with no `schema` is version 0: it is read, with the fields it lacks left empty.
//
// Rule for changing it: adding a field does not need a new version (readers treat a missing field as "not recorded"). Renaming or
// changing the meaning of a field does, and the reader must keep understanding the older number.
export const LEDGER_SCHEMA_VERSION = 1;

/** The schema number a stored event detail carries, or 0 for one written before the field existed. */
export function detailSchemaOf(detail: Record<string, unknown> | undefined): number {
  const v = detail?.["schema"];
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;
}
