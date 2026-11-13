// src/llm/call_log.ts
//
// AI-05. One row per provider call, failed calls and retries included, so the questions "how often does a model need a
// format retry", "how far off is the token estimate", "what does each call type cost" have measured answers instead of
// guesses. The table sits beside savings_ledger in the project's state database.
//
// What is stored: sizes, tiers, timing, cost, a status, and (for a change-classification call) the operation label the
// model chose, which is one word from a fixed list. What is never stored: any prompt text, any reply text, any file
// content, any instruction. `prompt_chars` is a length. A test puts a canary string in a prompt and asserts it appears
// in no column.
//
// Like events.ts, this is a side channel. A locked database or a write error is swallowed: observability must never be
// able to break the call it is watching.
import { randomUUID } from "node:crypto";
import { getDbCompat as getDb } from "../manifest/store.js";
import { withSqliteRetry } from "./sqlite_retry.js";
import { CHARS_PER_TOKEN } from "./context/tokens.js";
import type { RoutingCall } from "./router.js";

/** "timeout": the provider did not answer within the deadline (A10c-1). Like "provider_error", it costs nothing and has no usable token counts. */
export type CallStatus = "ok" | "format_error" | "provider_error" | "timeout";

export interface CallLogInput {
  callType: RoutingCall;
  tier: "low" | "high";
  provider: string;
  model: string;
  promptChars: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  retry: boolean;
  latencyMs: number;
  costUsd: number;
  status: CallStatus;
}

/** One id per process: calls made by one command invocation or one MCP server run share it. */
const SESSION_ID = randomUUID();

/** The row the most recent call wrote, so a parse failure that happens after the call can mark it. Null until a row exists. */
let lastRowId: number | null = null;

export function currentSessionId(): string {
  return SESSION_ID;
}

/** The estimate Purix makes before a call, from the prompt's length. Kept here so the report compares like with like. */
export function estimateInputTokens(promptChars: number): number {
  return promptChars <= 0 ? 0 : Math.ceil(promptChars / CHARS_PER_TOKEN);
}

function ensureTable(): void {
  const db = getDb();
  db.run(`
    CREATE TABLE IF NOT EXISTS llm_call_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      call_type TEXT NOT NULL,
      tier TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      est_input_tokens INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cached_input_tokens INTEGER,
      retry INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      status TEXT NOT NULL,
      prompt_chars INTEGER NOT NULL,
      verdict_operation TEXT
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_llm_call_log_type ON llm_call_log (call_type)`);
}

