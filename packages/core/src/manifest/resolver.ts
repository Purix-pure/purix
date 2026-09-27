// packages/core/src/manifest/resolver.ts
//
// IDEA-078: deterministic target resolver for `purix change "<intent>"`.
// Design agreed in the 2026-09-24 handoff (§"Design agreed in principle"):
//   1. Read the target from the intent, deterministically, by matching
//      manifest IDs, file paths and indexed symbol names.
//   2. One strong match: proceed.
//   3. Zero or several matches: return ranked candidates and require a
//      pick — never silently guess for a write.
//   8. Candidate ranking is deterministic, not an LLM guess.
//
// Token extraction (the "what strings do we even try to match" step) is
// out of scope for this module by design — Decision 2 (resolved
// 2026-09-24) is LLM-ASSISTED EXTRACTION, DETERMINISTIC RANKING, mirroring
// gates/trustgate.ts's own shape (an LLM produces a signal;
// evaluateTrustGate(), a separate deterministic function, decides). This
// module is the "evaluateTrustGate()" half: given a list of candidate
// mention strings (however they were extracted — by an LLM, or just the
// intent's own words, callers may also pass the whole intent as one
// candidate), it does the actual matching and ranking against real
// manifest data, with zero LLM involvement and zero randomness.
//
// The single special manifest row `purix-codebase-index` (component_type:
// "codebase_index") holds every indexed symbol across the whole repo in
// its own `components: ComponentRecord[]` array — confirmed by direct
// read (handoff finding #3) to be an ordinary ManifestEntry, not a
// separate store. listManifest() therefore already surfaces everything
// this resolver needs: manifest IDs and file paths from every entry, and
// indexed symbol names from that one entry's `components` array.
import type { ManifestEntry } from "./schema.js";

export type ResolverMatchReason = "component_id" | "file_path" | "symbol_name";

export interface ResolverCandidate {
  componentId: string;
  reason: ResolverMatchReason;
  /** The specific matched string (an id, a file path, or a symbol name). */
  matchedOn: string;
  /** The candidate mention string from the intent that produced this match. */
  mention: string;
  /** Higher is a stronger match — see scoreMatch() below for the ordering. */
  score: number;
}

/** "single" = proceed automatically; "none" | "multiple" = ask the human/agent to pick. */
export type ResolverResult =
  | { outcome: "none" }
  | { outcome: "single"; target: ResolverCandidate }
  | { outcome: "multiple"; candidates: ResolverCandidate[] };

// Deliberately excluded from symbol/path matching — every ManifestEntry's
// own files list and the codebase-index row's own component_id would
// otherwise "match themselves" trivially for any intent that happens to
// mention the word "index" or "component".
const CODEBASE_INDEX_COMPONENT_ID = "purix-codebase-index";

/** Ranking order, matching reason: an exact component-ID mention is the
 * strongest possible signal (the user typed the literal ID), a file-path
 * match is next (still unambiguous — one file belongs to one component),
 * and a symbol-name match is weakest (a common function/class name could
 * plausibly appear in unrelated intent text). Ties within the same
 * reason are broken by how much of the mention string the match actually
 * covers (a full match beats a partial/substring one). */
const REASON_WEIGHT: Record<ResolverMatchReason, number> = {
  component_id: 300,
  file_path: 200,
  symbol_name: 100,
};

