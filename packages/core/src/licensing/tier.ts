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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { apiClient, ApiUnreachableError } from "../security/api_client.js";
import { isLoggedIn } from "../security/session.js";

export type ProductTier = "free" | "pro" | "team" | "enterprise";

export interface Entitlements {
  tier: ProductTier;
  componentLimit: number | null; // null = unlimited
  auditExport: boolean;
  webhooks: boolean;
  orgBudgetAggregation: boolean; // typed now, unenforced until Team ships
  rbac: boolean; // typed now, unenforced until Team ships
  sharedRepoMemory: boolean; // typed now, unenforced until Team ships
  mcpToolCalling: boolean; // stays false, same precedent as mcp_gateway.ts today
  mcpHardened: boolean;
  orgId: string | null;
  seatLimit: number | null;
  allowedLanguages: string[];
}

const FREE: Entitlements = {
  tier: "free",
  componentLimit: 25,
  auditExport: false,
  webhooks: false,
  orgBudgetAggregation: false,
  rbac: false,
  sharedRepoMemory: false,
  mcpToolCalling: false,
  mcpHardened: false,
  orgId: null,
  seatLimit: null,
  allowedLanguages: ["typescript"],
};

// Fields Free/Pro actually enforce this pass. orgBudgetAggregation, rbac,
// and sharedRepoMemory are typed above so the shape only needs to widen
// once, but nothing in this codebase may read them in a gating
// if/requireEntitlement call yet — see the enforcement guard test next to
// this file, which asserts exactly that, the same discipline that's kept
// mcp_gateway.ts safely disconnected.
const PRO: Entitlements = {
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
  allowedLanguages: ["typescript", "python"], // Rust/Go/Ruby removed from beta scope — see BETA_SCOPE.md. Re-add here (and re-add their provider/pack files) if un-gated later.
};

const DEFAULT_CACHE_TTL_SECONDS = 15 * 60; // 15 min — overridden by whatever the server actually returns
const OFFLINE_GRACE_MS = 72 * 60 * 60 * 1000; // Part 4: serve stale cache up to 72h past its fetch

interface EntitlementsCache {
  entitlements: Entitlements;
  cachedAt: string; // ISO
  cacheTtlSeconds: number;
}

function cachePath(baseDir: string): string {
  return join(baseDir, ".purix", "tier-config.json");
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
  const dir = join(baseDir, ".purix");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(cachePath(baseDir), JSON.stringify(cache, null, 2));
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
const TIERS: Record<string, Entitlements> = { free: FREE, pro: PRO };

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
  if (process.env.NODE_ENV === "test") {
    const override = process.env.PURIX_DEV_TIER;
    if (override) {
      const t = TIERS[override.toLowerCase()];
      if (t) return t;
      throw new Error(`Invalid or not yet defined PURIX_DEV_TIER: "${override}"`);
    }
  }

  if (!isLoggedIn()) return FREE;

  const cache = readCache(baseDir);
  if (!cache) return FREE; // logged in but never successfully synced yet

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
    const response = await apiClient.getEntitlements();
    const rbacFlag = Boolean(response.flags.rbac);
    const sharedRepoMemoryFlag = Boolean(response.flags.sharedRepoMemory);
    if (rbacFlag || sharedRepoMemoryFlag) {
      throw new Error("rbac and sharedRepoMemory entitlements require a cryptographic identity provider (Team tier not yet implemented) — refusing to enable.");
    }

    const entitlements: Entitlements = {
      tier: response.tier,
      componentLimit: (response.flags.componentLimit as number | null) ?? (response.tier === "free" ? 25 : null),
      auditExport: Boolean(response.flags.auditExport),
      webhooks: Boolean(response.flags.webhooks),
      orgBudgetAggregation: Boolean(response.flags.orgBudgetAggregation),
      rbac: rbacFlag,
      sharedRepoMemory: sharedRepoMemoryFlag,
      mcpToolCalling: false, // stays false regardless of server response — see mcp_gateway.ts precedent
      mcpHardened: Boolean(response.flags.mcpHardened),
      orgId: (response.flags.orgId as string | null) ?? null,
      seatLimit: (response.flags.seatLimit as number | null) ?? null,
      allowedLanguages: (response.flags.allowedLanguages as unknown as string[]) ?? (response.tier === "free" ? ["typescript"] : ["typescript", "python"]),
    };
    writeCache(baseDir, {
      entitlements,
      cachedAt: new Date().toISOString(),
      cacheTtlSeconds: response.cacheTtlSeconds || DEFAULT_CACHE_TTL_SECONDS,
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
    throw new Error(
      `"${langId}" support is a Pro feature. Current tier: ${ent.tier}. ` +
      `Run "purix login" to check your entitlements, or upgrade.`
    );
  }
}

/**
 * ADR-040: Local capacity enforcement is a footgun-prevention mechanism,
 * not a security boundary — the real backstop is server-side verification
 * at checkout and via webhook-driven entitlement grants (ADR-017).
 */
export function checkComponentLimit(currentCount: number): void {
  const ent = getEntitlements();
  if (ent.componentLimit !== null && currentCount >= ent.componentLimit) {
    throw new Error(
      `Free tier tracks up to ${ent.componentLimit} components (currently ${currentCount}). ` +
        `Run "purix login" to upgrade to Pro and remove this limit.`
    );
  }
}