/** Writes one row. Returns its id, or null when the write could not be made. Never throws. */
export function recordLlmCall(c: CallLogInput): number | null {
  try {
    return withSqliteRetry(() => {
      ensureTable();
      const res = getDb().run(
        `INSERT INTO llm_call_log
           (session_id, created_at, call_type, tier, provider, model, est_input_tokens, input_tokens, output_tokens,
            cached_input_tokens, retry, latency_ms, cost_usd, status, prompt_chars)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          SESSION_ID, new Date().toISOString(), c.callType, c.tier, c.provider, c.model,
          estimateInputTokens(c.promptChars), c.inputTokens, c.outputTokens,
          c.cachedInputTokens ?? null, c.retry ? 1 : 0, Math.round(c.latencyMs), c.costUsd, c.status, c.promptChars,
        ],
      );
      const id = Number((res as { lastInsertRowid?: number | bigint }).lastInsertRowid ?? NaN);
      lastRowId = Number.isFinite(id) ? id : null;
      return lastRowId;
    }, "llm_call_log");
  } catch {
    lastRowId = null;
    return null;
  }
}

function updateLastRow(sql: string, params: (string | number)[]): void {
  if (lastRowId === null) return;
  const id = lastRowId;
  try {
    withSqliteRetry(() => { getDb().run(sql, [...params, id]); }, "llm_call_log_update");
  } catch { /* side channel */ }
}

/** The reply of the last call could not be read (not JSON, or the wrong shape). Called by the parse step, after the call. */
export function markLastCallFormatError(): void {
  updateLastRow(`UPDATE llm_call_log SET status = 'format_error' WHERE id = ? AND status = 'ok'`, []);
  lastRowId = null;
}

/** The operation label a change-classification reply carried (one word from the fixed list). Never reply text. */
export function markLastCallOperation(operation: string): void {
  updateLastRow(`UPDATE llm_call_log SET verdict_operation = ? WHERE id = ?`, [operation]);
}

/**
 * Retention (research 15, finding 4: no log had a limit). Removes call rows older than `maxAgeDays` and returns how many went.
 * Only this table is touched; the budget and the savings ledger are separate tables and stay. A limit that is not a positive
 * whole number of days deletes nothing, so a bad setting can never empty the log. Never throws: a locked database means "0 removed".
 */
export function pruneCallLog(maxAgeDays: number): number {
  if (!Number.isInteger(maxAgeDays) || maxAgeDays <= 0) return 0;
  try {
    return withSqliteRetry(() => {
      ensureTable();
      const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
      const res = getDb().run(`DELETE FROM llm_call_log WHERE created_at < ?`, [cutoff]);
      return Number((res as { changes?: number | bigint }).changes ?? 0);
    }, "llm_call_log_prune");
  } catch {
    return 0;
  }
}

// ---- the report behind `purix stats --calls` -----------------------------------------------------------------------------

export interface CallTypeRow {
  callType: string;
  count: number;
  medianInputTokens: number;
  medianOutputTokens: number;
  retryShare: number;
  formatErrorShare: number;
  providerErrorShare: number;
  /** Of calls that carried an operation label, the share labelled "unclassified". Null when none did. */
  unclassifiedShare: number | null;
  costUsd: number;
}

export interface EstimateRatioRow {
  provider: string;
  /** Provider-reported input tokens divided by Purix's estimate, over calls that reported tokens. 1.0 means the estimate was right. */
  actualOverEstimate: number;
  samples: number;
}

/**
 * AI-20 (PURIX-33), measurement only: per model, how often a reply could not be read. The plan weighs native structured
 * output against JSON plus Zod only where this share is above 3% for a model that supports it, so the report says which
 * models are over the line. It changes nothing by itself.
 */
export const FORMAT_ERROR_THRESHOLD = 0.03;
/** Below this many calls a share is noise (one bad reply in ten is 10%); the model is listed but not flagged. */
export const FORMAT_ERROR_MIN_CALLS = 20;

export interface ModelRow {
  provider: string;
  model: string;
  count: number;
  formatErrorShare: number;
  /** True when the share is above the threshold on at least the minimum number of calls. */
  overThreshold: boolean;
}

export interface CallReport {
  totalCalls: number;
  byType: CallTypeRow[];
  byModel: ModelRow[];
  estimateRatios: EstimateRatioRow[];
  cachedInputShare: number | null;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

interface RawRow {
  call_type: string; provider: string; model: string; est_input_tokens: number; input_tokens: number; output_tokens: number;
  cached_input_tokens: number | null; retry: number; status: string; cost_usd: number; verdict_operation: string | null;
}

export function buildCallReport(windowDays?: number): CallReport {
  let rows: RawRow[];
  try {
    ensureTable();
    const since = windowDays === undefined ? "" : new Date(Date.now() - windowDays * 86_400_000).toISOString();
    rows = (since
      ? getDb().query(`SELECT call_type, provider, model, est_input_tokens, input_tokens, output_tokens, cached_input_tokens, retry, status, cost_usd, verdict_operation FROM llm_call_log WHERE created_at >= ?`).all(since)
      : getDb().query(`SELECT call_type, provider, model, est_input_tokens, input_tokens, output_tokens, cached_input_tokens, retry, status, cost_usd, verdict_operation FROM llm_call_log`).all()) as unknown as RawRow[];
  } catch {
    rows = [];
  }

  const groups = new Map<string, RawRow[]>();
  // push into the group's own array: copying it per row made this quadratic (research 15, finding 1: 50,000 rows took 22 s)
  for (const r of rows) { const g = groups.get(r.call_type); if (g) g.push(r); else groups.set(r.call_type, [r]); }
  const byType: CallTypeRow[] = [...groups.entries()]
    .map(([callType, g]) => {
      const labelled = g.filter((r) => r.verdict_operation !== null);
      return {
        callType,
        count: g.length,
        medianInputTokens: median(g.filter((r) => r.status !== "provider_error" && r.status !== "timeout").map((r) => r.input_tokens)),
        medianOutputTokens: median(g.filter((r) => r.status !== "provider_error" && r.status !== "timeout").map((r) => r.output_tokens)),
        retryShare: g.filter((r) => r.retry === 1).length / g.length,
        formatErrorShare: g.filter((r) => r.status === "format_error").length / g.length,
        providerErrorShare: g.filter((r) => r.status === "provider_error").length / g.length,
        unclassifiedShare: labelled.length === 0 ? null : labelled.filter((r) => r.verdict_operation === "unclassified").length / labelled.length,
        costUsd: g.reduce((a, r) => a + r.cost_usd, 0),
      };
    })
    .sort((a, b) => b.count - a.count || a.callType.localeCompare(b.callType));

  const models = new Map<string, RawRow[]>();
  for (const r of rows) { const k = `${r.provider}\u0000${r.model}`; const g = models.get(k); if (g) g.push(r); else models.set(k, [r]); }
  const byModel: ModelRow[] = [...models.values()]
    .map((g) => {
      const share = g.filter((r) => r.status === "format_error").length / g.length;
      return { provider: g[0]!.provider, model: g[0]!.model, count: g.length, formatErrorShare: share, overThreshold: g.length >= FORMAT_ERROR_MIN_CALLS && share > FORMAT_ERROR_THRESHOLD };
    })
    .sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));

  const byProvider = new Map<string, { actual: number; est: number; n: number }>();
  for (const r of rows) {
    if (r.status === "provider_error" || r.input_tokens <= 0 || r.est_input_tokens <= 0) continue;
    // Anthropic reports cache reads outside input_tokens; the others count them inside. Only the reported field is compared.
    const b = byProvider.get(r.provider) ?? { actual: 0, est: 0, n: 0 };
    b.actual += r.input_tokens; b.est += r.est_input_tokens; b.n += 1;
    byProvider.set(r.provider, b);
  }
  const estimateRatios = [...byProvider.entries()]
    .map(([provider, b]) => ({ provider, actualOverEstimate: b.actual / b.est, samples: b.n }))
    .sort((a, b) => a.provider.localeCompare(b.provider));

  const reportedCache = rows.filter((r) => r.cached_input_tokens !== null && r.input_tokens > 0);
  const cachedInputShare = reportedCache.length === 0
    ? null
    : reportedCache.reduce((a, r) => a + (r.cached_input_tokens ?? 0), 0) / reportedCache.reduce((a, r) => a + r.input_tokens, 0);

  return { totalCalls: rows.length, byType, byModel, estimateRatios, cachedInputShare };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

export function formatCallReport(report: CallReport): string {
  if (report.totalCalls === 0) return "Model calls: none recorded yet. Every call Purix makes to a model is counted here from now on (sizes and timings only, never prompt or reply text).";
  const lines: string[] = [`Model calls: ${report.totalCalls} recorded`];
  lines.push("  call type              count  median in  median out  retry   bad format  provider err  unclassified   cost");
  for (const r of report.byType) {
    lines.push(
      `  ${r.callType.padEnd(22)} ${String(r.count).padStart(5)}  ${String(r.medianInputTokens).padStart(9)}  ${String(r.medianOutputTokens).padStart(10)}  ` +
      `${pct(r.retryShare).padStart(6)}  ${pct(r.formatErrorShare).padStart(10)}  ${pct(r.providerErrorShare).padStart(12)}  ` +
      `${(r.unclassifiedShare === null ? "n/a" : pct(r.unclassifiedShare)).padStart(12)}   $${r.costUsd.toFixed(4)}`,
    );
  }
  if (report.byModel.length > 0) {
    lines.push(`  Unreadable replies by model (the AI-20 evidence: native structured output is only worth weighing above ${pct(FORMAT_ERROR_THRESHOLD)} on at least ${FORMAT_ERROR_MIN_CALLS} calls):`);
    for (const m of report.byModel) {
      lines.push(`    ${m.provider}/${m.model}: ${pct(m.formatErrorShare)} of ${m.count} call(s)${m.overThreshold ? "  <- over the line" : m.count < FORMAT_ERROR_MIN_CALLS ? "  (too few calls to judge)" : ""}`);
    }
  }
  if (report.estimateRatios.length > 0) {
    lines.push("  Estimate check (provider-reported input tokens / Purix estimate; 1.00 means the estimate was right):");
    for (const e of report.estimateRatios) lines.push(`    ${e.provider}: ${e.actualOverEstimate.toFixed(2)} over ${e.samples} call(s)`);
  }
  lines.push(report.cachedInputShare === null
    ? "  Cached input: no provider has reported cached tokens yet."
    : `  Cached input: ${pct(report.cachedInputShare)} of reported input tokens were served from the provider's cache.`);
  return lines.join("\n");
}