function scoreMatch(reason: ResolverMatchReason, mention: string, matchedOn: string): number {
  const coverage = matchedOn.length > 0 ? Math.min(mention.length, matchedOn.length) / matchedOn.length : 0;
  return REASON_WEIGHT[reason] + coverage * 10;
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Does `mention` refer to `candidateString`? Exact match, or mention
 * containing candidateString (or vice versa) as a whole path/id/symbol
 * segment — never a bare-substring match on unrelated text (e.g. mention
 * "fix" must not match a component id "prefix-scanner").
 */
function mentionMatches(mention: string, candidateString: string): boolean {
  const m = normalize(mention);
  const c = normalize(candidateString);
  if (m.length === 0 || c.length === 0) return false;
  if (m === c) return true;
  // File-path style containment: "store.ts" should match
  // "src/manifest/store.ts", and the reverse for a mention that already
  // includes a directory. Guard with a boundary check (/, start, or end)
  // so "store.ts" doesn't match "user-store.ts".
  const boundary = (hay: string, needle: string): boolean => {
    const idx = hay.indexOf(needle);
    if (idx === -1) return false;
    const before = idx === 0 || hay[idx - 1] === "/" || hay[idx - 1] === "-" || hay[idx - 1] === "_";
    const after = idx + needle.length === hay.length || hay[idx + needle.length] === "/";
    return before && after;
  };
  return boundary(c, m) || boundary(m, c);
}

/** Shortest symbol name worth matching on — below this, names like `id` or `get` collide with ordinary words. */
const MIN_SYMBOL_LENGTH = 4;

/**
 * Symbols are exact, case-sensitive identifiers, so they match by exact
 * equality only — no containment, no case folding. (2026-09-24: the first
 * version reused mentionMatches(), which lowercases and does boundary
 * containment; an English word in an intent could then resolve a write
 * target through an unrelated symbol of the same name.)
 */
function symbolMatches(mention: string, symbolName: string): boolean {
  return symbolName.length >= MIN_SYMBOL_LENGTH && mention.trim() === symbolName;
}

/** One human-readable line saying WHY a candidate was chosen ("Target: X (why)"). */
export function describeMatch(c: ResolverCandidate): string {
  switch (c.reason) {
    case "component_id":
      return `component id "${c.matchedOn}"`;
    case "file_path":
      return `file path "${c.matchedOn}"`;
    case "symbol_name":
      return `indexed symbol "${c.matchedOn}"`;
  }
}

export interface ResolveTargetInput {
  /** Candidate mention strings pulled from the user's intent (LLM-assisted
   * extraction happens upstream of this function — see file header). */
  mentions: string[];
  manifest: ManifestEntry[];
}

/**
 * Deterministically resolves one or more candidate mention strings
 * against real manifest data. No LLM calls, no randomness — same inputs
 * always produce the same ResolverResult.
 */
export function resolveTarget(input: ResolveTargetInput): ResolverResult {
  const { mentions, manifest } = input;
  const byComponent = new Map<string, ResolverCandidate>();

  const consider = (componentId: string, reason: ResolverMatchReason, matchedOn: string, mention: string) => {
    const score = scoreMatch(reason, mention, matchedOn);
    const existing = byComponent.get(componentId);
    if (!existing || score > existing.score) {
      byComponent.set(componentId, { componentId, reason, matchedOn, mention, score });
    }
  };

  for (const mention of mentions) {
    if (!mention || mention.trim().length === 0) continue;
    for (const entry of manifest) {
      if (entry.component_id === CODEBASE_INDEX_COMPONENT_ID) continue;

      // 1. component_id — strongest signal.
      if (mentionMatches(mention, entry.component_id)) {
        consider(entry.component_id, "component_id", entry.component_id, mention);
      }

      // 2. file paths this component owns.
      for (const path of entry.files ?? []) {
        if (mentionMatches(mention, path)) {
          consider(entry.component_id, "file_path", path, mention);
        }
      }
    }

    // 3. indexed symbol names, from the one codebase-index row's
    // `components` array (see file header — this is the second
    // resolution source, reached through the same listManifest() list).
    const indexEntry = manifest.find((e) => e.component_id === CODEBASE_INDEX_COMPONENT_ID);
    for (const record of indexEntry?.components ?? []) {
      if (symbolMatches(mention, record.symbol_name)) {
        // A symbol's file_location maps back to the owning component via
        // that component's own `files` list — a symbol with no owning
        // component in the manifest (already deleted, or the index is
        // stale) is not a usable target, so it's skipped rather than
        // resolved to nothing.
        const owner = manifest.find((e) => e.component_id !== CODEBASE_INDEX_COMPONENT_ID && (e.files ?? []).includes(record.file_location));
        if (owner) {
          consider(owner.component_id, "symbol_name", record.symbol_name, mention);
        }
      }
    }
  }

  // Score first; componentId as a total-order tiebreak so equal scores can
  // never depend on manifest row order (requirement 8: deterministic).
  const candidates = Array.from(byComponent.values()).sort(
    (a, b) => b.score - a.score || a.componentId.localeCompare(b.componentId)
  );
  if (candidates.length === 0) return { outcome: "none" };
  if (candidates.length === 1) return { outcome: "single", target: candidates[0]! };
  return { outcome: "multiple", candidates };
}