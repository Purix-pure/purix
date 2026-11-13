// packages/core/src/licensing/entitlement_signature.test.ts
import { describe, test } from "node:test";
import { expect } from "expect";
import { generateKeyPairSync, sign } from "node:crypto";
import { checkSignedEntitlements, TRUSTED_ENTITLEMENT_KEYS, REQUIRE_SIGNED } from "./entitlement_signature";

const now = new Date("2026-10-08T12:00:00Z");
const nowSec = Math.floor(now.getTime() / 1000);
const kp = generateKeyPairSync("ed25519");
const rawPub = kp.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
const keys = { k1: rawPub };
const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

function token(over: Record<string, unknown> = {}, header: Record<string, unknown> = {}, signWith = kp.privateKey): string {
  const h = enc({ alg: "EdDSA", kid: "k1", ...header });
  const p = enc({ schema: 1, sub: "u1", tier: "pro", flags: { auditExport: true }, ver: 5, iat: nowSec - 10, exp: nowSec + 600, ...over });
  return `${h}.${p}.${sign(null, Buffer.from(`${h}.${p}`), signWith).toString("base64url")}`;
}
const check = (signed: string | undefined, extra = {}) => checkSignedEntitlements({ ...(signed ? { signed } : {}) }, { keys, now, ...extra });

describe("signed entitlements", () => {
  test("ships dormant: no trusted key, so every response is treated as unsigned; signing is not required yet", () => {
    expect(Object.keys(TRUSTED_ENTITLEMENT_KEYS)).toHaveLength(0);
    expect(REQUIRE_SIGNED).toBe(false);
    expect(checkSignedEntitlements({ signed: "garbage" }, { now })).toEqual({ status: "unsigned" });
  });

  test("accepts a good document", () => {
    const r = check(token());
    expect(r.status).toBe("verified");
    if (r.status === "verified") expect(r.claims).toMatchObject({ tier: "pro", ver: 5 });
  });

  test("rejects an edited payload, a wrong key, alg none, a wrong alg, and an unknown kid", () => {
    const good = token();
    const [h, , s] = good.split(".");
    expect(check(`${h}.${enc({ schema: 1, sub: "u1", tier: "enterprise", flags: {}, ver: 5, iat: 0, exp: nowSec + 600 })}.${s}`)).toMatchObject({ status: "rejected", reason: "bad signature" });
    expect(check(token({}, {}, generateKeyPairSync("ed25519").privateKey))).toMatchObject({ status: "rejected", reason: "bad signature" });
    expect(check(token({}, { alg: "none" }))).toMatchObject({ status: "rejected", reason: "unsupported algorithm" });
    expect(check(token({}, { alg: "HS256" }))).toMatchObject({ status: "rejected", reason: "unsupported algorithm" });
    expect(check(token({}, { kid: "other" }))).toMatchObject({ status: "rejected", reason: "unknown signing key" });
  });

  test("rejects an expired document and a rollback to an older version", () => {
    expect(check(token({ exp: nowSec - 1 }))).toMatchObject({ status: "rejected", reason: "expired" });
    expect(check(token({ ver: 4 }), { highestVersionSeen: 5 })).toMatchObject({ status: "rejected" });
    expect(check(token({ ver: 5 }), { highestVersionSeen: 5 }).status).toBe("verified");
  });

  test("rejects bad claims and malformed tokens", () => {
    expect(check(token({ tier: "gold" })).status).toBe("rejected");
    expect(check(token({ ver: -1 })).status).toBe("rejected");
    expect(check("a.b").status).toBe("rejected");
    expect(check("x".repeat(9000)).status).toBe("rejected");
  });

  test("with keys present and no document: unsigned unless signing is required", () => {
    expect(check(undefined)).toEqual({ status: "unsigned" });
    expect(check(undefined, { requireSigned: true })).toMatchObject({ status: "rejected" });
  });

  test("ignoreExpiry (cache re-check) accepts an expired document but still rejects a bad signature", () => {
    expect(check(token({ exp: nowSec - 100 }), { ignoreExpiry: true }).status).toBe("verified");
    const [h, p, s] = token().split(".");
    expect(check(`${h}.${enc({ schema: 1, sub: "u1", tier: "enterprise", flags: {}, ver: 5, iat: 0, exp: nowSec + 600 })}.${s}`, { ignoreExpiry: true }).status).toBe("rejected");
    expect(p).toBeTruthy();
  });
});
