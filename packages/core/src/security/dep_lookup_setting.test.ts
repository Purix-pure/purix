import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLookupSetting, setLookupSetting, hasLookupChoice, mayAskLookup, storedLookupApplies } from "./dep_lookup_setting.js";
import { safeRmSync } from "../platform/fs_retry.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "purix-lookup-")); });
afterEach(() => safeRmSync(dir));

describe("stored lookup setting", () => {
  it("is unset until someone decides", () => {
    expect(readLookupSetting(dir).state).toBe("unset");
    expect(hasLookupChoice(dir)).toBe(false);
  });
  it("remembers on and off", () => {
    setLookupSetting("on", dir, new Date("2026-11-24T00:00:00Z"));
    expect(readLookupSetting(dir)).toEqual({ schema: 1, state: "on", decidedAt: "2026-11-24T00:00:00.000Z" });
    expect(hasLookupChoice(dir)).toBe(true);
    setLookupSetting("off", dir);
    expect(readLookupSetting(dir).state).toBe("off");
  });
  it("a damaged or unknown file reads as unset, never as on", () => {
    writeFileSync(join(dir, "dep_lookup.json"), "{nope");
    expect(readLookupSetting(dir).state).toBe("unset");
    writeFileSync(join(dir, "dep_lookup.json"), JSON.stringify({ schema: 1, state: "yes" }));
    expect(readLookupSetting(dir).state).toBe("unset");
    writeFileSync(join(dir, "dep_lookup.json"), JSON.stringify({ schema: 2, state: "on" }));
    expect(readLookupSetting(dir).state).toBe("unset");
  });
  it("applies only when on, and never in CI", () => {
    expect(storedLookupApplies({}, dir)).toBe(false);
    setLookupSetting("on", dir);
    expect(storedLookupApplies({}, dir)).toBe(true);
    expect(storedLookupApplies({ CI: "true" }, dir)).toBe(false);
    expect(storedLookupApplies({ CI: "0" }, dir)).toBe(true);
    setLookupSetting("off", dir);
    expect(storedLookupApplies({}, dir)).toBe(false);
  });
  it("asks only in a terminal, outside CI, once, and when the variable is not deciding", () => {
    expect(mayAskLookup({ isTTY: true, stored: false, env: {} })).toBe(true);
    expect(mayAskLookup({ isTTY: false, stored: false, env: {} })).toBe(false);
    expect(mayAskLookup({ isTTY: true, stored: true, env: {} })).toBe(false);
    expect(mayAskLookup({ isTTY: true, stored: false, env: { CI: "1" } })).toBe(false);
  });
});
