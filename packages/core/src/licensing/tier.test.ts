// src/licensing/tier.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEntitlements, checkComponentLimit, requireEntitlement, clearEntitlementsCache, entitlementsCacheIsStale, refreshEntitlements } from "./tier";
import { saveSession, clearSession } from "../security/session";
import { ApiUnreachableError, ApiRequestError } from "../security/api_client";

describe("Licensing Tier & Entitlements", () => {
  let tmpDir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "purix-tier-test-"));
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
    clearSession();
  });

  it("defaults to free tier when not logged in", () => {
    const ent = getEntitlements(tmpDir);
    expect(ent.tier).toBe("free");
    expect(ent.componentLimit).toBe(25);
  });

  it("enforces component limit on free tier", () => {
    expect(() => checkComponentLimit(25)).toThrow(/Free tier tracks up to 25 components/);
    expect(() => checkComponentLimit(24)).not.toThrow();
  });

  it("handles cache clearing and staleness checks", () => {
    expect(entitlementsCacheIsStale(tmpDir)).toBe(true);
    clearEntitlementsCache(tmpDir);
    expect(getEntitlements(tmpDir).tier).toBe("free");
  });

  it("handles cached entitlements freshness and grace windows", () => {
    saveSession("token", "user@example.com");
    try {
      const cacheDir = join(tmpDir, ".purix");
      mkdirSync(cacheDir, { recursive: true });
      // Write fresh cache
      writeFileSync(
        join(cacheDir, "tier-config.json"),
        JSON.stringify({
          entitlements: {
            tier: "pro",
            componentLimit: null,
            auditExport: true,
            webhooks: true,
            orgBudgetAggregation: false,
            rbac: false,
            sharedRepoMemory: false,
            mcpToolCalling: false,
            mcpHardened: false,
            orgId: null,
            seatLimit: null,
          },
          cachedAt: new Date().toISOString(),
          cacheTtlSeconds: 900,
        })
      );
      expect(entitlementsCacheIsStale(tmpDir)).toBe(false);
      expect(getEntitlements(tmpDir).tier).toBe("pro");

      // Write expired cache (outside grace)
      const oldDate = new Date(Date.now() - 80 * 3600 * 1000).toISOString();
      writeFileSync(
        join(cacheDir, "tier-config.json"),
        JSON.stringify({
          entitlements: {
            tier: "pro",
            componentLimit: null,
            auditExport: true,
            webhooks: true,
            orgBudgetAggregation: false,
            rbac: false,
            sharedRepoMemory: false,
            mcpToolCalling: false,
            mcpHardened: false,
            orgId: null,
            seatLimit: null,
          },
          cachedAt: oldDate,
          cacheTtlSeconds: 1,
        })
      );
      expect(entitlementsCacheIsStale(tmpDir)).toBe(true);
      // Logged in, but past grace window -> returns free (fail closed)
      expect(getEntitlements(tmpDir).tier).toBe("free");

      // Log out and assert it returns free due to not being logged in
      clearSession();
      expect(getEntitlements(tmpDir).tier).toBe("free");
    } finally {
      clearSession();
    }
  });

  it("requireEntitlement throws on missing entitlement", () => {
    expect(() => requireEntitlement("auditExport")).toThrow(/is a Pro feature/);
  });

  it("handles malformed cache json gracefully", () => {
    saveSession("token", "user@example.com");
    try {
      const cacheDir = join(tmpDir, ".purix");
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, "tier-config.json"), "not json");
      expect(getEntitlements(tmpDir).tier).toBe("free");
    } finally {
      clearSession();
    }
  });

  it("refreshEntitlements fetches from API when logged in and caches result", async () => {
    saveSession("token", "user@example.com");
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          tier: "pro",
          flags: { auditExport: true, webhooks: true },
          cacheTtlSeconds: 900,
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const res = await refreshEntitlements(tmpDir);
    expect(res.refreshed).toBe(true);
    expect(res.entitlements.tier).toBe("pro");
    expect(res.entitlements.auditExport).toBe(true);
    expect(getEntitlements(tmpDir).tier).toBe("pro");
  });

  it("refreshEntitlements handles missing or null flag properties", async () => {
    saveSession("token", "user@example.com");
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          tier: "free",
          flags: {},
          cacheTtlSeconds: 900,
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const res = await refreshEntitlements(tmpDir);
    expect(res.entitlements.componentLimit).toBe(25);
  });

  it("refreshEntitlements handles offline gracefully (ApiUnreachableError)", async () => {
    saveSession("token", "user@example.com");
    globalThis.fetch = (async () => {
      throw new Error("ENOTFOUND");
    }) as typeof fetch;

    const res = await refreshEntitlements(tmpDir);
    expect(res.refreshed).toBe(false);
  });

  it("refreshEntitlements rethrows real server errors", async () => {
    saveSession("token", "user@example.com");
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }) as typeof fetch;

    await expect(refreshEntitlements(tmpDir)).rejects.toBeInstanceOf(ApiRequestError);
  });
});
