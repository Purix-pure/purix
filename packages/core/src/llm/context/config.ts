// src/llm/context/config.ts
//
// Tunable defaults for the context policy (ADR-059). IMPORTANT, stated plainly so
// nobody mistakes these for research-derived optima: no published study gives a
// correct token budget for "classify a small code edit". Anthropic's own
// guidance is "the smallest possible set of high-signal tokens" and describes
// degradation as a gradient with no fixed threshold. These numbers are
// conservative starting points, overridable per environment, and meant to be
// re-tuned from the "context_pack"/"context_usage" telemetry once real usage
// exists (STATUS.md's Phase 6 gate).
export interface ContextConfig {
  /** Master switch. false = exact legacy behaviour (all files, no extras, no restructuring). */
  enabled: boolean;
  /** At or below this many estimated tokens, a component's files are sent in full (today's behaviour). */
  fullMaxTokens: number;
  /** Above fullMaxTokens the file section is reduced to at most this many estimated tokens. */
  focusedMaxTokens: number;
  projectContextEnabled: boolean;
  projectContextMaxTokens: number;
}

export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  enabled: true,
  fullMaxTokens: 12_000,
  focusedMaxTokens: 6_000,
  projectContextEnabled: true,
  projectContextMaxTokens: 500,
};

function intFromEnv(v: string | undefined, fallback: number, min: number): number {
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

const isOff = (v: string | undefined) => v !== undefined && ["off", "0", "false", "no"].includes(v.trim().toLowerCase());

export function loadContextConfig(env: NodeJS.ProcessEnv = process.env): ContextConfig {
  const d = DEFAULT_CONTEXT_CONFIG;
  const fullMaxTokens = intFromEnv(env.PURIX_CONTEXT_FULL_MAX_TOKENS, d.fullMaxTokens, 500);
  const focused = intFromEnv(env.PURIX_CONTEXT_FOCUSED_MAX_TOKENS, d.focusedMaxTokens, 200);
  return {
    enabled: !isOff(env.PURIX_CONTEXT_PACK),
    fullMaxTokens,
    // A focused pack larger than the full threshold would be a contradiction.
    focusedMaxTokens: Math.min(focused, fullMaxTokens),
    projectContextEnabled: !isOff(env.PURIX_PROJECT_CONTEXT),
    projectContextMaxTokens: intFromEnv(env.PURIX_PROJECT_CONTEXT_MAX_TOKENS, d.projectContextMaxTokens, 0),
  };
}
