// H1: what a package manager prints, and a project's own package.json, are data from outside. A wrong shape must give "no finding" or
// "not a report" with a reason, never a TypeError. Before this, checkVersionPinning threw on a package.json that was malformed, was
// `null`, or had a range that was not text, and the three report readers threw on a null `via` entry or a `via` that was not a list.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkVersionPinning, parseJsonReport, parseYarn1Report, parseYarnBerryReport } from "./deps_audit.js";
import { safeRmSync } from "../platform/fs_retry.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "purix-pin-"));
});
afterEach(() => safeRmSync(dir, { recursive: true, force: true }));

describe("H1: checkVersionPinning on a package.json of any shape", () => {
  for (const [name, text] of [
    ["malformed JSON", "{nope"],
    ["null", "null"],
    ["a number", "7"],
    ["dependencies as a list", '{"dependencies":[1,"^2"]}'],
    ["dependencies as text", '{"dependencies":"x"}'],
  ] as const) {
    it(`${name}: no crash, no finding`, async () => {
      writeFileSync(join(dir, "package.json"), text);
      await expect(checkVersionPinning(dir)).resolves.toEqual([]);
    });
  }

  it("a range that is not text is skipped and the others are still read", async () => {
    writeFileSync(join(dir, "package.json"), '{"dependencies":{"a":1,"b":"^2.0.0","c":null,"d":"1.0.0"},"devDependencies":{"e":"~3.1.0"}}');
    const found = await checkVersionPinning(dir);
    expect(found.map((f) => f.name).sort()).toEqual(["b", "e"]);
  });
});

describe("H1: audit report readers on wrong shapes", () => {
  it("npm: a null entry or a text entry in `via` is skipped; a real one is kept", () => {
    const r = parseJsonReport(JSON.stringify({ vulnerabilities: { left: { severity: "high", range: "<2", via: [null, "right", { title: "T", url: "u", severity: "high" }] } } }));
    expect(r).toEqual({ report: true, findings: [{ module: "left", severity: "high", title: "T", url: "u", range: "<2" }] });
  });

  it("npm: `via` that is not a list, and a vulnerability that is not an object, give no finding and no throw", () => {
    const r = parseJsonReport(JSON.stringify({ vulnerabilities: { a: { via: { title: "x" } }, b: null, c: 4 } }));
    expect(r).toEqual({ report: true, findings: [] });
  });

  it("pnpm: fields that are not text get the same defaults a missing field gets", () => {
    const r = parseJsonReport(JSON.stringify({ advisories: { 1: { module_name: 5, title: {}, url: [], severity: "critical", vulnerable_versions: null }, 2: null } }));
    expect(r.report).toBe(true);
    if (r.report) {
      expect(r.findings[0]).toEqual({ module: "(unknown)", severity: "critical", title: "(no title)", url: "", range: "unknown" });
      expect(r.findings).toHaveLength(2);
    }
  });

  for (const text of ["null", "7", '"x"', "[]", "{}", '{"error":null}', '{"error":{"message":5}}']) {
    it(`${text} is not a report, with a reason`, () => {
      const r = parseJsonReport(text);
      expect(r.report).toBe(false);
      if (!r.report) expect(r.why.length).toBeGreaterThan(0);
    });
  }

  it("yarn 1: lines that are null, numbers or advisories without data do not throw", () => {
    const out = ["null", "7", '{"type":"auditAdvisory"}', '{"type":"auditAdvisory","data":null}', '{"type":"auditAdvisory","data":{"advisory":{"module_name":"m","severity":"low"}}}', '{"type":"auditSummary"}'].join("\n");
    const r = parseYarn1Report(out);
    expect(r.report).toBe(true);
    if (r.report) expect(r.findings.map((f) => f.module)).toEqual(["m"]);
  });

  it("yarn 4: lines that are null, or whose children is not an object, do not throw", () => {
    const out = ["null", '{"value":"a","children":null}', '{"value":"a","children":"x"}', '{"value":"m","children":{"Severity":"high","Issue":"I","URL":"u","Vulnerable Versions":"<1"}}'].join("\n");
    const r = parseYarnBerryReport(out, 1);
    expect(r).toEqual({ report: true, findings: [{ module: "m", severity: "high", title: "I", url: "u", range: "<1" }] });
  });
});
