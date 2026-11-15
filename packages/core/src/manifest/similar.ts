// packages/core/src/manifest/similar.ts
//
// P7 (first slice): before a request becomes a NEW component, say which existing components it resembles. Exact matching (resolver.ts) only
// finds a component the request names; "add retry to the api client" names none, so it used to go straight to create even when
// `api-client` exists. This is deterministic word overlap on component ids and file names. It only SUGGESTS: nothing is chosen for
// the person or the agent, and no model is called.
import type { ManifestEntry } from "./schema.js";
import { CODEBASE_INDEX_COMPONENT_ID } from "./adopt.js";

export interface SimilarComponent {
  componentId: string;
  score: number;
  /** The shared words, for the person to judge the match by. */
  why: string;
}

const STOP = new Set(["the", "and", "for", "with", "into", "from", "that", "this", "add", "make", "new", "use", "get", "set", "all", "any", "when", "should", "need", "needs", "want", "please", "create", "build", "implement", "write", "update", "change", "fix"]);

// Ranking is BM25 (Okapi, k1 = 1.2, b = 0.75) over one small document per component: its id (counted three times, the strongest signal), its file
// names and folders, and the purpose notes recorded for it (the line `create` writes). Why BM25: docs/research/PURIX-RESEARCH-05 task 5 measured it
// over path and symbol words on about 1,500 real commit subjects from six public repositories (correct file in the top five for 46% to 61%), and
// SWE-bench and CodeRAG-Bench use it as their retrieval baseline. It is a lexical net, not a decision: the result is shown, never acted on.
const K1 = 1.2;
const B = 0.75;
const ID_WEIGHT = 3;

function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map((w) => (w.length > 4 && w.endsWith("ies") ? w.slice(0, -3) + "y" : w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w)); // boards -> board, entries -> entry
}

function pathWords(file: string): string[] {
  return words(file.replace(/\.[^./\\]+$/, "").replace(/[\\/]+/g, " "));
}

interface Doc { componentId: string; idWords: Set<string>; terms: Map<string, number>; length: number; }

function buildDoc(e: ManifestEntry, note: string | undefined): Doc {
  const idWords = new Set(words(e.component_id));
  const terms = new Map<string, number>();
  const add = (w: string, n: number): void => void terms.set(w, (terms.get(w) ?? 0) + n);
  for (const w of words(e.component_id)) add(w, ID_WEIGHT);
  for (const f of e.files) for (const w of pathWords(f)) add(w, 1);
  if (note) for (const w of words(note)) add(w, 1);
  let length = 0;
  for (const n of terms.values()) length += n;
  return { componentId: e.component_id, idWords, terms, length };
}

/**
 * Existing components a request resembles, best first. `notes` maps a component id to its recorded purpose text (optional).
 * A component is listed only if the request shares a word with its id, or at least two different words with its files and notes:
 * one stray file-name word is not worth interrupting a person for.
 */
export function findSimilarComponents(intent: string, manifest: ManifestEntry[], max = 3, notes: Record<string, string> = {}): SimilarComponent[] {
  const wanted = [...new Set(words(intent))];
  if (wanted.length === 0) return [];
  const docs = manifest
    .filter((e) => e.component_id !== CODEBASE_INDEX_COMPONENT_ID && e.component_type !== "codebase_index")
    .map((e) => buildDoc(e, notes[e.component_id]));
  if (docs.length === 0) return [];
  const avgLen = docs.reduce((a, d) => a + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const w of d.terms.keys()) df.set(w, (df.get(w) ?? 0) + 1);

  const found: SimilarComponent[] = [];
  for (const d of docs) {
    let score = 0;
    const shared: string[] = [];
    for (const w of wanted) {
      const tf = d.terms.get(w);
      if (!tf) continue;
      shared.push(w);
      const n = df.get(w) ?? 0;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * d.length) / avgLen)));
    }
    const idHit = shared.some((w) => d.idWords.has(w));
    if (idHit || shared.length >= 2) found.push({ componentId: d.componentId, score: Math.round(score * 1000) / 1000, why: `shares ${shared.map((w) => `"${w}"`).join(", ")}` });
  }
  return found.sort((a, b) => b.score - a.score || a.componentId.localeCompare(b.componentId)).slice(0, max);
}

/** One line for the person or agent, or "" when nothing resembles the request. */
export function similarComponentsNote(similar: SimilarComponent[]): string {
  if (similar.length === 0) return "";
  const list = similar.map((s) => `${s.componentId} (${s.why})`).join("; ");
  return `Similar existing component(s): ${list}. If one of these is what you mean, change it instead of creating a duplicate.`;
}
