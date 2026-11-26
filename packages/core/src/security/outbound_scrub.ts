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
  /** Format name -> how many were redacted ("high-entropy", "Private key block", ...). Names only, never a value. Empty when nothing matched. */
  formats: Record<string, number>;
}

const MARKER_RE = /\[REDACTED:([^\]\r\n]{1,60})\]/g;

function markerCounts(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of text.matchAll(MARKER_RE)) out.set(m[1]!, (out.get(m[1]!) ?? 0) + 1);
  return out;
}

/** The formats a scrub added: markers in the result minus markers already in the input (text that arrives already redacted adds none). */
function addedFormats(before: string, after: string): Record<string, number> {
  const was = markerCounts(before);
  const formats: Record<string, number> = {};
  for (const [name, n] of markerCounts(after)) {
    const added = n - (was.get(name) ?? 0);
    if (added > 0) formats[name] = added;
  }
  return formats;
}

/** Adds two format tallies. */
export function mergeFormats(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
}

/** Redacts known secret formats from one string. Returns the same string, untouched, when nothing matched. */
export function scrubOutboundText(text: string): ScrubbedText {
  if (text.length === 0) return { text, count: 0, formats: {} };
  const [result] = scrubSecrets([{ path: "(outbound)", content: text }]);
  if (!result || result.scrubbedCount === 0) return { text, count: 0, formats: {} };
  return { text: result.content, count: result.scrubbedCount, formats: addedFormats(text, result.content) };
}

/** Scrubs a prompt of either shape. When nothing matched, the very same prompt object comes back. */
export function scrubOutboundPrompt(prompt: string): { prompt: string; count: number; formats: Record<string, number> };
export function scrubOutboundPrompt(prompt: OutboundPromptPair): { prompt: OutboundPromptPair; count: number; formats: Record<string, number> };
export function scrubOutboundPrompt(prompt: string | OutboundPromptPair): { prompt: string | OutboundPromptPair; count: number; formats: Record<string, number> };
export function scrubOutboundPrompt(prompt: string | OutboundPromptPair): { prompt: string | OutboundPromptPair; count: number; formats: Record<string, number> } {
  if (typeof prompt === "string") {
    const r = scrubOutboundText(prompt);
    return { prompt: r.count === 0 ? prompt : r.text, count: r.count, formats: r.formats };
  }
  const system = scrubOutboundText(prompt.system);
  const user = scrubOutboundText(prompt.user);
  const count = system.count + user.count;
  if (count === 0) return { prompt, count: 0, formats: {} };
  return { prompt: { ...prompt, system: system.text, user: user.text }, count, formats: mergeFormats(system.formats, user.formats) };
}
