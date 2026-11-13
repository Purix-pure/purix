// src/manifest/events.ts
import { appendFileSync, existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDbCompat as getDb, getDbFilePath } from "./store.js";
import { isDatabaseBusy } from "../platform/db_busy.js";

/**
 * §10 Observability's substrate. Every metric that section lists
 * (escalation rate, confidence trend, verification-failure clustering,
 * approval-response pattern, idiom soft-fail rate, reconciliation
 * frequency, test-integrity flag rate tracked separately from the
 * coverage-gate rate) needs an actual event stream to compute from —
 * this is that stream. Append-only, deliberately dumb: no aggregation
 * logic lives here, that's observability.ts's job. This file only ever
 * writes and reads back rows.
 */
export type EventKind =
  | "request" // a "purix modify" invocation reached Node 1
  | "classification" // Node 3b returned a verdict (carries confidence)
  | "verification_failure" // any sandbox verify failed, at any stage
  | "verification_pass" // any sandbox verify passed, at any stage
  | "escalation_start" // §6.3 entered, for any reason
  | "escalation_outcome" // §6.3 exited: library hit, fresh fix, or exhausted
  | "confirm_response" // a §7.5 checkpoint was answered
  | "reconciliation" // §7.2 drift accepted, or §7.3 pending-op reconciled
  | "idiom_findings" // an idiom check ran and produced N findings (N may be 0)
  | "gate_evaluation" // TrustGate (or its diff-path variant) ran at all — denominator for the two rates below
  | "test_integrity_flag" // §6.4 flagged a weakened/removed assertion
  | "coverage_gate_flag" // §6.2's coverage gate found zero test coverage on a changed file
  | "component_deleted" // a component was permanently removed from the manifest
  | "component_adopted" // an indexed file was registered as a component by `purix adopt`
  | "anchor_match" // AI-06: a prompt_text anchor needed a looser reading to match (detail.outcome "rescued", with the stages) or matched nothing ("missed")
  | "compile_retry" // AI-11: the first edits did not apply and the cheap tier was asked once more (detail.outcome "recovered" or "failed")
  | "precheck_block" // AI-07: the parse check failed an edit before the sandbox copy (detail: files, errorClass)
  | "input_neutralized" // AI-12: instruction-like text or hidden characters were removed from repair input before a prompt (detail: stage, source, hit_count, hits)
  | "repair_early_stop" // AI-12: the repair loop stopped because the same error class came back at the same place (detail: stage, attempt, error_class, location)
  | "hook_denied" // an agent hook blocked a call that would have bypassed Purix (detail: agent, rule, targets)
  | "injection_flag" // F03-08: the phrase tripwire fired and a person was required to approve the change (detail: stage, action, sightings)
  | "unadopted_write"; // C5: an agent hook allowed a write to a project file Purix does not govern, and named it (detail: agent, files)

export interface EventRecord {
  id: string;
  timestamp: string;
  kind: EventKind;
  component_id: string | null;
  operation: string | null;
  detail: Record<string, unknown>;
}

