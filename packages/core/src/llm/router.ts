// src/llm/router.ts
import { getBudgetSnapshot } from "./budget.js";
import { dataDrivenEnv } from "../platform/env.js";

export type ModelTier = "low" | "high";

export interface RoutingDecision {
  tier: ModelTier;
  reason: string;
}

export type RoutingCall =
  | "intent_refinement"     // Node 1
  | "change_classification" // Node 3b
  | "repair"                // Node 6 self-heal
  | "escalation"            // Section 4c
  | "greenfield_plan"       // Section 4a
  | "mention_extraction"    // IDEA-078: candidate mentions in a free-text intent
  | "diff_classification";  // Node 3b, diff mode

const DEFAULT_HIGH: RoutingCall[] = ["intent_refinement", "escalation"];
const LOW_BUDGET_DOWNGRADE_THRESHOLD = 0.15; // remaining fraction of ceiling

/**
 * AI-05: an operator can pin one call type to a tier with PURIX_TIER_<CALL>=low|high (for example PURIX_TIER_REPAIR=high),
 * so which tier repair or classification should run on can be measured instead of assumed. Anything else in the variable
 * is ignored. Names are data-driven (one per call type), so they are read through dataDrivenEnv.
 */
export function tierOverride(call: RoutingCall): ModelTier | undefined {
  const raw = dataDrivenEnv(`PURIX_TIER_${call.toUpperCase()}`)?.trim().toLowerCase();
  return raw === "low" || raw === "high" ? raw : undefined;
}

/**
 * Section 8 Could-have: Multi-Model Cost Router. Section 29's own build
 * guidance names exactly two calls that should default to the frontier
 * tier — Node 1 and Section 4c escalation. This is the single place
 * that decision lives now, instead of scattered hardcoded "high"/"low"
 * literals (which is exactly how refineIntent previously ended up on
 * the wrong tier by omitting the argument entirely).
 *
 * The "router" part: under real budget pressure it downgrades a
 * would-be "high" call to "low" rather than letting the NEXT call trip
 * budget.ts's hard ceiling outright — cheaper and slower to converge,
 * but keeps the pipeline moving. This only ever downgrades, never
 * upgrades past what the call type would otherwise get, and it always
 * says so out loud rather than silently substituting a smaller model.
 */
export function routeTier(call: RoutingCall, _opts: { attempt?: number } = {}): RoutingDecision {
  const pinned = tierOverride(call);
  const wantsHigh = pinned !== undefined ? pinned === "high" : DEFAULT_HIGH.includes(call);
  if (!wantsHigh) {
    if (pinned === "low") return { tier: "low", reason: `"${call}" pinned to the low tier by PURIX_TIER_${call.toUpperCase()}` };
    return { tier: "low", reason: `"${call}" is a small/bounded call per Section 3 — low tier by default` };
  }

  const snapshot = getBudgetSnapshot();
  if (snapshot && snapshot.ceiling > 0) {
    const remainingFraction = 1 - snapshot.totalSpentUsd / snapshot.ceiling;
    if (remainingFraction < LOW_BUDGET_DOWNGRADE_THRESHOLD) {
      return {
        tier: "low",
        reason:
          `"${call}" would normally use the high tier (Section 29), but only ` +
          `${(remainingFraction * 100).toFixed(0)}% of the cost ceiling remains — downgraded to low ` +
          `tier to stay under budget rather than risk tripping the guardrail mid-request`,
      };
    }
  }

  return {
    tier: "high",
    reason: pinned === "high"
      ? `"${call}" pinned to the high tier by PURIX_TIER_${call.toUpperCase()}`
      : `"${call}" is one of the two calls Section 29 recommends the frontier tier for`,
  };
}