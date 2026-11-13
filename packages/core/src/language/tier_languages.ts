// packages/core/src/language/tier_languages.ts
//
// PURIX-17 P2-D: "which languages may a tier use" is answered in ONE place, from the language
// manifests (language/manifests/*.json, field `tier`). licensing/tier.ts used to carry its own
// hard-coded lists (["typescript"] and ["typescript","python"]) next to LanguagePack.tier, so a
// language could be "pro" in one place and "free" in the other without anything failing.
//
// Rule: a tier may use every language whose manifest tier is at or below it in the order
// free < pro < team < enterprise. A manifest that fails to parse is not discovered (see
// discovery.ts), so a broken manifest means that language is not entitled: fail closed.
import { discoverLanguages, type DiscoveredLanguage } from "./discovery.js";

export type LanguageTier = "free" | "pro" | "team" | "enterprise";

const TIER_RANK: Record<LanguageTier, number> = { free: 0, pro: 1, team: 2, enterprise: 3 };

export function languagesForTier(tier: LanguageTier, discovered: DiscoveredLanguage[] = discoverLanguages()): string[] {
  return discovered
    .filter((d) => TIER_RANK[d.manifest.tier] <= TIER_RANK[tier])
    .map((d) => d.manifest.id)
    .sort((a, b) => (a === "typescript" ? -1 : b === "typescript" ? 1 : a.localeCompare(b)));
}
