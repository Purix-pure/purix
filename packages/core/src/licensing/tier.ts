// packages/core/src/licensing/tier.ts
//
// Part 3/4/5: the local, offline-verifiable license-key scaffold this
// file used to be (`purix tier-set pro <key>` + an HMAC format check) is
// retired here — the whole point of Part 3's backend is "entitlements
// (server-verified tier, replacing the spoofable local JSON file)", and
// keeping the old local unlock alongside a server-verified one would
// just leave the spoofable path sitting there unused-but-present. Tier is
// now: logged out => Free, always; logged in => whatever the server's
// /entitlements says, cached locally with a TTL the server controls.
//
// IMPORTANT design note (not spelled out explicitly in the build prompt,
// so recorded here rather than silently decided): getEntitlements() and
// checkComponentLimit() are and must stay fully SYNCHRONOUS, reading only
// the local cache — never triggering a network call directly. That's
// because checkComponentLimit() runs inside store.ts's synchronous
// withTransaction() (Part 5's atomic check-and-reserve), and node:sqlite
// transaction callbacks can't be async without losing the atomicity
// guarantee. The actual network refresh lives in the separate async
// refreshEntitlements() below, called only from safe async call sites:
// right after `purix login` succeeds, and immediately after any command
// is rejected for insufficient tier (both per Part 4) — never from
// inside a manifest-write transaction.
import { ambientEnv, purixEnv } from "../platform/env.js";
import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "../platform/atomic_write.js";
import { languagesForTier } from "../language/tier_languages.js";
import { join } from "node:path";
import { apiClient, ApiUnreachableError } from "../security/api_client.js";
import { isLoggedIn } from "../security/session.js";
import { checkSignedEntitlements } from "./entitlement_signature.js";
import { purixDir } from "../platform/layout.js";

export type ProductTier = "free" | "pro" | "team" | "enterprise";

export interface Entitlements {
  tier: ProductTier;
  componentLimit: number | null; // null = unlimited
  auditExport: boolean;
  webhooks: boolean;
  mcpHardened: boolean;
  orgId: string | null;
  seatLimit: number | null;
  allowedLanguages: string[];
}

// Release 1 is local and open source with no way to pay, so the free tier has no component cap (2026-11-02).
// A limit the server sends in `flags.componentLimit` is still honoured; see checkComponentLimit().
const FREE: Entitlements = {
  tier: "free",
  componentLimit: null,
  auditExport: false,
  webhooks: false,
  mcpHardened: false,
  orgId: null,
  seatLimit: null,
  allowedLanguages: languagesForTier("free"),
};

// Every field below is enforced somewhere. Fields for features that do not exist yet (team roles,
// shared memory, org budgets, client-side MCP calling) were removed (D3/D4, 2026-10-14) rather than
// carried as always-false switches; add one back together with the code that enforces it.
const PRO: Entitlements = {
  tier: "pro",
  componentLimit: null,
  auditExport: true,
  webhooks: true,
  mcpHardened: false,
  orgId: null,
  seatLimit: null,
  // Derived from the language manifests (language/tier_languages.ts), never listed here by hand.
  // To change what Pro includes, change that language's manifest `tier`.
  allowedLanguages: languagesForTier("pro"),
};

const DEFAULT_CACHE_TTL_SECONDS = 15 * 60; // 15 min — overridden by whatever the server actually returns
const OFFLINE_GRACE_MS = 72 * 60 * 60 * 1000; // Part 4: serve stale cache up to 72h past its fetch

interface EntitlementsCache {
  entitlements: Entitlements;
  cachedAt: string; // ISO
  cacheTtlSeconds: number;
  /** Highest signed-document version seen; a lower one later is a rollback. */
  signedVersion?: number;
  /** The verified signed document, kept so the signature is re-checked on every cache read. */
  signed?: string;
}

function cachePath(baseDir: string): string {
  return join(purixDir(baseDir), "tier-config.json");
}

function readCache(baseDir: string): EntitlementsCache | null {
  try {
    const p = cachePath(baseDir);
    if (!existsSync(p)) return null;
    const data = JSON.parse(readFileSync(p, "utf8"));
    if (!data || typeof data !== "object" || !data.entitlements || !data.cachedAt) return null;
    return data as EntitlementsCache;
  } catch {
    return null;
  }
}

function writeCache(baseDir: string, cache: EntitlementsCache): void {
  writeJsonAtomic(cachePath(baseDir), cache);
}

/** `purix logout` calls this immediately — see the interaction note in refreshEntitlements()'s docstring. */
export function clearEntitlementsCache(baseDir: string = process.cwd()): void {
  writeCache(baseDir, { entitlements: FREE, cachedAt: new Date(0).toISOString(), cacheTtlSeconds: DEFAULT_CACHE_TTL_SECONDS });
}

