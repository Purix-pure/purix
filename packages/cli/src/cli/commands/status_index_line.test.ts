import { describe, it } from "node:test";
import { expect } from "expect";
import type { ManifestEntry } from "@purix/core/manifest/schema";
import { splitIndexRow, indexedFilesLine } from "./status_index_line";

function row(id: string, files: string[]): ManifestEntry {
  return {
    component_id: id, component_type: id === "purix-codebase-index" ? "codebase_index" : "module", current_version: 1, schema_version: 4,
    parts: { tools: [], config: {} }, files, depends_on: [], depended_on_by: [], version_history: [],
    verification_status: "pending", last_synced_hash: null,
  };
}

describe("purix status: the index row is a line, not a component (D-b)", () => {
  it("takes the index row out of the component list", () => {
    const s = splitIndexRow([row("a", ["a.ts"]), row("purix-codebase-index", ["a.ts", "b.ts", "c.ts"])]);
    expect(s.components.map((c) => c.component_id)).toEqual(["a"]);
    expect(s.indexRow?.component_id).toBe("purix-codebase-index");
  });
  it("says how many files were indexed and that they are not governed", () => {
    const line = indexedFilesLine(splitIndexRow([row("purix-codebase-index", ["a.ts", "b.ts", "c.ts"])]).indexRow);
    expect(line).toContain("Indexed files: 3");
    expect(line).toContain("not governed");
    expect(line).toContain("purix adopt");
  });
  it("prints nothing when nothing was indexed", () => {
    expect(indexedFilesLine(splitIndexRow([row("a", [])]).indexRow)).toBeNull();
  });
  it("a store holding only the index row has no components", () => {
    expect(splitIndexRow([row("purix-codebase-index", ["x.ts"])]).components).toEqual([]);
  });
});
