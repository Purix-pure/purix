// src/licensing/tier_signed.test.ts
//
// End-to-end through refreshEntitlements/getEntitlements with a trusted key
// injected: verified documents set the tier, rollbacks and bad documents fall
// back to Free and clear the cache, and an edited cache file is not trusted.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { getEntitlements, refreshEntitlements } from "./tier";
import { TRUSTED_ENTITLEMENT_KEYS } from "./entitlement_signature";
import { saveSession, clearSession } from "../security/session";
import { safeRmSync } from "../platform/fs_retry.js";

const kp = generateKeyPairSync("ed25519");
const rawPub = kp.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

function doc(tier: string, ver: number): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const h = enc({ alg: "EdDSA", kid: "t1" });
  const p = enc({ schema: 1, sub: "u1", tier, flags: { auditExport: true, webhooks: true }, ver, iat: nowSec, exp: nowSec + 3600 });
  return `${h}.${p}.${sign(null, Buffer.from(`${h}.${p}`), kp.privateKey).toString("base64url")}`;
}

describe("tier with signed entitlements", () => {
  let dir: string;
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "purix-tier-signed-"));
    TRUSTED_ENTITLEMENT_KEYS.t1 = rawPub;
    saveSession("token", "user@example.com");
  });
  afterEach(() => {
    delete TRUSTED_ENTITLEMENT_KEYS.t1;
    globalThis.fetch = originalFetch;
    clearSession();
    safeRmSync(dir);
  });

  const serve = (signed: string, tier = "pro") => {
    globalThis.fetch = async () => new Response(JSON.stringify({ tier, flags: { auditExport: true, webhooks: true }, cacheTtlSeconds: 900, signed }), { status: 200 });
  };

  it("a verified document sets the tier and the cache keeps its version", async () => {
    serve(doc("pro", 3));
    const r = await refreshEntitlements(dir);
    expect(r.refreshed).toBe(true);
    expect(getEntitlements(dir).tier).toBe("pro");
    expect(JSON.parse(readFileSync(join(dir, ".purix", "tier-config.json"), "utf8")).signedVersion).toBe(3);
  });

  it("the signed tier wins over an unsigned field that disagrees", async () => {
    serve(doc("free", 1), "enterprise");
    await refreshEntitlements(dir);
    expect(getEntitlements(dir).tier).toBe("free");
  });

  it("an older document is a rollback: Free, a printed reason, and the cached tier is cleared", async () => {
    serve(doc("pro", 5));
    await refreshEntitlements(dir);
    serve(doc("pro", 4));
    const r = await refreshEntitlements(dir);
    expect(r.entitlements.tier).toBe("free");
    expect(r.reason).toMatch(/rollback/);
    expect(getEntitlements(dir).tier).toBe("free");
  });

  it("a tampered document is rejected", async () => {
    const [h, , s] = doc("pro", 2).split(".");
    serve(`${h}.${enc({ schema: 1, sub: "u1", tier: "enterprise", flags: {}, ver: 2, iat: 0, exp: 9999999999 })}.${s}`, "enterprise");
    const r = await refreshEntitlements(dir);
    expect(r.entitlements.tier).toBe("free");
    expect(r.reason).toMatch(/bad signature/);
  });

  it("editing the cached tier by hand does not survive the read-time signature check", async () => {
    serve(doc("pro", 2));
    await refreshEntitlements(dir);
    const path = join(dir, ".purix", "tier-config.json");
    const cache = JSON.parse(readFileSync(path, "utf8"));
    cache.entitlements.tier = "enterprise";
    writeFileSync(path, JSON.stringify(cache));
    expect(getEntitlements(dir).tier).toBe("free");
  });
});