/**
 * Synchronous, cache-only read. Never touches the network. This is what
 * requireEntitlement() and checkComponentLimit() call.
 *
 * Logic:
 *  - Not logged in => Free, always, no cache involved.
 *  - Logged in, cache fresh (within cacheTtlSeconds) => cached entitlements.
 *  - Logged in, cache stale but within the 72h offline-grace window =>
 *    still serve the stale cache. Entitlement gating protects revenue,
 *    not safety, so it doesn't need secrets-scan/cost-ceiling's fail-
 *    closed posture.
 *  - Logged in, cache stale AND past 72h (or no cache at all yet) =>
 *    fail closed to Free.
 */
// "capped" exists only so tests can exercise the limit path; it is reachable only when NODE_ENV is "test".
const TIERS: Record<string, Entitlements> = { free: FREE, pro: PRO, capped: { ...FREE, componentLimit: 25 } };

export function getEntitlements(baseDir: string = process.cwd()): Entitlements {
  // SECURITY: this override exists ONLY so the test suite can simulate
  // different tiers without a real server round-trip (see
  // registry.test.ts). It must never be reachable from a real,
  // published CLI invocation — gating on NODE_ENV === "test" means a
  // real end user running the published `purix` binary can never
  // trigger this path, because nothing in their environment sets
  // NODE_ENV to "test". Do NOT relax this check to "if set" again;
  // that was a live, unauthenticated free-tier bypass shipped inside
  // the open-source package (every gated capability — language
  // support, component limits — is enforced entirely client-side in
  // this same package, so this env var alone used to unlock paid
  // functionality with zero payment and zero server contact).
  if (ambientEnv("NODE_ENV") === "test") {
    const override = purixEnv("PURIX_DEV_TIER");
    if (override) {
      const t = TIERS[override.toLowerCase()];
      if (t) return t;
      throw new Error(`Invalid or not yet defined PURIX_DEV_TIER: "${override}"`);
    }
  }

  if (!isLoggedIn()) return FREE;

  const cache = readCache(baseDir);
  if (!cache) return FREE; // logged in but never successfully synced yet

  if (cache.signed) {
    // A hand-edited cache or a copied file must not outlive the signature check.
    const again = checkSignedEntitlements({ signed: cache.signed }, { ignoreExpiry: true });
    if (again.status === "rejected") return FREE;
    if (again.status === "verified" && again.claims.tier !== cache.entitlements.tier) return FREE;
  }

  const ageMs = Date.now() - new Date(cache.cachedAt).getTime();
  const ttlMs = cache.cacheTtlSeconds * 1000;
  if (ageMs <= ttlMs) return cache.entitlements; // fresh
  if (ageMs <= OFFLINE_GRACE_MS) return cache.entitlements; // stale but within grace
  return FREE; // past grace — fail closed, never a silent downgrade (caller prints the message)
}

/**
 * Whether the cache is currently past its TTL (needs a background
 * refresh) — exposed so cli.ts's preAction hook can decide whether to
 * call refreshEntitlements() opportunistically without every caller
 * re-deriving this from getEntitlements()'s internals.
 */
export function entitlementsCacheIsStale(baseDir: string = process.cwd()): boolean {
  const cache = readCache(baseDir);
  if (!cache) return true;
  const ageMs = Date.now() - new Date(cache.cachedAt).getTime();
  return ageMs > cache.cacheTtlSeconds * 1000;
}

export interface RefreshResult {
  entitlements: Entitlements;
  /** true if this call actually reached the server; false if it served/kept the existing cache because the API was unreachable. */
  refreshed: boolean;
  /** Set when a signed document was rejected and the client fell back to Free. Print it. */
  reason?: string;
}

/**
 * The ONLY function in this file that touches the network. Call sites,
 * per Part 4: immediately after `purix login` succeeds (forcing an
 * uncached refetch), and immediately after any command is rejected for
 * insufficient tier. Never call this from inside a manifest-write
 * transaction — see the design note at the top of this file.
 */
