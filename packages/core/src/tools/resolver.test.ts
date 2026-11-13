// src/tools/resolver.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { shippedCatalog } from "./catalog.js";
import { planNeeds, resolveNeed } from "./resolver.js";
import type { ProjectSignals } from "./types.js";

const none: ProjectSignals = { declaredIds: new Set(), projectBinaryIds: new Set() };
const catalog = shippedCatalog();

describe("resolveNeed", () => {
  it("falls back to catalog priority, then id", () => {
    const ids = resolveNeed({ need: { capability: "run-tests", language: "typescript" }, signals: none, installedIds: new Set(), catalog }).map((c) => c.entry.id);
    expect(ids).toEqual(["vitest", "jest", "mocha", "tsx"]);
  });
  it("a tool the project already declares outranks catalog priority, and says why", () => {
    const signals: ProjectSignals = { declaredIds: new Set(["jest"]), projectBinaryIds: new Set() };
    const r = resolveNeed({ need: { capability: "run-tests", language: "typescript" }, signals, installedIds: new Set(), catalog });
    expect(r[0]!.entry.id).toBe("jest");
    expect(r[0]!.reasons).toContain("the project already declares it");
  });
  it("an already-installed tool outranks an uninstalled one with the same footing", () => {
    const r = resolveNeed({ need: { capability: "run-tests", language: "typescript" }, signals: none, installedIds: new Set(["jest"]), catalog });
    expect(r[0]!.entry.id).toBe("jest");
    expect(r[0]!.reasons).toContain("already installed by Purix");
  });
  it("is deterministic: same inputs, same order, every time", () => {
    const run = () => resolveNeed({ need: { capability: "run-tests", language: "typescript" }, signals: none, installedIds: new Set(), catalog }).map((c) => c.entry.id).join(",");
    expect(new Set([run(), run(), run()]).size).toBe(1);
  });
  it("only returns tools for the asked language and capability", () => {
    const r = resolveNeed({ need: { capability: "lint", language: "python" }, signals: none, installedIds: new Set(), catalog });
    expect(r.map((c) => c.entry.id)).toEqual(["ruff"]);
  });
});

describe("planNeeds states", () => {
  it("reports no-candidate honestly when the catalog has nothing", () => {
    const p = planNeeds([{ capability: "lint", language: "go" }], none, new Set(), catalog);
    expect(p.needs[0]!.state).toBe("no-candidate");
    expect(p.needs[0]!.note).toMatch(/shipped catalog/);
  });
  it("typescript dependency audit is served by the package manager and says so, instead of implying a gap", () => {
    const p = planNeeds([{ capability: "dep-audit", language: "typescript" }], none, new Set(), catalog);
    expect(p.needs[0]!.state).toBe("no-candidate");
    expect(p.needs[0]!.note).toMatch(/package manager's own audit/);
    expect(p.needs[0]!.note).not.toMatch(/shipped catalog/);
  });
  it("typescript lint now has a catalog tool (eslint)", () => {
    const p = planNeeds([{ capability: "lint", language: "typescript" }], none, new Set(), catalog);
    expect(p.needs[0]!.chosen?.entry.id).toBe("eslint");
  });
  it("missing / installed / project-provided", () => {
    const need = { capability: "run-tests" as const, language: "typescript" };
    expect(planNeeds([need], none, new Set(), catalog).needs[0]!.state).toBe("missing");
    expect(planNeeds([need], none, new Set(["vitest"]), catalog).needs[0]!.state).toBe("installed");
    const sig: ProjectSignals = { declaredIds: new Set(["vitest"]), projectBinaryIds: new Set(["vitest"]) };
    expect(planNeeds([need], sig, new Set(), catalog).needs[0]!.state).toBe("project-provided");
  });
});

describe("neutrality (ADR-060 D5)", () => {
  it("the ranking types and the resolver carry no commercial-relationship input", () => {
    const forbidden = /sponsor|affiliate|commission|payment|partner|\bpaid\b|\bprice\b|referral/i;
    for (const f of ["./types.ts", "./resolver.ts"]) {
      const text = readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf-8");
      expect(text).not.toMatch(forbidden);
    }
  });
});
