// src/approvals/wait_times.ts
//
// How long a person kept a change waiting. The times are already kept: every approval writes a "requested" record and then an
// "approved" or "denied" record to the hash-chained audit log, each carrying its own `at`, and those records outlive the approval
// files (which are deleted a day after they expire). So this reads the chain; nothing new is stored.
//
// Pure: it takes rows already read (readAuditChain().rows) and returns one entry per approval. A request nobody answered has no
// decision and no wait; it is reported as unanswered, never as zero.

export interface ApprovalAuditRow {
  payload: string;
  timestamp: string;
}

export interface ApprovalWait {
  approvalId: string;
  tool: string;
  componentId: string | null;
  requestedAt: string;
  decision?: "approved" | "denied";
  decidedAt?: string;
  /** Milliseconds from request to decision. Absent while unanswered, and when the clock makes it negative. */
  waitMs?: number;
  /** When the approved action was carried out (state "consumed"), if it was. */
  consumedAt?: string;
}

interface ApprovalPayload {
  event?: unknown;
  state?: unknown;
  approval_id?: unknown;
  tool?: unknown;
  component_id?: unknown;
  at?: unknown;
}

function parse(row: ApprovalAuditRow): ApprovalPayload | null {
  try {
    const v: unknown = JSON.parse(row.payload);
    return typeof v === "object" && v !== null ? (v as ApprovalPayload) : null;
  } catch {
    return null;
  }
}

const isoOrNull = (v: unknown, fallback: string): string => {
  const s = typeof v === "string" ? v : fallback;
  return Number.isNaN(Date.parse(s)) ? fallback : s;
};

/** One entry per approval id, in the order the requests were made. Rows that are not approval records, or are unreadable, are ignored. */
export function approvalWaitTimes(rows: ApprovalAuditRow[]): ApprovalWait[] {
  const byId = new Map<string, ApprovalWait>();
  for (const row of rows) {
    const p = parse(row);
    if (!p || p.event !== "approval" || typeof p.approval_id !== "string" || typeof p.state !== "string") continue;
    const at = isoOrNull(p.at, row.timestamp);
    if (p.state === "requested") {
      if (byId.has(p.approval_id)) continue;
      byId.set(p.approval_id, {
        approvalId: p.approval_id,
        tool: typeof p.tool === "string" ? p.tool : "?",
        componentId: typeof p.component_id === "string" ? p.component_id : null,
        requestedAt: at,
      });
      continue;
    }
    const w = byId.get(p.approval_id);
    if (!w) continue; // an answer whose request was pruned from the chain: no wait can be told
    if (p.state === "approved" || p.state === "denied") {
      if (w.decision) continue;
      w.decision = p.state;
      w.decidedAt = at;
      const ms = Date.parse(at) - Date.parse(w.requestedAt);
      if (ms >= 0) w.waitMs = ms;
    } else if (p.state === "consumed" && !w.consumedAt) {
      w.consumedAt = at;
    }
  }
  return [...byId.values()];
}

export interface ApprovalWaitSummary {
  requested: number;
  approved: number;
  denied: number;
  /** Requests with no decision on record (expired, or still waiting). */
  unanswered: number;
  /** Median wait over the answered requests that have a wait, in milliseconds. Absent when there are none. */
  medianWaitMs?: number;
}

export function summarizeApprovalWaits(waits: ApprovalWait[]): ApprovalWaitSummary {
  const times = waits.map((w) => w.waitMs).filter((m): m is number => m !== undefined).sort((a, b) => a - b);
  const mid = Math.floor(times.length / 2);
  const median = times.length === 0 ? undefined : times.length % 2 === 1 ? times[mid]! : Math.round((times[mid - 1]! + times[mid]!) / 2);
  return {
    requested: waits.length,
    approved: waits.filter((w) => w.decision === "approved").length,
    denied: waits.filter((w) => w.decision === "denied").length,
    unanswered: waits.filter((w) => !w.decision).length,
    ...(median !== undefined ? { medianWaitMs: median } : {}),
  };
}
