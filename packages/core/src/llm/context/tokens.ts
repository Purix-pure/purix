// src/llm/context/tokens.ts
//
// Token ESTIMATION, not counting. No tokenizer is bundled (each provider uses
// its own, and Purix is BYOK across all of them), so budgets are enforced
// against a documented heuristic: ~4 characters per token for English prose is
// the commonly quoted rule of thumb, and source code tokenizes denser, so 3.5 is
// a mildly conservative choice (it over-estimates, i.e. packs come out smaller,
// never larger, than the budget says).
//
// It is a heuristic and is NOT yet calibrated against provider-reported usage
// (a tracked follow-up in ADR-059): treat budgets as approximate.
export const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / CHARS_PER_TOKEN);
}
