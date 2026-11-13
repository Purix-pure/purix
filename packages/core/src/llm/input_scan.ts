// packages/core/src/llm/input_scan.ts
//
// AI-12 (PURIX-33): the scan that every piece of repair input passes through before it reaches a prompt.
//
// Repair input is text that came from somewhere Purix does not control: compiler and test output (which quotes the code
// under test and any string in it), memory lines written in earlier sessions, and the ledger. A repair round runs with no
// person present, so unlike the escalation context scan there is nobody to ask. The answer to a hit is therefore different:
// the matched text is replaced with a placeholder, the run goes on, and the hit is recorded as an event so a person can see
// it afterwards. Zero-width and bidirectional-control characters are removed first, since they are what a phrase is split
// with to get past a plain match (injection.ts folds them too, but the repair prompt should not carry them at all).
//
// This is a tripwire, not a boundary, and says so: a phrase nobody listed still gets through. The boundary is the sandbox,
// the security gate and the confirmation step, none of which this module touches.
import { neutralizeInjectionAttempts, INJECTION_PLACEHOLDER } from "./injection.js";
import { recordEvent } from "../manifest/events.js";

/** Characters that draw as nothing or reorder text. Tabs, line feeds and ordinary spaces are kept. */
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export interface SanitizedInput {
  cleaned: string;
  /** One entry per distinct phrase that matched, as injection.ts reports it (folded, lower case). */
  hits: string[];
  /** How many hidden characters were removed. */
  strippedHidden: number;
}

/** Pure: strips hidden characters, then replaces instruction-like phrases with the shared placeholder. */
export function sanitizeRepairText(text: string): SanitizedInput {
  const stripped = text.replace(HIDDEN, "");
  const strippedHidden = text.length - stripped.length;
  const { cleaned, hits } = neutralizeInjectionAttempts(stripped, INJECTION_PLACEHOLDER);
  return { cleaned, hits, strippedHidden };
}

export type RepairInputSource = "failure" | "memory" | "ledger";
export type RepairInputStage = "self_heal" | "escalation" | "refine";

/** Longest slice of a matched phrase written to the event log. */
const HIT_LOG_CHARS = 80;
const MAX_HITS_LOGGED = 5;

/**
 * Sanitizes one piece of repair input and, when something was replaced or removed, records an `input_neutralized` event.
 * Recording is fire-and-forget (recordEvent never throws). Returns the cleaned text; the caller sends only that.
 */
export function sanitizeAndRecord(
  text: string,
  ctx: { componentId: string; operation: string; stage: RepairInputStage; source: RepairInputSource; attempt?: number }
): string {
  const r = sanitizeRepairText(text);
  if (r.hits.length > 0 || r.strippedHidden > 0) {
    recordEvent("input_neutralized", {
      component_id: ctx.componentId,
      operation: ctx.operation,
      detail: {
        stage: ctx.stage,
        source: ctx.source,
        ...(ctx.attempt !== undefined ? { attempt: ctx.attempt } : {}),
        hit_count: r.hits.length,
        hidden_characters_removed: r.strippedHidden,
        hits: r.hits.slice(0, MAX_HITS_LOGGED).map((h) => (h.length > HIT_LOG_CHARS ? `${h.slice(0, HIT_LOG_CHARS - 1)}…` : h)),
      },
    });
  }
  return r.cleaned;
}
