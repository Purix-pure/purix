// Drift guard: every kind the reader counts as a stop must have a watch line, and every event kind recorded as a block must be a stop kind.
import { describe, it } from "node:test";
import { expect } from "expect";
import { readFileSync } from "node:fs";
import { STOP_KINDS } from "./ledger_reader.js";
import { eventLine } from "./event_lines.js";

describe("stop kinds", () => {
  it("each one has a STOPPED line in `purix watch`", () => {
    for (const kind of Object.keys(STOP_KINDS)) {
      const line = eventLine({ id: "x", timestamp: new Date().toISOString(), kind, componentId: "c", operation: null, detail: {} } as never);
      expect(`${kind}: ${line}`).toContain("STOPPED");
    }
  });
  it("policy_block is one of them, and its event is declared", () => {
    expect(Object.keys(STOP_KINDS)).toContain("policy_block");
    expect(readFileSync(new URL("../manifest/events.ts", import.meta.url), "utf8")).toContain('"policy_block"');
  });
});

import { beforeEach, afterEach } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb, storeDirectory } from "../manifest/store.js";
import { recordEvent } from "../manifest/events.js";
import { openLedger } from "./ledger_reader.js";
import { safeRmSync } from "../platform/fs_retry.js";

describe("a policy_block event in the reader", () => {
  let cwd: string, dir: string;
  beforeEach(() => { cwd = process.cwd(); dir = mkdtempSync(join(tmpdir(), "purix-pbread-")); process.chdir(dir); getDb(); });
  afterEach(() => { closeDb(); process.chdir(cwd); safeRmSync(dir); });

  it("is counted as a stop, with its reason, in the summary and the stops list", () => {
    recordEvent("policy_block", { component_id: "c", detail: { source: "secret_scan", findings: 1, categories: { "AWS access key": 1 }, files: ["a.ts"] } });
    const ledger = openLedger(storeDirectory())!;
    try {
      expect(ledger.summary().stopped.byKind["policy_block"]).toBe(1);
      expect(ledger.summary().stopped.total).toBe(1);
      const stops = ledger.stops();
      expect(stops.length).toBe(1);
      expect(stops[0]!.reason).toContain("secret scan");
      expect(stops[0]!.detail["categories"]).toEqual({ "AWS access key": 1 });
    } finally { ledger.close(); }
  });
});
