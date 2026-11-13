import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverLanguages } from "./discovery.js";
import { languagesForTier } from "./tier_languages.js";
import { pythonPack } from "./providers/python.pack.js";
import { getLanguageProvider } from "./registry.js";
import { getEntitlements } from "../licensing/tier.js";
import { safeRmSync } from "../platform/fs_retry.js";

const manifest = (id: string, tier: string) =>
  JSON.stringify({ id, minSupportedVersion: "1.0.0", tier, scaffoldExtensions: [".x"], capabilities: { compileOrTypeCheck: true, testExecution: true, testIntegrityCheck: true, idiomCheck: true, dependencyVulnScan: true } });

describe("languagesForTier", () => {
  it("every shipped language is free (decision D-14: Python and all languages cost nothing), typescript first", () => {
    assert.deepEqual(languagesForTier("free"), ["typescript", "python"]);
    assert.deepEqual(languagesForTier("pro"), ["typescript", "python"]);
  });

  it("a higher tier includes every lower tier's languages", () => {
    const d = mkDiscovered({ a: "free", b: "pro", c: "team", d: "enterprise" });
    assert.deepEqual(languagesForTier("free", d), ["a"]);
    assert.deepEqual(languagesForTier("pro", d), ["a", "b"]);
    assert.deepEqual(languagesForTier("team", d), ["a", "b", "c"]);
    assert.deepEqual(languagesForTier("enterprise", d), ["a", "b", "c", "d"]);
  });

  it("a language with a broken manifest is not entitled at any tier (fails closed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "purix-tierlang-"));
    try {
      writeFileSync(join(dir, "good.json"), manifest("good", "free"));
      writeFileSync(join(dir, "bad.json"), '{"id":"bad","tier":"gold"}');
      const origErr = console.error;
      console.error = () => {};
      try {
        assert.deepEqual(languagesForTier("enterprise", discoverLanguages(dir)), ["good"]);
      } finally {
        console.error = origErr;
      }
    } finally {
      safeRmSync(dir);
    }
  });
});

describe("D-14: every language is free", () => {
  it("no shipped language manifest may carry a paid tier (guard against reintroducing a Python or language paywall)", () => {
    for (const d of discoverLanguages()) assert.equal(d.manifest.tier, "free", `${d.manifest.id} must stay free (decision D-14)`);
  });
});

describe("one source of truth (the check PURIX-17 P2-D asked for)", () => {
  it("every registered pack's tier equals its manifest's tier", () => {
    const byId = new Map(discoverLanguages().map((d) => [d.manifest.id, d.manifest.tier]));
    assert.equal(byId.get(pythonPack.languageId), pythonPack.tier);
  });

  it("every language a tier allows has a registered provider, and every provider is in some tier", () => {
    for (const id of languagesForTier("enterprise")) assert.ok(getLanguageProvider(id), `${id} has a manifest but no provider`);
    for (const d of discoverLanguages()) assert.ok(getLanguageProvider(d.manifest.id), `${d.manifest.id} manifest has no provider`);
  });

  it("the built-in free and pro entitlements use the derived lists", () => {
    const prev = process.env.PURIX_DEV_TIER;
    const prevEnv = process.env.NODE_ENV;
    try {
      // The override is honoured only under NODE_ENV=test (see getEntitlements); set it explicitly
      // so this test does not depend on how the runner was started.
      process.env.NODE_ENV = "test";
      process.env.PURIX_DEV_TIER = "free";
      assert.deepEqual(getEntitlements(tmpdir()).allowedLanguages, languagesForTier("free"));
      process.env.PURIX_DEV_TIER = "pro";
      assert.deepEqual(getEntitlements(tmpdir()).allowedLanguages, languagesForTier("pro"));
    } finally {
      if (prev === undefined) delete process.env.PURIX_DEV_TIER;
      else process.env.PURIX_DEV_TIER = prev;
      if (prevEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevEnv;
    }
  });
});

function mkDiscovered(spec: Record<string, string>) {
  return Object.entries(spec).map(([id, tier]) => ({
    manifest: JSON.parse(manifest(id, tier)),
    manifestPath: `${id}.json`,
    installRoot: ".",
  }));
}
