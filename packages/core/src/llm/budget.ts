// src/llm/budget.ts
import { getDbCompat as getDb } from "../manifest/store.js";
import { withSqliteRetry, SqliteRetryExhaustedError } from "./sqlite_retry.js";
import { recordOverrideAudit } from "../security/override_audit.js";
import { getProjectId } from "../state/project_id.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const PRICE_PER_1M_INPUT_USD = 0.10;
const PRICE_PER_1M_OUTPUT_USD = 0.40;

function ensureBudgetTable(): void {
  // ADR-041 note: under real multi-process contention (two worktrees'
  // processes initializing this table for the first time at once), every
  // one of these statements can hit SQLITE_BUSY/"database is locked" —
  // confirmed via budget_worktree.test.ts. Previously unwrapped, so that
  // error escaped raw past assertBudgetAvailable's own retry/catch logic
  // entirely, since this function runs before that logic does. Wrapping
  // each statement in withSqliteRetry is safe to let throw upward on
  // exhaustion (as SqliteRetryExhaustedError, or a non-busy error
  // unchanged) — assertBudgetAvailable's caller-facing catch already
  // knows how to turn that into an honest "refusing this call" result
  // rather than a raw crash.
  withSqliteRetry(() => {
    const db = getDb();
    db.run(`
      CREATE TABLE IF NOT EXISTS budget_state (
        repo_id TEXT PRIMARY KEY,
        total_spent_usd REAL NOT NULL DEFAULT 0,
        calls INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )
    `);
  }, "budget_ensure_table");

  const repoId = getProjectId();
  const existing = withSqliteRetry(() => {
    const db = getDb();
    return db.query(`SELECT 1 FROM budget_state WHERE repo_id = ?`).get(repoId);
  }, "budget_ensure_lookup");

  if (!existing) {
    withSqliteRetry(() => {
      const db = getDb();
      // CREATE TABLE + the INSERT below (also OR IGNORE, also inside its
      // own retry) together mean: even if two processes both reach this
      // branch for the same never-before-seen repoId at once, each
      // individual statement is retried past transient busy errors and
      // the row ends up inserted exactly once either way.
      try {
        const legacy = db.query(`SELECT total_spent_usd, calls, updated_at FROM budget_state WHERE id = 1`).get() as { total_spent_usd: number; calls: number; updated_at: string } | null;
        if (legacy) {
          db.run(
            `INSERT INTO budget_state (repo_id, total_spent_usd, calls, updated_at) VALUES (?, ?, ?, ?)`,
            [repoId, legacy.total_spent_usd, legacy.calls, legacy.updated_at]
          );
          console.log(`  [budget] Migrated legacy global budget state into repository ID ${repoId}`);
        }
      } catch {}
    }, "budget_ensure_migrate");

    withSqliteRetry(() => {
      const db = getDb();
      db.run(
        `INSERT OR IGNORE INTO budget_state (repo_id, total_spent_usd, calls, updated_at) VALUES (?, 0, 0, ?)`,
        [repoId, new Date().toISOString()]
      );
    }, "budget_ensure_insert");
  }
}

interface BudgetSnapshotRow {
  total_spent_usd: number;
  calls: number;
  updated_at: string;
}

function readBudgetRow(): BudgetSnapshotRow {
  ensureBudgetTable();
  const db = getDb();
  const repoId = getProjectId();
  const row = db
    .query(`SELECT total_spent_usd, calls, updated_at FROM budget_state WHERE repo_id = ?`)
    .get(repoId) as BudgetSnapshotRow | null;
  return row ?? { total_spent_usd: 0, calls: 0, updated_at: new Date().toISOString() };
}

function getCeiling(): number {
  const raw = process.env.PURIX_COST_CEILING_USD;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5.0;
}

let invocationOverrideReason: string | undefined = undefined;

export function setBudgetOverride(reason?: string): void {
  invocationOverrideReason = reason;
}

