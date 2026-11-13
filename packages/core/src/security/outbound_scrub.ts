// src/security/outbound_scrub.ts
//
// A7-1 (research 03, D11): everything that leaves for a model provider, and everything that comes back, passes through here.
// It uses the same secret definitions as the write gate plus the scrub-only list (security/secrets.ts), so there is one place
// that says what a secret looks like. The one caller is callLlm (llm/classify.ts, the single call point of ADR-061).
//
// What it promises: text that matches a KNOWN secret format is replaced by "[REDACTED:<kind>]" before it goes out. What it does
// not promise: a secret in a format the list does not know, or one that is split or encoded, still goes out. The wording rule
// for this feature is "known secret formats are scrubbed", never "secrets never leave the machine".
//
// Side effect to know about: the model sees the redacted text, so an edit it proposes whose `old_text` covers a redacted
// span will not match the real file. That edit fails to apply and nothing is written, which is the safe outcome.
import { scrubSecrets } from "./secrets.js";

/** The two-part prompt shape callLlm accepts. Declared here, not imported, so security/ does not depend on llm/. */
export interface OutboundPromptPair {
  system: string;
  user: string;
}

export interface ScrubbedText {
  text: string;
  count: number;
}

/** Redacts known secret formats from one string. Returns the same string, untouched, when nothing matched. */
export function scrubOutboundText(text: string): ScrubbedText {
  if (text.length === 0) return { text, count: 0 };
  const [result] = scrubSecrets([{ path: "(outbound)", content: text }]);
  if (!result || result.scrubbedCount === 0) return { text, count: 0 };
  return { text: result.content, count: result.scrubbedCount };
}

/** Scrubs a prompt of either shape. When nothing matched, the very same prompt object comes back. */
export function scrubOutboundPrompt(prompt: string): { prompt: string; count: number };
export function scrubOutboundPrompt(prompt: OutboundPromptPair): { prompt: OutboundPromptPair; count: number };
export function scrubOutboundPrompt(prompt: string | OutboundPromptPair): { prompt: string | OutboundPromptPair; count: number };
export function scrubOutboundPrompt(prompt: string | OutboundPromptPair): { prompt: string | OutboundPromptPair; count: number } {
  if (typeof prompt === "string") {
    const r = scrubOutboundText(prompt);
    return { prompt: r.count === 0 ? prompt : r.text, count: r.count };
  }
  const system = scrubOutboundText(prompt.system);
  const user = scrubOutboundText(prompt.user);
  const count = system.count + user.count;
  if (count === 0) return { prompt, count: 0 };
  return { prompt: { ...prompt, system: system.text, user: user.text }, count };
}
