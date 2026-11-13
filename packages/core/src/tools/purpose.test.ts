// src/tools/purpose.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { shippedCatalog } from "./catalog.js";
import { matchPurpose, tokenize } from "./purpose.js";

const ids = (purpose: string) => matchPurpose(purpose, shippedCatalog()).map((m) => m.entry.id);

describe("matchPurpose (offline, catalog only)", () => {
  it("'run tests' finds every test runner in the catalog, across languages", () => {
    expect(ids("run tests").sort()).toEqual(["jest", "mocha", "pytest", "tsx", "vitest"]);
  });
  it("a language narrows a capability", () => {
    expect(ids("run tests in python")).toEqual(["pytest"]);
    expect(ids("lint my typescript")).toEqual(["eslint"]);
    expect(ids("lint python")).toEqual(["ruff"]);
    expect(ids("type check python")).toEqual(["pyright"]);
    expect(ids("type check typescript")).toEqual(["typescript"]);
  });
  it("dependency and vulnerability words map to the audit tool", () => {
    expect(ids("scan dependencies for vulnerabilities in python")).toEqual(["pip-audit"]);
  });
  it("naming a tool is the strongest signal and wins over capability order", () => {
    expect(ids("vitest")[0]).toBe("vitest");
    expect(ids("I want jest")[0]).toBe("jest");
  });
  it("a language alone lists that language's tools", () => {
    expect(ids("python").sort()).toEqual(["pip-audit", "pyright", "pytest", "ruff"]);
  });
  it("says nothing matches rather than guessing for things the catalog does not hold", () => {
    expect(ids("mypy")).toEqual([]);
    expect(ids("deploy to kubernetes")).toEqual([]);
    expect(ids("")).toEqual([]);
    expect(ids("   ")).toEqual([]);
  });
  it("is stable: same input, same order", () => {
    expect(ids("run tests")).toEqual(ids("run tests"));
  });
  it("every match explains itself", () => {
    for (const m of matchPurpose("run tests", shippedCatalog())) expect(m.reasons.length).toBeGreaterThan(0);
  });
  it("never returns a tool for the wrong language when a language was named", () => {
    for (const id of ids("test python")) expect(["pytest"]).toContain(id);
  });
  it("tokenize ignores punctuation and case", () => {
    expect(tokenize("Run-Tests, PLEASE!")).toEqual(["run", "tests", "please"]);
  });
});

describe("matchPurpose never touches the network", () => {
  it("makes no network call (fetch is replaced with a bomb for the duration)", () => {
    const real = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error("network used"); });
    try {
      expect(() => matchPurpose("run tests", shippedCatalog())).not.toThrow();
    } finally {
      globalThis.fetch = real;
    }
  });
});
