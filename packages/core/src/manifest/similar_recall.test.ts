// P7: does BM25 find the right existing component more often than the word-overlap it replaced? A small fixed set, written by hand.
// Limits, stated plainly: the set is synthetic (not commit subjects), written by the same author as the code, and small. It shows the
// change does not lose recall on cases the old rule handled and gains on ones it missed; it is not a recall figure for real projects.
import { describe, test } from "node:test";
import { expect } from "expect";
import { findSimilarComponents } from "./similar.js";
import type { ManifestEntry } from "./schema.js";

const comp = (id: string, files: string[]): ManifestEntry => ({
  component_id: id, component_type: "module", current_version: 1, schema_version: 4, parts: { tools: [], config: {} },
  files, depends_on: [], depended_on_by: [], version_history: [], verification_status: "pass", last_synced_hash: null,
});
const M = [
  comp("api-client", ["src/net/http_client.ts"]),
  comp("payment-gateway", ["src/billing/stripe_adapter.ts"]),
  comp("team-board", ["src/ui/Board.tsx"]),
  comp("auth-session", ["src/auth/session_store.ts", "src/auth/login.ts"]),
  comp("email-notifier", ["src/notify/mailer.ts"]),
  comp("report-export", ["src/reports/pdf_writer.ts", "src/reports/csv_writer.ts"]),
  comp("search-index", ["src/search/tokenizer.ts"]),
  comp("rate-limiter", ["src/middleware/throttle.ts"]),
];
const NOTES: Record<string, string> = {
  "email-notifier": "sends password reset and welcome emails (files: src/notify/mailer.ts)",
  "rate-limiter": "limits requests per user per minute (files: src/middleware/throttle.ts)",
  "search-index": "full text search over tasks (files: src/search/tokenizer.ts)",
};
// [intent, expected component id, uses a recorded note]
const CASES: [string, string, boolean][] = [
  ["add retry to the api client", "api-client", false],
  ["payments should support refunds", "payment-gateway", false],
  ["a board for teams needs drag and drop", "team-board", false],
  ["session timeout after 30 minutes of login inactivity", "auth-session", false],
  ["export reports as pdf", "report-export", false],
  ["add csv column selection to report writer", "report-export", false],
  ["tokenizer should handle accents", "search-index", false],
  ["http client should follow redirects", "api-client", false],
  ["send a welcome email after signup", "email-notifier", true],
  ["limit requests per minute for each user", "rate-limiter", true],
  ["full text search should rank recent tasks first", "search-index", true],
  ["stripe webhook for failed charges", "payment-gateway", false],
];

// The rule this replaced, kept here as the baseline: id word = 2, file-name word = 1, listed at 2 or more, ties by id.
const STOP = new Set(["the", "and", "for", "with", "into", "from", "that", "this", "add", "make", "new", "use", "get", "set", "all", "any", "when", "should", "need", "needs", "want", "please", "create", "build", "implement", "write", "update", "change", "fix"]);
const w = (t: string): string[] => t.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length >= 3 && !STOP.has(x)).map((x) => (x.length > 4 && x.endsWith("s") ? x.slice(0, -1) : x));
function oldRule(intent: string): string[] {
  const wanted = new Set(w(intent));
  const out: { id: string; score: number }[] = [];
  for (const e of M) {
    const idW = new Set(w(e.component_id));
    const fW = new Set(e.files.flatMap((f) => w(f.replace(/\.[^./\\]+$/, "").replace(/^.*[\\/]/, ""))));
    let score = 0;
    for (const x of wanted) score += idW.has(x) ? 2 : fW.has(x) ? 1 : 0;
    if (score >= 2) out.push({ id: e.component_id, score });
  }
  return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 3).map((x) => x.id);
}

describe("similar components: BM25 against the word-overlap it replaced", () => {
  test("recall in the top three does not drop, and the wrong-first rate does not rise", () => {
    let oldHit = 0, newHit = 0, oldWrongFirst = 0, newWrongFirst = 0;
    for (const [intent, want] of CASES) {
      const o = oldRule(intent);
      const n = findSimilarComponents(intent, M, 3, NOTES).map((x) => x.componentId);
      if (o.includes(want)) oldHit++;
      if (n.includes(want)) newHit++;
      if (o.length && o[0] !== want) oldWrongFirst++;
      if (n.length && n[0] !== want) newWrongFirst++;
    }
    console.log(`similar recall@3 on ${CASES.length} hand-written cases: word-overlap ${oldHit}, BM25 ${newHit}; wrong first suggestion: ${oldWrongFirst} -> ${newWrongFirst}`);
    expect(newHit).toBeGreaterThanOrEqual(oldHit);
    expect(newWrongFirst).toBeLessThanOrEqual(oldWrongFirst);
  });
  test("recorded purpose notes find a component whose id and files share no word with the request", () => {
    expect(findSimilarComponents("send a welcome email after signup", M, 3, NOTES)[0]?.componentId).toBe("email-notifier");
    expect(findSimilarComponents("limit requests per minute for each user", M, 3, NOTES)[0]?.componentId).toBe("rate-limiter");
    expect(findSimilarComponents("limit requests per minute for each user", M, 3, {}).map((x) => x.componentId)).not.toContain("rate-limiter");
  });
});
