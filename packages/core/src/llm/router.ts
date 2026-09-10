// src/llm/router.ts
import { getBudgetSnapshot } from "./budget.js";

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
  | "greenfield_plan";      // Section 4a

const DEFAULT_HIGH: RoutingCall[] = ["intent_refinement", "escalation"];
const LOW_BUDGET_DOWNGRADE_THRESHOLD = 0.15; // remaining fraction of ceiling

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
  if (!DEFAULT_HIGH.includes(call)) {
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

  return { tier: "high", reason: `"${call}" is one of the two calls Section 29 recommends the frontier tier for` };
}