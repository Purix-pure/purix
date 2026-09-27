// requireLanguage() and the dev-tier override, previously untested.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireLanguage, getEntitlements, entitlementsCacheIsStale } from "./tier";

let saved: { env: string | undefined; tier: string | undefined };
beforeEach(() => {
  saved = { env: process.env.NODE_ENV, tier: process.env.PURIX_DEV_TIER };
  process.env.NODE_ENV = "test";
  delete process.env.PURIX_DEV_TIER;
});
afterEach(() => {
  if (saved.env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.env;
  if (saved.tier === undefined) delete process.env.PURIX_DEV_TIER; else process.env.PURIX_DEV_TIER = saved.tier;
});

describe("requireLanguage", () => {
  it("allows typescript on the free tier and names the tier when refusing python", () => {
    process.env.PURIX_DEV_TIER = "free";
    expect(() => requireLanguage("typescript")).not.toThrow();
    expect(() => requireLanguage("python")).toThrow(/"python" support is a Pro feature\. Current tier: free/);
  });
  it("allows python on the pro tier", () => {
    process.env.PURIX_DEV_TIER = "pro";
    expect(() => requireLanguage("python")).not.toThrow();
    expect(getEntitlements().tier).toBe("pro");
  });
  it("rejects an undefined dev tier loudly", () => {
    process.env.PURIX_DEV_TIER = "platinum";
    expect(() => getEntitlements()).toThrow(/Invalid or not yet defined PURIX_DEV_TIER: "platinum"/);
  });
});

describe("entitlementsCacheIsStale", () => {
  it("is stale when there is no cache at all", () => {
    const dir = mkdtempSync(join(tmpdir(), "purix-tier-"));
    try {
      expect(entitlementsCacheIsStale(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