function ensureTable(): void {
  const db = getDb();
  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      kind TEXT NOT NULL,
      component_id TEXT,
      operation TEXT,
      detail TEXT NOT NULL DEFAULT '{}'
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_kind ON events (kind)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events (timestamp)`);
}

/**
 * Fire-and-forget by design: observability must never be able to break
 * or slow down the actual pipeline it's watching. A malformed detail
 * object or a locked DB here logs a warning and moves on — it does NOT
 * throw up into the caller the way budget.ts/circuit.ts deliberately do
 * for their own guardrails. Those are load-bearing; this is a side
 * channel.
 */
export function recordEvent(
  kind: EventKind,
  fields: { component_id?: string | null; operation?: string | null; detail?: Record<string, unknown> } = {}
): void {
  const row = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    kind,
    component_id: fields.component_id ?? null,
    operation: fields.operation ?? null,
    detail: JSON.stringify(fields.detail ?? {}),
  };
  try {
    ensureTable();
    insertRow(row);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Research 15, finding 3: a store another process holds for longer than the wait used to lose the event for good.
    // A busy store is not a broken one, so the event is kept in a small file next to the store and written on the next
    // successful call (or read). Any other failure keeps the old behaviour: one warning, nothing stored.
    const kept = isDatabaseBusy(message) && spoolRow(row);
    console.warn(
      kept
        ? `  [events] the store was busy, so the "${kind}" event was kept in ${SPOOL_NAME} and will be written next time (non-fatal)`
        : `  [events] failed to record "${kind}" event (non-fatal): ${message}`
    );
    return;
  }
  flushPendingEvents();
}

// ---- pending events (research 15, finding 3) ----
const SPOOL_NAME = "events-pending.jsonl";
/** The spool is a stop-gap for a busy store, not a second log: past this size new events are dropped with a warning. */
const SPOOL_MAX_BYTES = 1_048_576;

interface EventRow { id: string; timestamp: string; kind: string; component_id: string | null; operation: string | null; detail: string }

function insertRow(row: EventRow, ignoreDuplicate = false): void {
  getDb().run(
    `INSERT ${ignoreDuplicate ? "OR IGNORE " : ""}INTO events (id, timestamp, kind, component_id, operation, detail) VALUES (?, ?, ?, ?, ?, ?)`,
    [row.id, row.timestamp, row.kind, row.component_id, row.operation, row.detail]
  );
}

function spoolPath(): string | null {
  const db = getDbFilePath();
  return db ? join(dirname(db), SPOOL_NAME) : null;
}

function spoolRow(row: EventRow): boolean {
  try {
    const path = spoolPath();
    if (!path) return false;
    if (existsSync(path) && statSync(path).size > SPOOL_MAX_BYTES) return false;
    appendFileSync(path, JSON.stringify(row) + "\n");
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes spooled events into the table, keeping their original id and time. Safe to repeat and to run in two processes: an
 * id already stored is ignored. Never throws. Leaves the file alone when the store is still busy or when something was
 * appended while it was being read.
 */
export function flushPendingEvents(): number {
  try {
    const path = spoolPath();
    if (!path || !existsSync(path)) return 0;
    ensureTable();
    const text = readFileSync(path, "utf8");
    const bytes = Buffer.byteLength(text);
    let written = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let row: EventRow;
      try { row = JSON.parse(line) as EventRow; } catch { continue; } // a torn last line from a crash is skipped
      if (typeof row.id !== "string" || typeof row.kind !== "string" || typeof row.timestamp !== "string") continue;
      insertRow(row, true);
      written++;
    }
    if (statSync(path).size === bytes) unlinkSync(path);
    return written;
  } catch {
    return 0; // still busy or unreadable: the file stays and the next call tries again
  }
}

/**
 * Retention (research 15, finding 4: nothing deleted old events). Removes events older than `maxAgeDays`, returns how many went.
 * A limit that is not a positive whole number of days deletes nothing. Never throws, like recordEvent.
 */
export function pruneEvents(maxAgeDays: number): number {
  if (!Number.isInteger(maxAgeDays) || maxAgeDays <= 0) return 0;
  try {
    ensureTable();
    const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
    const res = getDb().run(`DELETE FROM events WHERE timestamp < ?`, [cutoff]);
    return Number((res as { changes?: number | bigint }).changes ?? 0);
  } catch {
    return 0; // a side channel: a locked or unreadable store means "nothing pruned this time"
  }
}

export interface EventFilter {
  kind?: EventKind;
  componentId?: string;
  since?: string; // ISO timestamp, inclusive
}

export function listEvents(filter: EventFilter = {}): EventRecord[] {
  ensureTable();
  flushPendingEvents();
  const db = getDb();
  const clauses: string[] = [];
  const params: string[] = [];   // was: unknown[]
  if (filter.kind) {
    clauses.push("kind = ?");
    params.push(filter.kind);
  }
  if (filter.componentId) {
    clauses.push("component_id = ?");
    params.push(filter.componentId);
  }
  if (filter.since) {
    clauses.push("timestamp >= ?");
    params.push(filter.since);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.query(`SELECT * FROM events ${where} ORDER BY timestamp ASC`).all(...params) as any[];
  return rows.map((r) => ({ ...r, detail: JSON.parse(r.detail) })) as EventRecord[];
}