// src/manifest/mentions.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { extractMentions, filterVerbatimMentions, deriveComponentName, MAX_MENTIONS } from "./mentions.js";
import { resolveTarget } from "./resolver.js";
import type { ManifestEntry } from "./schema.js";

function entry(o: Partial<ManifestEntry> & { component_id: string }): ManifestEntry {
  return {
    component_type: "module", current_version: 1, schema_version: 1, parts: { tools: [], config: {} },
    files: [], depends_on: [], depended_on_by: [], version_history: [],
    verification_status: "unverified" as ManifestEntry["verification_status"], last_synced_hash: null, ...o,
  };
}

describe("extractMentions", () => {
  it("pulls an id out of a sentence, stripping punctuation", () => {
    expect(extractMentions('modify the billing-service, to add rounding.')).toContain("billing-service");
  });
  it("keeps paths and strips :line:col suffixes", () => {
    expect(extractMentions("look at src/billing/service.ts:42:7 please")).toContain("src/billing/service.ts");
  });
  it("joins adjacent words so a spaced phrase can meet a kebab id", () => {
    expect(extractMentions("fix the billing service rounding")).toContain("billing-service");
  });
  it("drops stopwords and generic path words", () => {
    const m = extractMentions("add the src index to it");
    expect(m).not.toContain("add");
    expect(m).not.toContain("src");
    expect(m).not.toContain("the");
  });
  it("is deterministic, de-duplicated and bounded", () => {
    const a = extractMentions("alpha alpha ALPHA beta");
    expect(a).toEqual(extractMentions("alpha alpha ALPHA beta"));
    expect(a.filter((x) => x.toLowerCase() === "alpha").length).toBe(1);
    const big = Array.from({ length: 5000 }, (_, i) => `w${i}x`).join(" ");
    expect(extractMentions(big).length).toBeLessThanOrEqual(MAX_MENTIONS);
  });
  it("returns nothing for empty input", () => {
    expect(extractMentions("   ")).toEqual([]);
  });
});

describe("raw intent as a single mention (the handoff's proposed v0)", () => {
  const manifest = [entry({ component_id: "billing-service", files: ["src/billing/service.ts"] })];
  it("does NOT resolve — proving tokenization is required", () => {
    const r = resolveTarget({ mentions: ["modify the billing-service to add rounding"], manifest });
    expect(r.outcome).toBe("none");
  });
  it("resolves once tokenized", () => {
    const r = resolveTarget({ mentions: extractMentions("modify the billing-service to add rounding"), manifest });
    expect(r.outcome).toBe("single");
    if (r.outcome !== "single") throw new Error("unreachable");
    expect(r.target.componentId).toBe("billing-service");
  });
});

describe("resolver hardening", () => {
  const idx = (names: string[]) =>
    entry({
      component_id: "purix-codebase-index", component_type: "codebase_index",
      components: names.map((n) => ({
        symbol_name: n, file_location: "src/a.ts", signature: "", language: "typescript",
        verification_status: "unverified" as ManifestEntry["verification_status"],
        last_verified_commit_hash: null, reusable: false, rationale: null,
      })),
    });
  it("symbol match is exact-case: an English word never resolves a write target", () => {
    const manifest = [entry({ component_id: "a", files: ["src/a.ts"] }), idx(["parse", "Parser"])];
    expect(resolveTarget({ mentions: ["Parse"], manifest }).outcome).toBe("none");
    expect(resolveTarget({ mentions: ["parse"], manifest }).outcome).toBe("single");
  });
  it("very short symbol names are ignored", () => {
    const manifest = [entry({ component_id: "a", files: ["src/a.ts"] }), idx(["id"])];
    expect(resolveTarget({ mentions: ["id"], manifest }).outcome).toBe("none");
  });
  it("ties are ordered by component id, not manifest order", () => {
    const m1 = [entry({ component_id: "zeta", files: ["src/x/one.ts"] }), entry({ component_id: "alpha", files: ["src/x/two.ts"] })];
    const r = resolveTarget({ mentions: ["x"], manifest: m1 });
    if (r.outcome !== "multiple") throw new Error("unreachable");
    expect(r.candidates.map((c) => c.componentId)).toEqual(["alpha", "zeta"]);
    const r2 = resolveTarget({ mentions: ["x"], manifest: [...m1].reverse() });
    if (r2.outcome !== "multiple") throw new Error("unreachable");
    expect(r2.candidates.map((c) => c.componentId)).toEqual(["alpha", "zeta"]);
  });
});

describe("filterVerbatimMentions (Decision 2 guard)", () => {
  const intent = "please tidy the billing service and the invoice renderer";
  it("keeps proposals that occur in the intent, adds a kebab variant", () => {
    expect(filterVerbatimMentions(intent, ["billing service"])).toEqual(["billing service", "billing-service"]);
  });
  it("drops proposals the model invented", () => {
    expect(filterVerbatimMentions(intent, ["auth-service", "payments"])).toEqual([]);
  });
  it("does not match inside a longer word", () => {
    expect(filterVerbatimMentions("the invoicing code", ["invoice"])).toEqual([]);
  });
  it("tolerates non-array and non-string output", () => {
    expect(filterVerbatimMentions(intent, "billing")).toEqual([]);
    expect(filterVerbatimMentions(intent, [1, null, {}, "invoice renderer"])).toContain("invoice-renderer");
  });
});

describe("deriveComponentName", () => {
  it("makes a short kebab-case seed", () => {
    expect(deriveComponentName("Add a rate limiter to the API gateway")).toBe("rate-limiter-api-gateway");
  });
  it("falls back when nothing usable", () => {
    expect(deriveComponentName("add the")).toBe("new-component");
  });
});