export function assertBudgetAvailable(estimatedCost = 0.05): number {
  ensureBudgetTable();
  const ceiling = getCeiling();
  if (invocationOverrideReason !== undefined) {
    const reason = invocationOverrideReason;
    invocationOverrideReason = undefined;
    const state = readBudgetRow();
    recordOverrideAudit("BudgetGate", reason, `Budget exceeded: $${state.total_spent_usd.toFixed(4)} / $${ceiling.toFixed(2)}`);
    console.log(`  [override] BudgetGate overridden: ${reason.trim()}`);
    return 0;
  }

  let success: boolean;
  try {
    success = withSqliteRetry(() => {
      const db = getDb();
      const repoId = getProjectId();
      const res = db.run(
        `UPDATE budget_state
         SET total_spent_usd = total_spent_usd + ?, calls = calls + 1, updated_at = ?
         WHERE repo_id = ? AND total_spent_usd + ? <= ?`,
        [estimatedCost, new Date().toISOString(), repoId, estimatedCost, ceiling]
      );
      return res.changes > 0;
    }, "budget_reserve");
  } catch (err) {
    if (err instanceof SqliteRetryExhaustedError) {
      // Under heavy concurrent contention we couldn't even confirm
      // whether budget is available — the safe default is to refuse the
      // spend rather than let an ambiguous state through, and to surface
      // it as the same kind of "can't proceed right now" result callers
      // already handle, not a raw driver error.
      throw new Error(
        `Cost guardrail check is temporarily unavailable due to high concurrent load ` +
          `(${err.message}). Refusing this LLM call rather than risk an unchecked spend — retry shortly.`
      );
    }
    throw err;
  }

  if (!success) {
    const state = readBudgetRow();
    throw new Error(
      `Cost guardrail tripped: estimated spend $${state.total_spent_usd.toFixed(4)} has reached the ` +
        `hard ceiling of $${ceiling.toFixed(2)}. Set PURIX_COST_CEILING_USD to raise it. ` +
        `Refusing further LLM calls until this is addressed.`
    );
  }

  return estimatedCost;
}

const PRICE_PER_1M_USD: Record<"low" | "high", { input: number; output: number }> = {
  low: { input: PRICE_PER_1M_INPUT_USD, output: PRICE_PER_1M_OUTPUT_USD },
  high: { input: 1.25, output: 5.00 },
};

