// packages/core/src/manifest/change_target.ts
//
// IDEA-078: the ONE place `purix change` (CLI) and `purix_change` (MCP)
// decide which component an intent refers to, so the two surfaces cannot
// drift apart.
//
// Order: (0) explicit componentId override — no resolution at all;
// (1) deterministic extraction + resolveTarget() — zero LLM cost;
// (2) only if (1) found nothing, an optional LLM-assisted extractor whose
//     output is restricted to strings that literally occur in the intent
//     (filterVerbatimMentions) and then resolved by the same deterministic
//     resolver. The LLM never picks a target; it can only add spellings.
import type { ManifestEntry } from "./schema.js";
import { resolveTarget, type ResolverCandidate } from "./resolver.js";
import { extractMentions, filterVerbatimMentions } from "./mentions.js";

const CODEBASE_INDEX_COMPONENT_ID = "purix-codebase-index";

export type ChangeTargetSource = "override" | "deterministic" | "llm";

export type ChangeTarget =
  | { outcome: "single"; target: ResolverCandidate; source: ChangeTargetSource }
  | { outcome: "multiple"; candidates: ResolverCandidate[]; source: ChangeTargetSource }
  | { outcome: "none" };

export interface ResolveChangeTargetInput {
  intent: string;
  manifest: ManifestEntry[];
  /** Explicit `--component <id>` / MCP `componentId`: skips resolution entirely. */
  componentId?: string;
  /** Optional LLM tier; called only when deterministic resolution finds nothing. */
  extractWithLlm?: (intent: string) => Promise<string[]>;
}

export async function resolveChangeTarget(input: ResolveChangeTargetInput): Promise<ChangeTarget> {
  const { intent, manifest, componentId, extractWithLlm } = input;

  if (componentId !== undefined) {
    const found = manifest.find((e) => e.component_id === componentId && e.component_id !== CODEBASE_INDEX_COMPONENT_ID);
    if (!found) {
      throw new Error(`No manifest entry for "${componentId}". Check the id, or omit --component to let Purix resolve the target from the intent.`);
    }
    return {
      outcome: "single",
      source: "override",
      target: { componentId, reason: "component_id", matchedOn: componentId, mention: componentId, score: 1000 },
    };
  }

  const first = resolveTarget({ mentions: extractMentions(intent), manifest });
  if (first.outcome === "single") return { outcome: "single", target: first.target, source: "deterministic" };
  if (first.outcome === "multiple") return { outcome: "multiple", candidates: first.candidates, source: "deterministic" };

  if (!extractWithLlm) return { outcome: "none" };

  let proposed: string[];
  try {
    proposed = await extractWithLlm(intent);
  } catch (err) {
    // Fail closed: an LLM outage must not read as "no such component" and
    // turn into a proposal to create a duplicate.
    throw new Error(
      `No component matched the intent, and the LLM-assisted matching step failed (${err instanceof Error ? err.message : String(err)}). ` +
        `Nothing was changed. Retry, or name the component with --component <id>.`,
      { cause: err }
    );
  }
  const second = resolveTarget({ mentions: filterVerbatimMentions(intent, proposed), manifest });
  if (second.outcome === "single") return { outcome: "single", target: second.target, source: "llm" };
  if (second.outcome === "multiple") return { outcome: "multiple", candidates: second.candidates, source: "llm" };
  return { outcome: "none" };
}