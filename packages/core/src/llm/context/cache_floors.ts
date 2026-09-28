// src/llm/context/cache_floors.ts
//
// Minimum cacheable prompt prefix per provider/model (ADR-057, as amended
// 2026-09-28). Why this exists: provider prompt caching FAILS SILENTLY below a
// per-model minimum — Anthropic's docs state a shorter prefix "will be processed
// without caching, and no error is returned" — and the cheap tiers have the
// HIGHEST floors. Restructuring a prompt for caching when its shared prefix is
// under the floor buys nothing, so restructuring is gated on this table.
//
// Sources (primary docs, read 2026-09-28):
//   Anthropic  platform.claude.com/docs/en/build-with-claude/prompt-caching
//              Haiku 4.5 = 4,096; Sonnet 5 / 4.6 / 4.5 = 1,024; Opus 4.5/4.6 = 4,096
//   OpenAI     developers.openai.com/api/docs/guides/prompt-caching  (>= 1,024, automatic)
//   Gemini     ai.google.dev/gemini-api/docs/caching  (3.5 / 3.6 / 3.7 / 3.8 Flash = 4,096)
// Floors change between model versions. Anything not positively recognised returns
// null ("unknown"), and unknown means DON'T restructure — the safe direction.
import type { ModelTier } from "../providers.js";

export function cacheFloorTokens(providerId: string, model: string): number | null {
  const m = model.toLowerCase();
  switch (providerId) {
    case "anthropic":
      if (/haiku-4-5|opus-4-[56]/.test(m)) return 4096;
      if (/sonnet-(5|4-[56]|4)\b/.test(m)) return 1024;
      return null;
    case "openai":
      return /^(gpt-|o\d)/.test(m) ? 1024 : null;
    case "gemini":
      return /gemini-3(\.\d+)?-(flash|pro)\b/.test(m) && !/lite/.test(m) ? 4096 : null;
    default:
      return null;
  }
}

export type { ModelTier };
