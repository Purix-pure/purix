// src/manifest/events.ts
import { getDbCompat as getDb } from "./store.js";

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
  | "component_deleted"; // a component was permanently removed from the manifest

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
  try {
    ensureTable();
    const db = getDb();
    db.run(
      `INSERT INTO events (id, timestamp, kind, component_id, operation, detail) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        new Date().toISOString(),
        kind,
        fields.component_id ?? null,
        fields.operation ?? null,
        JSON.stringify(fields.detail ?? {}),
      ]
    );
  } catch (err) {
    console.warn(`  [events] failed to record "${kind}" event (non-fatal): ${err instanceof Error ? err.message : err}`);
  }
}

export interface EventFilter {
  kind?: EventKind;
  componentId?: string;
  since?: string; // ISO timestamp, inclusive
}

export function listEvents(filter: EventFilter = {}): EventRecord[] {
  ensureTable();
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