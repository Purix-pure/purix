// Research 15, finding 4: no log has a limit. Events older than the retention window can be removed; newer ones stay.
import { describe, it } from "node:test";
import { expect } from "expect";
import { getDbCompat } from "./store.js";
import { listEvents, pruneEvents, recordEvent } from "./events.js";
import { isolateCwdForFile } from "../test-support/isolated_cwd.js";

isolateCwdForFile();

const DAY = 86_400_000;

function insertAged(id: string, daysOld: number): void {
  getDbCompat().run(`INSERT INTO events (id, timestamp, kind, component_id, operation, detail) VALUES (?, ?, 'request', 'c', 'op', '{}')`, [
    id,
    new Date(Date.now() - daysOld * DAY).toISOString(),
  ]);
}

describe("event retention", () => {
  it("removes events older than the limit and keeps the rest", () => {
    recordEvent("request", { component_id: "c" }); // creates the table
    insertAged("old-1", 500);
    insertAged("old-2", 366);
    insertAged("new-1", 364);
    expect(pruneEvents(365)).toBe(2);
    const ids = listEvents().map((e) => e.id);
    expect(ids).toContain("new-1");
    expect(ids).not.toContain("old-1");
    expect(ids).not.toContain("old-2");
  });

  it("never deletes on a bad limit", () => {
    recordEvent("request", { component_id: "c" });
    insertAged("old-3", 2000);
    for (const bad of [0, -1, Number.NaN, 2.5, Number.POSITIVE_INFINITY]) expect(pruneEvents(bad)).toBe(0);
    expect(listEvents().map((e) => e.id)).toContain("old-3");
  });
});
