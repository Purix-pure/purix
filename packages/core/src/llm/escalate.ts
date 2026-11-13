// src/llm/escalate.ts
import { z } from "zod";
import { callJson, ChangeEditSchema } from "./classify.js";
import { routeTier } from "./router.js";
import { neutralizeInjectionAttempts } from "./injection.js";
import { escalatePrompt } from "./prompts/build.js";
import { loadContextConfig } from "./context/config.js";
import { buildRepairFilesBlock } from "./context/failure_windows.js";
import type { FailureLocation } from "../verify/failure_shape.js";

/** AI-12: what an escalation round adds beyond the failure text. With neither field, the prompt is as before for any component under the full-view threshold. */
export interface EscalationExtras {
  ledger?: string;
  locations?: FailureLocation[];
}

const EscalationVerdictSchema = z.object({
  edits: z.array(ChangeEditSchema),
  reasoning: z.string(),
  is_new_capability: z.boolean(),
  suspicious_injected_instruction: z.boolean(),
});
export type EscalationVerdict = z.infer<typeof EscalationVerdictSchema>;

function preFilterContent(content: string): { cleaned: string; matchCount: number } {
  // Replaces the matched text in the original (look-alike letters, invisible characters and split lines included).
  const { cleaned: neutralized, hits } = neutralizeInjectionAttempts(content);
  let cleaned = neutralized;
  if (hits.length > 0) {
    console.log(`[security] Escalation pre-filter matched ${hits.length} attempt(s) in category: injection_marker`);
  }
  // Also check invisible/zero-width Unicode or role reassignment
  const zeroWidthRe = /[\u200B-\u200D\uFEFF]/g;
  if (zeroWidthRe.test(cleaned)) {
    console.log(`[security] Escalation pre-filter matched zero-width Unicode characters.`);
    cleaned = cleaned.replace(zeroWidthRe, "");
  }
  return { cleaned, matchCount: hits.length };
}

export async function escalateJudgeAndRepair(
  componentId: string,
  operation: string,
  instruction: string,
  failingFiles: { path: string; content: string }[],
  neighborContext: { component_id: string; path: string; content: string }[],
  failureReason: string,
  attemptNumber: number,
  extras: EscalationExtras = {}
): Promise<EscalationVerdict> {
  // AI-12: a component over the full-view threshold is shown as windows around the failure; below it, this is the same
  // "--- path ---" join as always. Edits are still applied to the full files.
  const rawFailingBlock = buildRepairFilesBlock(failingFiles, extras.locations ?? [], loadContextConfig(), instruction).filesBlock;
  const rawNeighborBlock = neighborContext
    .map((f) => `--- [dependency context: ${f.component_id}] ${f.path} ---\n${f.content}`)
    .join("\n\n");

  const filteredFailing = preFilterContent(rawFailingBlock);
  const filteredNeighbor = preFilterContent(rawNeighborBlock);

  const prompt = escalatePrompt({
    componentId,
    operation,
    instruction,
    failureReason,
    attempt: attemptNumber,
    failingFiles: filteredFailing.cleaned,
    neighborFiles: filteredNeighbor.cleaned,
    ...(extras.ledger !== undefined ? { ledger: extras.ledger } : {}),
  });

  const decision = routeTier("escalation");
  if (decision.tier === "low") {
    console.log(`  [router] ${decision.reason}`);
  }
  return callJson(prompt, EscalationVerdictSchema, "escalation", "escalation", { tier: decision.tier, savingsContext: { call: "escalation", decision } });
}