export function recordUsage(
  usage: { promptTokenCount?: number; candidatesTokenCount?: number } | undefined,
  tier: "low" | "high" = "low",
  reservedCost = 0
): void {
  ensureBudgetTable();
  const inputTokens = usage?.promptTokenCount ?? 0;
  const outputTokens = usage?.candidatesTokenCount ?? 0;
  const price = PRICE_PER_1M_USD[tier];
  const actualCost = (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
  const delta = actualCost - reservedCost;

  const newTotal = withSqliteRetry(() => {
    const db = getDb();
    const repoId = getProjectId();
    if (reservedCost > 0) {
      db.run(
        `UPDATE budget_state
         SET total_spent_usd = total_spent_usd + ?, updated_at = ?
         WHERE repo_id = ?`,
        [delta, new Date().toISOString(), repoId]
      );
    } else {
      db.run(
        `UPDATE budget_state
         SET total_spent_usd = total_spent_usd + ?, calls = calls + 1, updated_at = ?
         WHERE repo_id = ?`,
        [actualCost, new Date().toISOString(), repoId]
      );
    }
    const row = db.query(`SELECT total_spent_usd FROM budget_state WHERE repo_id = ?`).get(repoId) as
      | { total_spent_usd: number }
      | null;
    return row?.total_spent_usd ?? actualCost;
  }, "budget");

  const ceiling = getCeiling();
  console.log(
    `  [cost] +$${actualCost.toFixed(5)} — running total $${newTotal.toFixed(4)} / $${ceiling.toFixed(2)} ceiling`
  );
}

export function recordProviderUsage(
  usage: { inputTokens: number; outputTokens: number },
  provider: string,
  tier: "low" | "high" = "low",
  reservedCost = 0
): void {
  ensureBudgetTable();
  const { priceFor } = require("./providers") as typeof import("./providers.js");
  const price = priceFor(provider, tier);
  const actualCost = (usage.inputTokens / 1_000_000) * price.input + (usage.outputTokens / 1_000_000) * price.output;
  const delta = actualCost - reservedCost;

  const newTotal = withSqliteRetry(() => {
    const db = getDb();
    const repoId = getProjectId();
    if (reservedCost > 0) {
      db.run(
        `UPDATE budget_state
         SET total_spent_usd = total_spent_usd + ?, updated_at = ?
         WHERE repo_id = ?`,
        [delta, new Date().toISOString(), repoId]
      );
    } else {
      db.run(
        `UPDATE budget_state
         SET total_spent_usd = total_spent_usd + ?, calls = calls + 1, updated_at = ?
         WHERE repo_id = ?`,
        [actualCost, new Date().toISOString(), repoId]
      );
    }
    const row = db.query(`SELECT total_spent_usd FROM budget_state WHERE repo_id = ?`).get(repoId) as
      | { total_spent_usd: number }
      | null;
    return row?.total_spent_usd ?? actualCost;
  }, "budget");

  const ceiling = getCeiling();
  console.log(
    `  [cost:${provider}] +$${actualCost.toFixed(5)} — running total $${newTotal.toFixed(4)} / $${ceiling.toFixed(2)} ceiling`
  );
}

export function getBudgetSnapshot(): { totalSpentUsd: number; ceiling: number } | null {
  try {
    const state = readBudgetRow();
    return { totalSpentUsd: state.total_spent_usd, ceiling: getCeiling() };
  } catch {
    return null;
  }
}

function ensureSavingsTable(): void {
  const db = getDb();
  db.run(`
    CREATE TABLE IF NOT EXISTS savings_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      call_type TEXT NOT NULL,
      actual_cost_usd REAL NOT NULL,
      counterfactual_cost_usd REAL NOT NULL,
      delta_usd REAL NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
}

export function recordSavings(
  call: import("./router.js").RoutingCall,
  decision: import("./router.js").RoutingDecision,
  usage: { inputTokens: number; outputTokens: number },
  provider: string
): void {
  const HIGH_ELIGIBLE: import("./router.js").RoutingCall[] = ["intent_refinement", "escalation"];
  if (!HIGH_ELIGIBLE.includes(call) || decision.tier !== "low") {
    return;
  }

  ensureSavingsTable();
  const { priceFor } = require("./providers") as typeof import("./providers.js");
  const actualPrice = priceFor(provider, "low");
  const counterfactualPrice = priceFor(provider, "high");

  const actualCost =
    (usage.inputTokens / 1_000_000) * actualPrice.input + (usage.outputTokens / 1_000_000) * actualPrice.output;
  const counterfactualCost =
    (usage.inputTokens / 1_000_000) * counterfactualPrice.input + (usage.outputTokens / 1_000_000) * counterfactualPrice.output;
  const delta = counterfactualCost - actualCost;

  if (delta <= 0) return;

  withSqliteRetry(() => {
    const db = getDb();
    db.run(
      `INSERT INTO savings_ledger (call_type, actual_cost_usd, counterfactual_cost_usd, delta_usd, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [call, actualCost, counterfactualCost, delta, new Date().toISOString()]
    );
  }, "savings_ledger");
}

export interface SavingsSummary {
  totalSavingsUsd: number;
  callCount: number;
}

export function getSavingsSummary(windowDays: number): SavingsSummary {
  try {
    ensureSavingsTable();
    const db = getDb();
    const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
    const row = db
      .query(
        `SELECT COALESCE(SUM(delta_usd), 0) as total, COUNT(*) as count
         FROM savings_ledger WHERE created_at >= ?`
      )
      .get(since) as { total: number; count: number } | null;
    return { totalSavingsUsd: row?.total ?? 0, callCount: row?.count ?? 0 };
  } catch {
    return { totalSavingsUsd: 0, callCount: 0 };
  }
}