export async function refreshEntitlements(baseDir: string = process.cwd()): Promise<RefreshResult> {
  if (!isLoggedIn()) {
    return { entitlements: FREE, refreshed: false };
  }

  try {
    const raw = await apiClient.getEntitlements();
    const signature = checkSignedEntitlements(raw, { highestVersionSeen: readCache(baseDir)?.signedVersion ?? 0 });
    if (signature.status === "rejected") {
      clearEntitlementsCache(baseDir); // fail closed: the old cached tier must not keep working
      return { entitlements: FREE, refreshed: false, reason: `Entitlement document rejected (${signature.reason}); using the Free tier.` };
    }
    // A verified document, not the unsigned fields beside it, decides tier and flags.
    const response =
      signature.status === "verified" ? { ...raw, tier: signature.claims.tier, flags: signature.claims.flags as typeof raw.flags } : raw;
    const rbacFlag = Boolean(response.flags.rbac);
    const sharedRepoMemoryFlag = Boolean(response.flags.sharedRepoMemory);
    if (rbacFlag || sharedRepoMemoryFlag) {
      throw new Error("rbac and sharedRepoMemory entitlements require a cryptographic identity provider (Team tier not yet implemented) — refusing to enable.");
    }

    const entitlements: Entitlements = {
      tier: response.tier,
      componentLimit: (response.flags.componentLimit as number | null) ?? null,
      auditExport: Boolean(response.flags.auditExport),
      webhooks: Boolean(response.flags.webhooks),
      mcpHardened: Boolean(response.flags.mcpHardened),
      orgId: (response.flags.orgId as string | null) ?? null,
      seatLimit: (response.flags.seatLimit as number | null) ?? null,
      // SECURITY: the server's allowedLanguages is never trusted verbatim.
      // A stale flag, a premature "Rust is back" entitlement change, or a
      // server-side misconfiguration naming a language with no
      // client-side provider must not re-open the indexer's synthetic-ID
      // false-positive path (manifest/indexer.ts) — intersect with what's
      // actually registered client-side (getLanguageProvider()) so an
      // unsupported language can never be "entitled" here, fail-closed
      // rather than trusting an external input for a security-relevant
      // default.
      //
      // Dynamic import, not a static one: registry.ts imports
      // requireLanguage from this file, so a static top-level import here
      // would make this module's own evaluation part of that same cycle —
      // registry.ts's top-level `[typescriptProvider, pythonProvider]`
      // array would then run before this file (reached via
      // manifest/store.ts, which registry.ts's providers transitively
      // import) finishes initializing, a genuine TDZ failure, not a
      // theoretical one (confirmed by the test suite). Deferring the
      // import to call time, well after both modules' top-level code has
      // already run, avoids that entirely.
      allowedLanguages: await (async () => {
        const rawAllowedLanguages =
          (response.flags.allowedLanguages as unknown as string[]) ??
          languagesForTier(response.tier === "free" ? "free" : "pro");
        const { getLanguageProvider } = await import("../language/registry.js");
        return rawAllowedLanguages.filter((lang) => getLanguageProvider(lang) !== undefined);
      })(),
    };
    writeCache(baseDir, {
      entitlements,
      cachedAt: new Date().toISOString(),
      cacheTtlSeconds: response.cacheTtlSeconds || DEFAULT_CACHE_TTL_SECONDS,
      ...(signature.status === "verified" && raw.signed ? { signedVersion: signature.claims.ver, signed: raw.signed } : {}),
    });
    return { entitlements, refreshed: true };
  } catch (err) {
    if (err instanceof ApiUnreachableError) {
      // Offline — leave whatever's cached alone and let getEntitlements()'s
      // grace-window logic decide what to serve. Not an error the caller
      // needs to surface as a hard failure.
      return { entitlements: getEntitlements(baseDir), refreshed: false };
    }
    throw err; // a real rejection (401 etc.) — the caller should see this
  }
}

/** Throws with an actionable, non-shaming message if a gated feature isn't entitled. */
export function requireEntitlement(feature: keyof Omit<Entitlements, "tier" | "componentLimit" | "orgId" | "seatLimit" | "allowedLanguages">): void {
  const ent = getEntitlements();
  if (!ent[feature]) {
    throw new Error(
      `"${feature}" is a Pro feature. Current tier: ${ent.tier}. Run "purix login" to check your entitlements, or upgrade.`
    );
  }
}

/** List-membership gate — requireEntitlement()'s truthiness check is wrong for this field. */
export function requireLanguage(langId: string): void {
  const ent = getEntitlements();
  if (!ent.allowedLanguages.includes(langId)) {
    // Every shipped language is free (D-14), so a refusal here means the language is unknown or
    // its manifest did not load, never that it needs a paid plan.
    throw new Error(
      `"${langId}" is not available. Languages available here: ${ent.allowedLanguages.join(", ") || "none"}.`
    );
  }
}

/**
 * ADR-035: Local capacity enforcement is a footgun-prevention mechanism,
 * not a security boundary — the real backstop is server-side verification
 * at checkout and via webhook-driven entitlement grants (ADR-032).
 */
export function checkComponentLimit(currentCount: number): void {
  const ent = getEntitlements();
  if (ent.componentLimit !== null && currentCount >= ent.componentLimit) {
    throw new Error(
      `This account tracks up to ${ent.componentLimit} components (currently ${currentCount}). ` +
        `Run "purix tier" to see the plan this limit comes from.`
    );
  }
}