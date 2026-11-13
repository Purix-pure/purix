// packages/cli/src/cli/commands/status_index_line.ts
//
// D-b (decided 2026-11-08, docs/DECISIONS-2026-11-08.md): `purix status` does not list the aggregate `purix-codebase-index` row as a
// component. It is Purix's own listing of indexed files, and nothing governs those files until one is adopted. It is shown as one
// separate "indexed files" line instead. Pure functions, so the split and the wording are tested without a store.
import type { ManifestEntry } from "@purix/core/manifest/schema";

const INDEX_ROW_ID = "purix-codebase-index";

export interface StatusSplit {
  components: ManifestEntry[];
  indexRow: ManifestEntry | null;
}

export function splitIndexRow(all: readonly ManifestEntry[]): StatusSplit {
  return {
    components: all.filter((e) => e.component_id !== INDEX_ROW_ID),
    indexRow: all.find((e) => e.component_id === INDEX_ROW_ID) ?? null,
  };
}

/** One line, or null when no index row exists. The count is the number of files the last `purix index` listed. */
export function indexedFilesLine(indexRow: ManifestEntry | null): string | null {
  if (!indexRow) return null;
  const n = indexRow.files?.length ?? 0;
  return `Indexed files: ${n} (listed by "purix index"; not governed components, so edits to them are not checked. "purix adopt <file>" brings one under Purix.)`;
}
