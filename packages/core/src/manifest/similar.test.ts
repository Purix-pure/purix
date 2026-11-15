// P7 (first slice): suggest existing components a request resembles, deterministically, before a duplicate is created.
import { describe, test } from "node:test";
import { expect } from "expect";
import { findSimilarComponents, similarComponentsNote } from "./similar.js";
import type { ManifestEntry } from "./schema.js";

const comp = (id: string, files: string[] = [`${id}.ts`], o: Partial<ManifestEntry> = {}): ManifestEntry => ({
  component_id: id, component_type: "module", current_version: 1, schema_version: 4, parts: { tools: [], config: {} },
  files, depends_on: [], depended_on_by: [], version_history: [], verification_status: "pass", last_synced_hash: null, ...o,
});

describe("findSimilarComponents", () => {
  const m = [comp("api-client"), comp("billing"), comp("team-board"), comp("__codebase_index__", ["api-client.ts"], { component_type: "codebase_index" })];
  test("a request about the api client finds api-client, and says on what", () => {
    const r = findSimilarComponents("add retry to the api client", m);
    expect(r.map((x) => x.componentId)).toEqual(["api-client"]);
    expect(r[0]!.why).toContain('"api"');
    expect(r[0]!.why).toContain('"client"');
  });
  test("plural and camelCase words match", () => {
    expect(findSimilarComponents("a board for teams", m).map((x) => x.componentId)).toEqual(["team-board"]);
    expect(findSimilarComponents("fix ApiClient timeout", m).map((x) => x.componentId)).toEqual(["api-client"]);
  });
  test("one weak file-name word is not enough, and unrelated requests find nothing", () => {
    expect(findSimilarComponents("something about invoices", m)).toEqual([]);
    expect(findSimilarComponents("add a widget", [comp("zzz", ["widget.ts"])])).toEqual([]);
  });
  test("the codebase index is never suggested, and results are capped and stably ordered", () => {
    const many = ["a-user", "b-user", "c-user", "d-user", "e-user"].map((id) => comp(id));
    const r = findSimilarComponents("user account user", many, 3);
    expect(r.map((x) => x.componentId)).toEqual(["a-user", "b-user", "c-user"]);
    expect(findSimilarComponents("api client", m).some((x) => x.componentId === "__codebase_index__")).toBe(false);
  });
  test("note is empty when nothing resembles the request", () => {
    expect(similarComponentsNote([])).toBe("");
    expect(similarComponentsNote(findSimilarComponents("api client", m))).toContain("change it instead of creating a duplicate");
  });
});
