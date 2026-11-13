// packages/core/src/usage/usage.test.ts
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateUsageEvent, durationBucket } from "./schema";
import { readTelemetry, setConsent, resetInstallId, effectiveConsent, mayPrompt, setCrashDiagnostics } from "./consent";
import { recordUsage, readLedger, aggregate, buildNextPayload, eraseLedger } from "./ledger";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "purix-usage-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("closed schema", () => {
  const base = { day: "2026-10-08", event: "command_run", dimension: "change:ok:lt_1s", count: 1 };

  test("accepts a well-formed event", () => {
    expect(validateUsageEvent(base).ok).toBe(true);
  });

  test("rejects free text, paths, prompts, source code and extra fields in any field", () => {
    for (const dimension of ["add a login form", "/home/me/secret/project", "C:\\Users\\me", "Hello World", "const x = 1;", "a".repeat(49), "x@y.com", "UPPER"]) {
      expect(validateUsageEvent({ ...base, dimension }).ok).toBe(false);
    }
    expect(validateUsageEvent({ ...base, extra: "anything" }).ok).toBe(false);
    expect(validateUsageEvent({ ...base, event: "free_text" }).ok).toBe(false);
    expect(validateUsageEvent({ ...base, count: -1 }).ok).toBe(false);
    expect(validateUsageEvent({ ...base, count: 1.5 }).ok).toBe(false);
    expect(validateUsageEvent({ ...base, count: 100_001 }).ok).toBe(false);
    expect(validateUsageEvent({ ...base, day: "2026-10-08T10:00:00Z" }).ok).toBe(false);
  });

  test("duration buckets", () => {
    expect([0, 999, 1000, 4999, 5000, 29999, 30000, 119999, 120000].map(durationBucket)).toEqual([
      "lt_1s", "lt_1s", "1_5s", "1_5s", "5_30s", "5_30s", "30s_2m", "30s_2m", "gt_2m",
    ]);
  });
});

describe("consent", () => {
  test("default is off: nothing may upload until the user enables it", () => {
    expect(readTelemetry(dir).state).toBe("unset");
    expect(effectiveConsent("unset", {})).toEqual({ upload: false, reason: "not_enabled" });
  });

  test("enable then disable round-trips and keeps the install id", () => {
    const id = setConsent("on", dir).installId;
    expect(readTelemetry(dir).state).toBe("on");
    expect(effectiveConsent("on", {}).upload).toBe(true);
    setConsent("off", dir);
    expect(readTelemetry(dir)).toMatchObject({ state: "off", installId: id });
  });

  test("DO_NOT_TRACK and CI force upload off even when enabled", () => {
    expect(effectiveConsent("on", { DO_NOT_TRACK: "1" })).toEqual({ upload: false, reason: "do_not_track" });
    expect(effectiveConsent("on", { CI: "true" })).toEqual({ upload: false, reason: "ci" });
    expect(effectiveConsent("on", { DO_NOT_TRACK: "0" }).upload).toBe(true);
  });

  test("reset gives a new random install id; crash diagnostics is a separate switch, off by default", () => {
    const a = setConsent("on", dir).installId;
    const b = resetInstallId(dir).installId;
    expect(b).not.toBe(a);
    expect(readTelemetry(dir).crashDiagnostics).toBe(false);
    expect(setCrashDiagnostics(true, dir).crashDiagnostics).toBe(true);
  });

  test("a prompt is allowed only in a terminal, outside CI, with no DNT and no stored choice", () => {
    expect(mayPrompt({ isTTY: true, stored: false, env: {} })).toBe(true);
    expect(mayPrompt({ isTTY: false, stored: false, env: {} })).toBe(false);
    expect(mayPrompt({ isTTY: true, stored: true, env: {} })).toBe(false);
    expect(mayPrompt({ isTTY: true, stored: false, env: { CI: "1" } })).toBe(false);
    expect(mayPrompt({ isTTY: true, stored: false, env: { DO_NOT_TRACK: "1" } })).toBe(false);
  });

  test("a corrupt state file behaves as off", () => {
    expect(readTelemetry(join(dir, "does-not-exist")).state).toBe("unset");
  });
});

describe("ledger", () => {
  test("records locally whatever the consent state, and rejects non-closed events without throwing", () => {
    expect(recordUsage({ event: "command_run", dimension: "change:ok:lt_1s" }, { dir })).toBe(true);
    expect(recordUsage({ event: "command_run", dimension: "my secret prompt" }, { dir })).toBe(false);
    const rows = readLedger(dir);
    expect(rows).toHaveLength(1);
    expect(readFileSync(join(dir, "usage-ledger.jsonl"), "utf8")).not.toContain("secret");
  });

  test("aggregates same-day same-dimension counts", () => {
    const now = new Date("2026-10-08T10:00:00Z");
    recordUsage({ event: "command_run", dimension: "change:ok:lt_1s" }, { dir, now });
    recordUsage({ event: "command_run", dimension: "change:ok:lt_1s" }, { dir, now });
    expect(aggregate(readLedger(dir))).toEqual([{ day: "2026-10-08", event: "command_run", dimension: "change:ok:lt_1s", count: 2 }]);
  });

  test("the next payload has only the install id, version, os and closed rows", () => {
    recordUsage({ event: "step_reached", dimension: "install" }, { dir });
    const payload = buildNextPayload(dir);
    expect(Object.keys(payload).sort()).toEqual(["clientVersion", "installId", "os", "rows"]);
    for (const row of payload.rows) expect(validateUsageEvent(row).ok).toBe(true);
  });

  test("a damaged line is skipped; erase removes the file", () => {
    recordUsage({ event: "step_reached", dimension: "install" }, { dir });
    appendFileSync(join(dir, "usage-ledger.jsonl"), "{not json\n");
    expect(readLedger(dir)).toHaveLength(1);
    eraseLedger(dir);
    expect(existsSync(join(dir, "usage-ledger.jsonl"))).toBe(false);
  });
});

describe("ledger skip list (C-22)", () => {
  test("read-only and setup commands write nothing and create no directory", () => {
    const fresh = join(dir, "never-created");
    for (const d of ["status:ok:lt_1s", "check:ok:lt_1s", "stats:ok:lt_1s", "tools_list:ok:lt_1s", "config:ok:lt_1s", "config_list:ok:lt_1s", "config_set:ok:lt_1s", "connect:ok:lt_1s", "connect:usage:lt_1s"]) {
      expect(recordUsage({ event: "command_run", dimension: d }, { dir: fresh })).toBe(false);
    }
    expect(existsSync(fresh)).toBe(false);
  });

  test("other commands, and other event kinds, are still recorded", () => {
    expect(recordUsage({ event: "command_run", dimension: "change:ok:lt_1s" }, { dir })).toBe(true);
    expect(recordUsage({ event: "command_run", dimension: "tools_install:ok:lt_1s" }, { dir })).toBe(true);
    expect(recordUsage({ event: "step_reached", dimension: "connect" }, { dir })).toBe(true);
    expect(recordUsage({ event: "command_run", dimension: "configure_x:ok:lt_1s" }, { dir })).toBe(true); // prefix needs the "_" boundary
  });
});
