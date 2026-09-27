// packages/core/src/manifest/mentions.ts
//
// IDEA-078: deterministic mention extraction for `purix change "<intent>"`.
//
// resolveTarget() (resolver.ts) matches candidate strings against real
// manifest data. This module produces those candidate strings from free
// text WITHOUT any LLM call, so the common case costs nothing and is
// fully reproducible. (The handoff floated passing the raw intent as one
// mention; that cannot work — resolver.ts's boundary check treats a space
// as a non-boundary, so "modify the billing-service to add X" never
// matches "billing-service". Tokenizing is required.)
//
// Also here: the guard for the LLM-assisted tier (Decision 2). The LLM may
// only PROPOSE strings; filterVerbatimMentions() keeps a proposal only if
// it literally occurs in the intent, so a model can never introduce a
// target the user did not actually write.

/** Upper bounds — an intent is untrusted input; never let it fan out unboundedly. */
export const MAX_INTENT_LENGTH = 2000;
export const MAX_MENTIONS = 60;
export const MAX_MENTION_LENGTH = 200;

// Words that carry no target information. Deliberately conservative:
// only function words, generic change verbs, and generic path noise.
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "not", "no", "so", "if", "of", "to", "in", "on", "at", "by",
  "for", "with", "from", "into", "onto", "over", "as", "is", "are", "be", "it", "its", "this", "that",
  "these", "those", "than", "then", "when", "while", "also", "all", "any", "some", "each", "every",
  "should", "would", "could", "can", "will", "must", "need", "needs", "want", "wants", "please",
  "add", "fix", "update", "change", "changes", "modify", "make", "remove", "delete", "refactor",
  "improve", "implement", "create", "use", "using", "support", "handle", "ensure", "allow", "let",
  "file", "files", "code", "function", "functions", "class", "method", "logic", "thing", "stuff",
  // generic path segments that would match half the repo
  "src", "lib", "dist", "packages", "test", "tests", "index", "main",
]);

function stripToken(raw: string): string {
  let t = raw.trim();
  // Surrounding quotes/brackets/backticks and sentence punctuation.
  t = t.replace(/^[\s"'`([{<]+/, "").replace(/[\s"'`)\]}>,;:!?]+$/, "");
  // A sentence-final period, but never the dot inside "store.ts".
  t = t.replace(/\.+$/, "");
  // "src/a.ts:42" or "src/a.ts:42:7" → "src/a.ts"
  t = t.replace(/^(.*\.[A-Za-z0-9]+):\d+(?::\d+)?$/, "$1");
  return t;
}

function isWordToken(t: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]*$/.test(t);
}

/**
 * Deterministic candidate mentions from free text: every id-, path- or
 * identifier-shaped token, plus 2- and 3-word joins ("billing service" →
 * "billing-service") so a spaced phrase can still hit a kebab-case id.
 * Stable order (first occurrence), de-duplicated case-insensitively.
 */
export function extractMentions(intent: string): string[] {
  const text = intent.slice(0, MAX_INTENT_LENGTH).trim();
  if (text.length === 0) return [];

  const tokens = text
    .split(/\s+/)
    .map(stripToken)
    .filter((t) => t.length >= 2 && /[A-Za-z0-9]/.test(t));

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (m: string): void => {
    if (m.length < 2 || m.length > MAX_MENTION_LENGTH) return;
    const key = m.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(m);
  };

  for (const t of tokens) {
    if (STOPWORDS.has(t.toLowerCase())) continue;
    push(t);
  }

  // n-gram joins over plain words; skip a gram that starts or ends on a stopword.
  for (const n of [2, 3]) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const gram = tokens.slice(i, i + n);
      if (!gram.every(isWordToken)) continue;
      if (STOPWORDS.has(gram[0]!.toLowerCase()) || STOPWORDS.has(gram[n - 1]!.toLowerCase())) continue;
      push(gram.join("-"));
    }
  }

  return out.slice(0, MAX_MENTIONS);
}

const canon = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Decision-2 guard for LLM-proposed mentions: keep a proposal only if its
 * canonical form (lowercased, punctuation collapsed to single spaces)
 * appears as whole words inside the canonical intent. Each accepted
 * proposal is returned as-written plus a kebab-case variant, so
 * "billing service" can meet the id "billing-service". Anything that is
 * not a string, is empty, or is over-long is dropped.
 */
export function filterVerbatimMentions(intent: string, proposed: unknown): string[] {
  if (!Array.isArray(proposed)) return [];
  const haystack = ` ${canon(intent.slice(0, MAX_INTENT_LENGTH))} `;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of proposed) {
    if (typeof p !== "string") continue;
    const m = p.trim();
    if (m.length < 2 || m.length > MAX_MENTION_LENGTH) continue;
    const c = canon(m);
    if (c.length === 0 || !haystack.includes(` ${c} `)) continue;
    for (const variant of [m, c.replace(/ /g, "-")]) {
      const key = variant.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(variant);
      }
    }
    if (out.length >= MAX_MENTIONS) break;
  }
  return out.slice(0, MAX_MENTIONS);
}

/**
 * Deterministic kebab-case component name seed for `change`'s
 * create-proposal branch (no match found). classifyGreenfield() still
 * chooses the final component_id; this only gives it a stable starting
 * name and lets the CLI/MCP fail early on an obvious collision.
 */
export function deriveComponentName(intent: string): string {
  const words = intent
    .slice(0, MAX_INTENT_LENGTH)
    .split(/\s+/)
    .map((w) => w.toLowerCase().replace(/[^a-z0-9]+/g, ""))
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
  const name = words.slice(0, 4).join("-").slice(0, 40).replace(/-+$/, "");
  return name.length >= 2 ? name : "new-component";
}