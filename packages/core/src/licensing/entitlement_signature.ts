// packages/core/src/licensing/entitlement_signature.ts
//
// Verifies a signed entitlement document (Purix 4 sections 4 and 7): a compact
// JWS with alg EdDSA (Ed25519, RFC 8037), a `kid` header that selects the
// trusted key, and a payload with a monotonic `ver` and an `exp`. The
// algorithm is pinned: "none" and anything but EdDSA are rejected before the
// signature is looked at. A lower `ver` than the highest seen is a rollback
// and is rejected. Honest limit: the client is open source, so this stops
// casual edits and copied cache files, not a patched client.
//
// DORMANT until keys exist: TRUSTED_ENTITLEMENT_KEYS is empty, so a response
// is treated as unsigned (legacy behaviour). The moment the first public key
// is added here, signed documents are verified. REQUIRE_SIGNED stays false so
// a server that has not shipped signing yet does not push everyone to Free.
import { createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";

/** kid -> raw 32-byte Ed25519 public key, base64url. Add the primary and a reserved second key here. */
export const TRUSTED_ENTITLEMENT_KEYS: Record<string, string> = {};
export const REQUIRE_SIGNED = false;

const TIERS = ["free", "pro", "team", "enterprise"] as const;
type Tier = (typeof TIERS)[number];
export type Flags = Record<string, boolean | number | string | null | string[]>;

export interface EntitlementClaims {
  schema: 1;
  sub: string;
  tier: Tier;
  flags: Flags;
  ver: number;
  iat: number;
  exp: number;
}

export type SignatureCheck =
  | { status: "unsigned" }
  | { status: "verified"; claims: EntitlementClaims }
  | { status: "rejected"; reason: string };

const b64u = (s: string): Buffer => Buffer.from(s, "base64url");

function publicKeyFromRaw(raw: string): KeyObject {
  // SPKI prefix for an Ed25519 public key, followed by the 32 raw bytes.
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), b64u(raw)]);
  return createPublicKey({ key: spki, format: "der", type: "spki" });
}

export interface CheckOptions {
  keys?: Record<string, string>;
  now?: Date;
  highestVersionSeen?: number;
  requireSigned?: boolean;
  /** Re-checking a stored document on cache read: the signature and claims must hold, expiry is ignored (offline grace applies). */
  ignoreExpiry?: boolean;
}

export function checkSignedEntitlements(response: { signed?: string }, opts: CheckOptions = {}): SignatureCheck {
  const keys = opts.keys ?? TRUSTED_ENTITLEMENT_KEYS;
  const requireSigned = opts.requireSigned ?? REQUIRE_SIGNED;
  const token = response.signed;
  if (Object.keys(keys).length === 0) return { status: "unsigned" }; // dormant: no trusted key shipped yet
  if (typeof token !== "string" || token === "") {
    return requireSigned ? { status: "rejected", reason: "the server sent no signed document" } : { status: "unsigned" };
  }
  const parts = token.split(".");
  if (parts.length !== 3 || token.length > 8192) return { status: "rejected", reason: "malformed document" };
  try {
    const header = JSON.parse(b64u(parts[0]!).toString("utf8")) as { alg?: unknown; kid?: unknown };
    if (header.alg !== "EdDSA") return { status: "rejected", reason: "unsupported algorithm" };
    if (typeof header.kid !== "string" || !Object.hasOwn(keys, header.kid)) return { status: "rejected", reason: "unknown signing key" };
    const ok = cryptoVerify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKeyFromRaw(keys[header.kid]!), b64u(parts[2]!));
    if (!ok) return { status: "rejected", reason: "bad signature" };

    const c = JSON.parse(b64u(parts[1]!).toString("utf8")) as Partial<EntitlementClaims>;
    const nowSec = Math.floor((opts.now ?? new Date()).getTime() / 1000);
    if (c.schema !== 1 || typeof c.sub !== "string" || !TIERS.includes(c.tier as Tier)) return { status: "rejected", reason: "bad claims" };
    if (typeof c.flags !== "object" || c.flags === null || Array.isArray(c.flags)) return { status: "rejected", reason: "bad claims" };
    if (!Number.isInteger(c.ver) || (c.ver as number) < 0 || !Number.isInteger(c.iat) || !Number.isInteger(c.exp)) return { status: "rejected", reason: "bad claims" };
    if (!opts.ignoreExpiry && (c.exp as number) <= nowSec) return { status: "rejected", reason: "expired" };
    if ((c.ver as number) < (opts.highestVersionSeen ?? 0)) return { status: "rejected", reason: "older than a document already seen (rollback)" };
    return { status: "verified", claims: c as EntitlementClaims };
  } catch {
    return { status: "rejected", reason: "malformed document" };
  }
}
