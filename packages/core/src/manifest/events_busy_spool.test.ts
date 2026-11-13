// Research 15, finding 3: an event recorded while another process holds the store's write lock was dropped for good.
// Reproduced with a second connection holding BEGIN IMMEDIATE. Now the event waits in a file next to the store and is written
// (with its original id and time) the next time the store accepts a write or is read.
import { describe, it } from "node:test";
import { expect } from "expect";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getDbCompat, getDbFilePath } from "./store.js";
import { flushPendingEvents, listEvents, recordEvent } from "./events.js";
import { isolateCwdForFile } from "../test-support/isolated_cwd.js";

isolateCwdForFile();

function withLockedStore(fn: () => void): void {
  recordEvent("request", { component_id: "setup" }); // opens the store and creates the table
  const dbPath = getDbFilePath();
  if (!dbPath) throw new Error("store did not open");
  getDbCompat().run("PRAGMA busy_timeout = 50"); // the real wait is 5 s; the behaviour is the same
  const other = new DatabaseSync(dbPath);
  other.exec("BEGIN IMMEDIATE");
  try { fn(); } finally { other.exec("ROLLBACK"); other.close(); }
}

describe("events recorded while the store is busy", () => {
  it("are kept and written later, with their original id and time", () => {
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (m: unknown) => { warnings.push(String(m)); };
    let heldAt = "";
    try {
      withLockedStore(() => {
        recordEvent("hook_denied", { component_id: "c-busy", detail: { agent: "claude-code" } });
        heldAt = new Date().toISOString();
        expect(listEvents({ kind: "hook_denied" }).length).toBe(0); // not in the table while the lock is held
      });
    } finally { console.warn = realWarn; }
    expect(warnings.join("\n")).toMatch(/kept in events-pending\.jsonl/);
    const spool = join(dirname(getDbFilePath()!), "events-pending.jsonl");
    expect(existsSync(spool)).toBe(true);

    const [event] = listEvents({ kind: "hook_denied" }); // a read flushes the file
    if (!event) throw new Error("the event was not written");
    expect(event.component_id).toBe("c-busy");
    expect(event.detail).toEqual({ agent: "claude-code" });
    expect(event.timestamp <= heldAt).toBe(true);
    expect(existsSync(spool)).toBe(false);
  });

  it("are written by the next successful record, and never twice", () => {
    withLockedStore(() => {
      const realWarn = console.warn; console.warn = () => undefined;
      try { recordEvent("escalation_start", { component_id: "c-twice" }); } finally { console.warn = realWarn; }
    });
    const spool = join(dirname(getDbFilePath()!), "events-pending.jsonl");
    const saved = readFileSync(spool, "utf8");
    recordEvent("request", { component_id: "next" }); // flushes
    expect(existsSync(spool)).toBe(false);
    writeFileSync(spool, saved); // the same line comes back, as it would if two processes flushed at once
    expect(flushPendingEvents()).toBe(1);
    expect(listEvents({ kind: "escalation_start", componentId: "c-twice" }).length).toBe(1);
  });

  it("skips a torn last line and keeps the good ones", () => {
    recordEvent("request", { component_id: "setup2" });
    const spool = join(dirname(getDbFilePath()!), "events-pending.jsonl");
    const good = JSON.stringify({ id: "good-1", timestamp: new Date().toISOString(), kind: "request", component_id: "c-torn", operation: null, detail: "{}" });
    writeFileSync(spool, `${good}\n{"id":"half`);
    expect(flushPendingEvents()).toBe(1);
    expect(listEvents({ componentId: "c-torn" }).length).toBe(1);
  });
});
