// packages/core/src/observe/ledger_reader.ts
//
// The one reader for the record Purix keeps of what it did. The result line, `purix watch`, `purix statusline` and the dashboard all
// call this, so a number shown in the agent is the same number shown in the browser.
//
// It never writes. The database is opened read-only, by path, so it can read any project's record (the dashboard shows several) and
// can never block or slow a change: a writer in another process is not waited on past the short busy timeout, and a store that cannot be
// read gives `null`, not an exception.
//
// Every figure carries what it is made of. `measured` comes straight from stored rows. Anything that depends on a price table is
// `estimated` and is named so. A field a row did not record is left out, never filled with zero: "not recorded" and "none" differ,
// and the dashboard says which.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { purixEnv } from "../platform/env.js";
import { LEDGER_SCHEMA_VERSION } from "./ledger_version.js";
import { approvalWaitTimes, summarizeApprovalWaits } from "../approvals/wait_times.js";
import { reworkWithin, type ReworkResult } from "../state/rework.js";

export const LEDGER_DB_FILE = "manifest.db";
const DEFAULT_CEILING_USD = 5.0;
/** Events read for one summary. A project with more keeps its totals (counted in SQL) but the timeline shows the newest. */
const TIMELINE_EVENT_LIMIT = 5000;

/** Event kinds that mean Purix stopped something before it landed, and the plain-words reason shown for each. */
export const STOP_KINDS = {
  policy_block: "The secret scan or the security gate refused a change before any test ran",
  precheck_block: "An edit that did not parse was refused before any test ran",
  test_integrity_flag: "A weakened or removed test assertion was flagged",
  coverage_gate_flag: "A changed file had no test coverage at all",
  injection_flag: "Instruction-like text in repository content was held for a person",
  hook_denied: "A direct edit that would have bypassed Purix was blocked",
} as const;
export type StopKind = keyof typeof STOP_KINDS;
const STOP_KIND_LIST = Object.keys(STOP_KINDS) as StopKind[];

export interface TestTotals { passed: number; failed: number; skipped: number }

export interface StopRecord { kind: StopKind; reason: string; at: string; component: string | null; detail: Record<string, unknown> }

export type ChangeResult = "landed" | "verified" | "failed" | "stopped" | "waiting" | "unfinished";

export interface ChangeRecord {
  changeId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  component: string | null;
  operation: string | null;
  agent: string | null;
  result: ChangeResult;
  /** How many verification attempts failed before the first pass (0 means it passed first time). Null when nothing was verified. */
  failedBeforePass: number | null;
  testCounts: TestTotals | null;
  verifyMs: number | null;
  isolation: string | null;
  notTested: string[];
  notChecked: string[];
  securityAdvisories: number;
  stops: StopRecord[];
  waitedForPersonMs: number | null;
  approvals: { asked: number; approved: number; denied: number };
  modelCalls: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  costUsd: number;
  landedKind: string | null;
  landedVersion: number | null;
  helped: boolean | null;
  /** How much of the changed code the passing run ran (JS and TS runners, and Python through pytest-cov). Null when the run did not measure it. Information, never a target. */
  changedCoverage: ChangeCoverage | null;
  /** The dependency lookup for this change, or null when none ran (which does not mean no package was added). */
  dependencies: ChangeDependencies | null;
}

/** What the dependency lookup recorded for one change. Present only when a lookup ran (it is off unless PURIX_DEP_LOOKUP is set, and it records nothing for a change that adds no package). "unanswered" means not checked, never clean. */
export interface ChangeDependencies {
  mode: { osv: boolean; registry: boolean };
  /** Registry-resolvable package names the change adds or raises. */
  names: number;
  registry: { exists: number; missing: number; unanswered: number };
  advisories: { pairs: number; withAdvisories: number; unanswered: number };
  missingNames: string[];
  vulnerable: { name: string; version: string; advisoryCount: number }[];
}

export interface ChangeCoverage { covered: number; total: number; ratio: number | null; uncoveredFiles: number; uncoveredLines: number; notMeasuredFiles: number; why: string | null }


export interface SpendSummary {
  spentUsd: number;
  ceilingUsd: number;
  leftUsd: number;
  calls: number;
  failedCalls: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  /** Cost of calls whose change did not land, among calls that carry a change id. Null when no call carries one. */
  costOfUnlandedUsd: number | null;
  /** Estimated: what the cheaper tier cost against what the higher tier would have cost for the same tokens (savings_ledger). Null when the table is absent. A model-choice saving, not a saving against a plain agent. */
  modelTierSavingUsd: number | null;
  byModel: { provider: string; model: string; calls: number; costUsd: number; tokensIn: number; tokensOut: number }[];
  byCallType: { callType: string; calls: number; costUsd: number }[];
}

export interface ProjectSummary {
  schemaVersion: number;
  generatedAt: string;
  range: { from: string | null; to: string | null };
  /** When the oldest event still in the record happened (all time, whatever the range), or null when there are none. Older events may have been deleted by the log retention, so this is where the record starts, not where the project started. */
  firstEventAt: string | null;
  components: number | null;
  /** Landed changes in the whole audit chain (all time, whatever the range). */
  changesLanded: number;
  /** Landed changes whose closing event falls in the range. Older stores have none of these events, so this can be lower than changesLanded. */
  changesLandedInRange: number;
  /** Changes that have an id (written since change ids existed) and the older events that have none. Kept apart so no figure mixes them silently. */
  changesWithId: number;
  verificationPasses: number;
  verificationFailures: number;
  /** Of changes with an id that were verified: how many passed first time, and out of how many. */
  firstAttemptPass: { passed: number; of: number };
  stopped: { total: number; byKind: Record<string, number>; gateEvaluations: number };
  tests: { totals: TestTotals; verificationsWithCounts: number; verificationsWithoutCounts: number };
  approvals: { asked: number; approved: number; denied: number; medianWaitMs: number | null; waitsRecorded: number };
  spend: SpendSummary | null;
  isolation: Record<string, number>;
  notTestedFiles: number;
  notCheckedFiles: number;
  unadoptedWrites: number;
  hookDenials: number;
  /** Rework per component from the audit chain (all time, whatever the range). A correlation with later edits, not proof the first change was wrong. */
  rework: ReworkResult;
  /** Secrets redacted from model prompts and replies: occurrences by direction, and by format name. Never a value. */
  secretsRemoved: { outbound: number; inbound: number; byFormat: Record<string, number> };
  /** Changes applied then undone by Purix itself (a failed write or a manifest conflict). They never landed, so they are not reverts. */
  rolledBack: { total: number; undoFailed: number };
  dependencies: DependencySummary;
  /** The most recent `purix audit` in the range, or null when none ran. */
  lastAudit: AuditRunSummary | null;
  auditRuns: number;
  /** Findings the security gate recorded on passing runs (Low and Medium severity; capped per run), summed over the range. */
  securityAdvisories: number;
  agents: Record<string, number>;
  /** Landed changes with an id, split by the agent that made them. Changes before ids existed have no agent here. */
  landedByAgent: Record<string, number>;
  /** Repairs: how often the first fix was not enough. Counts of events, with outcomes by name. */
  repairs: { escalations: number; outcomes: Record<string, number>; compileRetries: number; earlyStops: number };
  /** Earlier work reused: library hits among escalations (a hit means no new model repair was needed). */
  reuse: { libraryHits: number; escalations: number };
  /** Edits made outside Purix that were accepted into the record (drift reconciled), and notes saved to repository memory. */
  driftAccepted: number;
  notesKept: number;
  /** Approvals answered in a terminal, by the kind of checkpoint that asked. */
  approvalsByKind: Record<string, number>;
  /** Changed-line coverage over passing runs that measured it. */
  changedCoverage: { runs: number; covered: number; total: number; runsWithoutMeasure: number };
  feedback: { helped: number; notHelped: number };
  /** Event kinds the reader counted, for the "where does this number come from" link. */
  sources: string[];
}

export interface WeekBucket { from: string; to: string; changes: number; landed: number; stopped: number; passedFirstTime: number; verified: number }

export interface ComponentRow { componentId: string; type: string; version: number; lastChangedAt: string | null }

export interface AuditChainRows {
  rows: { id: number; payload: string; timestamp: string; prev_hash: string; hash: string }[];
  checkpoint: { last_pruned_id: number; checkpoint_hash: string } | null;
}

export interface AuditRunSummary {
  at: string;
  pinningFindings: number;
  /** null when the vulnerability scan did not run (then `vulnReason` says why: not run is not the same as none found). */
  vulnFindings: number | null;
  vulnReason: string | null;
  idiomFindings: number | null;
  idiomReason: string | null;
}

export interface DependencySummary {
  /** Changes whose dependencies were looked up (the lookup is off unless PURIX_DEP_LOOKUP is set). */
  runs: number;
  namesChecked: number;
  /** Package names the registry said do not exist. */
  missing: number;
  /** Exact name and version pairs with a known advisory. */
  withAdvisories: number;
  /** Lookups that got no answer. These are "not checked", never "clean". */
  unanswered: number;
}

export interface LedgerEvent { rowid: number; id: string; timestamp: string; kind: string; componentId: string | null; operation: string | null; detail: Record<string, unknown> }

export interface Ledger {
  readonly stateDir: string;
  close(): void;
  summary(opts?: SummaryOptions): ProjectSummary;
  changes(opts?: SummaryOptions & { limit?: number }): ChangeRecord[];
  change(changeId: string): ChangeRecord | null;
  stops(opts?: SummaryOptions & { limit?: number }): StopRecord[];
  components(): ComponentRow[];
  /** The stored audit chain, as read. Pass it to verifyAuditRows (security/audit_tamper_evidence) to check it; this reader does not re-implement that rule. */
  auditChainRows(): AuditChainRows;
  eventsAfter(rowid: number, limit?: number): LedgerEvent[];
  /** The last four weeks as four buckets, oldest first, whatever range the page shows. A trend, not a score. */
  trend(now?: Date): WeekBucket[];
  maxEventRowid(): number;
  /** Everything above as plain JSON, for the export button and for recomputing a number by hand. */
  exportAll(opts?: SummaryOptions): { schemaVersion: number; summary: ProjectSummary; changes: ChangeRecord[]; stops: StopRecord[] };
}

export interface SummaryOptions { since?: string; until?: string }

type Row = Record<string, unknown>;

const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : 0);
function asChangeDependencies(d: Record<string, unknown>): ChangeDependencies {
  const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
  const mode = obj(d["mode"]), reg = obj(d["registry"]), adv = obj(d["advisories"]);
  const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null) : []);
  return {
    mode: { osv: mode["osv"] === true, registry: mode["registry"] === true },
    names: num(d["names"]),
    registry: { exists: num(reg["exists"]), missing: num(reg["missing"]), unanswered: num(reg["unanswered"]) },
    advisories: { pairs: num(adv["pairs"]), withAdvisories: num(adv["with_advisories"]), unanswered: num(adv["unanswered"]) },
    missingNames: list(d["missing_names"]).map((x) => String(x["name"] ?? "")).filter((n) => n !== ""),
    vulnerable: list(d["vulnerable"]).map((x) => ({ name: String(x["name"] ?? ""), version: String(x["version"] ?? ""), advisoryCount: num(x["advisory_count"]) })).filter((x) => x.name !== ""),
  };
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function parseDetail(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function ceilingUsd(): number {
  const raw = purixEnv("PURIX_COST_CEILING_USD");
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CEILING_USD;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

function asCounts(v: unknown): TestTotals | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const p = o["passed"], f = o["failed"], s = o["skipped"];
  return typeof p === "number" && typeof f === "number" && typeof s === "number" ? { passed: p, failed: f, skipped: s } : null;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function asCoverage(v: unknown): ChangeCoverage | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o["covered"] !== "number" || typeof o["total"] !== "number") return null;
  return {
    covered: o["covered"], total: o["total"], ratio: typeof o["ratio"] === "number" ? o["ratio"] : null,
    uncoveredFiles: num(o["uncovered_files"]), uncoveredLines: num(o["uncovered_lines"]), notMeasuredFiles: num(o["not_measured_files"]),
    why: str(o["why_not_measured"]),
  };
}

/** Opens a project's record read-only. Null when there is none, or it cannot be read. */
export function openLedger(stateDir: string): Ledger | null {
  const dbPath = join(stateDir, LEDGER_DB_FILE);
  if (!existsSync(dbPath)) return null;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 1500;");
  } catch {
    return null;
  }
  return buildLedger(db, stateDir);
}

function buildLedger(db: DatabaseSync, stateDir: string): Ledger {
  const hasTable = (name: string): boolean => {
    try {
      return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
    } catch {
      return false;
    }
  };
  const hasColumn = (table: string, column: string): boolean => {
    try {
      return (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).some((c) => c["name"] === column);
    } catch {
      return false;
    }
  };
  const all = (sql: string, ...params: (string | number)[]): Row[] => {
    try {
      return db.prepare(sql).all(...params) as Row[];
    } catch {
      return [];
    }
  };
  const one = (sql: string, ...params: (string | number)[]): Row | null => all(sql, ...params)[0] ?? null;

  const windowClause = (col: string, opts: SummaryOptions): { sql: string; params: string[] } => {
    const parts: string[] = [];
    const params: string[] = [];
    if (opts.since) { parts.push(`${col} >= ?`); params.push(opts.since); }
    if (opts.until) { parts.push(`${col} < ?`); params.push(opts.until); }
    return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", params };
  };

  const readEvents = (opts: SummaryOptions, limit: number, kinds?: readonly string[]): LedgerEvent[] => {
    if (!hasTable("events")) return [];
    const w = windowClause("timestamp", opts);
    const kindSql = kinds && kinds.length ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : "";
    const rows = all(
      `SELECT rowid AS rid, id, timestamp, kind, component_id, operation, detail FROM events WHERE 1=1${w.sql}${kindSql} ORDER BY rowid DESC LIMIT ${Math.max(1, Math.floor(limit))}`,
      ...w.params, ...(kinds ?? [])
    );
    return rows.reverse().map((r) => ({ rowid: num(r["rid"]), id: String(r["id"]), timestamp: String(r["timestamp"]), kind: String(r["kind"]), componentId: str(r["component_id"]), operation: str(r["operation"]), detail: parseDetail(r["detail"]) }));
  };

  const callsByChange = (): Map<string, { calls: number; in: number; out: number; cached: number; cost: number }> => {
    const out = new Map<string, { calls: number; in: number; out: number; cached: number; cost: number }>();
    if (!hasTable("llm_call_log") || !hasColumn("llm_call_log", "change_id")) return out;
    for (const r of all(`SELECT change_id, COUNT(*) AS n, SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(COALESCE(cached_input_tokens,0)) AS c, SUM(cost_usd) AS usd FROM llm_call_log WHERE change_id IS NOT NULL GROUP BY change_id`)) {
      out.set(String(r["change_id"]), { calls: num(r["n"]), in: num(r["i"]), out: num(r["o"]), cached: num(r["c"]), cost: num(r["usd"]) });
    }
    return out;
  };

  const assemble = (events: LedgerEvent[], opts: { onlyId?: string } = {}): ChangeRecord[] => {
    const groups = new Map<string, LedgerEvent[]>();
    for (const e of events) {
      const id = typeof e.detail["change_id"] === "string" ? (e.detail["change_id"]) : null;
      if (!id || (opts.onlyId && id !== opts.onlyId)) continue;
      const g = groups.get(id);
      if (g) g.push(e); else groups.set(id, [e]);
    }
    const calls = callsByChange();
    const out: ChangeRecord[] = [];
    for (const [changeId, evs] of groups) {
      evs.sort((a, b) => a.rowid - b.rowid);
      let component: string | null = null, operation: string | null = null, agent: string | null = null;
      let failedBeforePass: number | null = null, failures = 0, passed = false;
      let testCounts: TestTotals | null = null, verifyMs: number | null = null, isolation: string | null = null;
      const notTested = new Set<string>(), notChecked = new Set<string>();
      let advisories = 0, landedKind: string | null = null, landedVersion: number | null = null, helped: boolean | null = null;
      let changedCoverage: ChangeCoverage | null = null;
      let dependencies: ChangeDependencies | null = null;
      let waited = 0, waitSeen = false, asked = 0, approved = 0, denied = 0, pendingApproval = false;
      const stops: StopRecord[] = [];
      for (const e of evs) {
        component ??= e.componentId;
        operation ??= e.operation;
        const a = e.detail["agent_id"] ?? e.detail["agent"];
        if (typeof a === "string") agent ??= a;
        switch (e.kind) {
          case "verification_failure": failures++; break;
          case "verification_pass": {
            if (!passed) { failedBeforePass = failures; passed = true; }
            const c = asCounts(e.detail["test_counts"]);
            if (c) testCounts = c; // the last passing run is the one that landed
            if (typeof e.detail["verify_ms"] === "number") verifyMs = e.detail["verify_ms"] as number;
            if (typeof e.detail["isolation"] === "string") isolation = e.detail["isolation"] as string;
            for (const f of strList(e.detail["not_tested"])) notTested.add(f);
            for (const f of strList(e.detail["not_checked"])) notChecked.add(f);
            const adv = e.detail["security_advisories"];
            if (Array.isArray(adv)) advisories = Math.max(advisories, adv.length);
            changedCoverage = asCoverage(e.detail["changed_coverage"]) ?? changedCoverage;
            break;
          }
          case "confirm_response":
            asked++;
            if (e.detail["approved"] === true) approved++; else denied++;
            if (typeof e.detail["wait_ms"] === "number") { waited += e.detail["wait_ms"] as number; waitSeen = true; }
            break;
          case "approval_decided":
            if (typeof e.detail["wait_ms"] === "number") { waited += e.detail["wait_ms"] as number; waitSeen = true; }
            break;
          case "change_landed":
            landedKind = str(e.detail["kind"]);
            landedVersion = typeof e.detail["version"] === "number" ? (e.detail["version"] as number) : null;
            break;
          case "change_feedback":
            if (typeof e.detail["helped"] === "boolean") helped = e.detail["helped"] as boolean;
            break;
          case "dependency_lookup": dependencies = asChangeDependencies(e.detail); break; // the last run is the one for the files that landed
          default:
            if ((STOP_KIND_LIST as string[]).includes(e.kind)) {
              stops.push({ kind: e.kind as StopKind, reason: STOP_KINDS[e.kind as StopKind], at: e.timestamp, component: e.componentId, detail: e.detail });
            }
        }
        if (e.kind === "injection_flag") pendingApproval = true;
      }
      const startedAt = evs[0]!.timestamp, endedAt = evs[evs.length - 1]!.timestamp;
      const c = calls.get(changeId);
      const result: ChangeResult = landedKind ? "landed" : passed ? "verified" : stops.length > 0 && !passed ? "stopped" : failures > 0 ? "failed" : pendingApproval ? "waiting" : "unfinished";
      out.push({
        changeId, startedAt, endedAt, durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
        component, operation, agent, result, failedBeforePass, testCounts, verifyMs, isolation,
        notTested: [...notTested], notChecked: [...notChecked], securityAdvisories: advisories, stops,
        waitedForPersonMs: waitSeen ? waited : null, approvals: { asked, approved, denied },
        modelCalls: c?.calls ?? 0, tokensIn: c?.in ?? 0, tokensOut: c?.out ?? 0, tokensCached: c?.cached ?? 0, costUsd: c?.cost ?? 0,
        landedKind, landedVersion, helped, changedCoverage, dependencies,
      });
    }
    out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    return out;
  };

  const spend = (opts: SummaryOptions, landedIds: Set<string>): SpendSummary | null => {
    if (!hasTable("llm_call_log") && !hasTable("budget_state")) return null;
    const w = windowClause("created_at", opts);
    const t = hasTable("llm_call_log")
      ? one(`SELECT COUNT(*) AS n, SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS bad, SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(COALESCE(cached_input_tokens,0)) AS c, SUM(cost_usd) AS usd FROM llm_call_log WHERE 1=1${w.sql}`, ...w.params)
      : null;
    const budget = hasTable("budget_state") ? one(`SELECT SUM(total_spent_usd) AS spent FROM budget_state`) : null;
    const ceiling = ceilingUsd();
    const spent = budget ? num(budget["spent"]) : num(t?.["usd"]);
    const byModel = hasTable("llm_call_log")
      ? all(`SELECT provider, model, COUNT(*) AS n, SUM(cost_usd) AS usd, SUM(input_tokens) AS i, SUM(output_tokens) AS o FROM llm_call_log WHERE 1=1${w.sql} GROUP BY provider, model ORDER BY usd DESC`, ...w.params)
          .map((r) => ({ provider: String(r["provider"]), model: String(r["model"]), calls: num(r["n"]), costUsd: num(r["usd"]), tokensIn: num(r["i"]), tokensOut: num(r["o"]) }))
      : [];
    const byCallType = hasTable("llm_call_log")
      ? all(`SELECT call_type, COUNT(*) AS n, SUM(cost_usd) AS usd FROM llm_call_log WHERE 1=1${w.sql} GROUP BY call_type ORDER BY usd DESC`, ...w.params)
          .map((r) => ({ callType: String(r["call_type"]), calls: num(r["n"]), costUsd: num(r["usd"]) }))
      : [];
    let unlanded: number | null = null;
    if (hasTable("llm_call_log") && hasColumn("llm_call_log", "change_id")) {
      const per = callsByChange();
      if (per.size > 0) { unlanded = 0; for (const [id, v] of per) if (!landedIds.has(id)) unlanded += v.cost; }
    }
    return {
      modelTierSavingUsd: hasTable("savings_ledger") ? num(one(`SELECT SUM(delta_usd) AS d FROM savings_ledger WHERE 1=1${windowClause("created_at", opts).sql}`, ...windowClause("created_at", opts).params)?.["d"]) : null,
      spentUsd: spent, ceilingUsd: ceiling, leftUsd: Math.max(0, ceiling - spent), calls: num(t?.["n"]), failedCalls: num(t?.["bad"]),
      tokensIn: num(t?.["i"]), tokensOut: num(t?.["o"]), tokensCached: num(t?.["c"]), costOfUnlandedUsd: unlanded, byModel, byCallType,
    };
  };

  const summary = (opts: SummaryOptions = {}): ProjectSummary => {
    const w = windowClause("timestamp", opts);
    const kindCounts: Record<string, number> = {};
    if (hasTable("events")) for (const r of all(`SELECT kind, COUNT(*) AS n FROM events WHERE 1=1${w.sql} GROUP BY kind`, ...w.params)) kindCounts[String(r["kind"])] = num(r["n"]);
    const events = readEvents(opts, TIMELINE_EVENT_LIMIT);
    const changes = assemble(events);
    const landedIds = new Set(changes.filter((c) => c.result === "landed").map((c) => c.changeId));

    const byKind: Record<string, number> = {};
    let stoppedTotal = 0;
    for (const k of STOP_KIND_LIST) { const n = kindCounts[k] ?? 0; if (n > 0) byKind[k] = n; stoppedTotal += n; }

    const totals: TestTotals = { passed: 0, failed: 0, skipped: 0 };
    let withCounts = 0, withoutCounts = 0, notTestedFiles = 0, notCheckedFiles = 0, advisoryTotal = 0;
    const isolation: Record<string, number> = {};
    const agents: Record<string, number> = {};
    const waits: number[] = [];
    let asked = 0, approved = 0, denied = 0, helped = 0, notHelped = 0;
    const repairs = { escalations: 0, outcomes: {} as Record<string, number>, compileRetries: 0, earlyStops: 0 };
    const approvalsByKind: Record<string, number> = {};
    const cov = { runs: 0, covered: 0, total: 0, runsWithoutMeasure: 0 };
    const secrets = { outbound: 0, inbound: 0, byFormat: {} as Record<string, number> };
    const rolled = { total: 0, undoFailed: 0 };
    const deps: DependencySummary = { runs: 0, namesChecked: 0, missing: 0, withAdvisories: 0, unanswered: 0 };
    let lastAudit: AuditRunSummary | null = null, auditRuns = 0;
    for (const e of events) {
      if (e.kind === "secrets_scrubbed") {
        const n = typeof e.detail["count"] === "number" ? (e.detail["count"] as number) : 0;
        if (e.detail["direction"] === "inbound") secrets.inbound += n; else secrets.outbound += n;
        const f = e.detail["formats"];
        if (f && typeof f === "object") for (const [k, v] of Object.entries(f as Record<string, unknown>)) if (typeof v === "number") secrets.byFormat[k] = (secrets.byFormat[k] ?? 0) + v;
      } else if (e.kind === "apply_rolled_back") {
        rolled.total++; if (e.detail["rollback_failed"] === true) rolled.undoFailed++;
      } else if (e.kind === "dependency_lookup") {
        deps.runs++;
        deps.namesChecked += num(e.detail["names"]);
        const reg = e.detail["registry"] as Record<string, unknown> | undefined, adv = e.detail["advisories"] as Record<string, unknown> | undefined;
        deps.missing += num(reg?.["missing"]); deps.withAdvisories += num(adv?.["with_advisories"]);
        deps.unanswered += num(reg?.["unanswered"]) + num(adv?.["unanswered"]);
      } else if (e.kind === "audit_run") {
        auditRuns++;
        const v = (e.detail["vuln"] ?? {}) as Record<string, unknown>, i = (e.detail["idiom"] ?? {}) as Record<string, unknown>;
        lastAudit = {
          at: e.timestamp, pinningFindings: num(e.detail["pinning_findings"]),
          vulnFindings: v["ran"] === true ? num(v["findings"]) : null, vulnReason: v["ran"] === true ? null : str(v["reason"]) ?? "did not run",
          idiomFindings: i["ran"] === true ? num(i["findings"]) : null, idiomReason: i["ran"] === true ? null : str(i["reason"]) ?? "did not run",
        };
      }
      if (e.kind === "escalation_start") repairs.escalations++;
      else if (e.kind === "escalation_outcome") { const o = str(e.detail["outcome"]) ?? "unknown"; repairs.outcomes[o] = (repairs.outcomes[o] ?? 0) + 1; }
      else if (e.kind === "compile_retry") repairs.compileRetries++;
      else if (e.kind === "repair_early_stop") repairs.earlyStops++;
      if (e.kind === "verification_pass") {
        const cc = asCoverage(e.detail["changed_coverage"]);
        if (cc && cc.total > 0) { cov.runs++; cov.covered += cc.covered; cov.total += cc.total; } else cov.runsWithoutMeasure++;
        const c = asCounts(e.detail["test_counts"]);
        if (c) { totals.passed += c.passed; totals.failed += c.failed; totals.skipped += c.skipped; withCounts++; } else withoutCounts++;
        const iso = str(e.detail["isolation"]); if (iso) isolation[iso] = (isolation[iso] ?? 0) + 1;
        notTestedFiles += strList(e.detail["not_tested"]).length;
        notCheckedFiles += strList(e.detail["not_checked"]).length;
        const adv = e.detail["security_advisories"]; if (Array.isArray(adv)) advisoryTotal += adv.length;
      } else if (e.kind === "confirm_response") {
        // A terminal prompt answered in place. Approvals an agent asked for are counted from the audit chain below.
        asked++; if (e.detail["approved"] === true) approved++; else denied++;
        if (typeof e.detail["wait_ms"] === "number") waits.push(e.detail["wait_ms"] as number);
        const k = str(e.detail["checkpoint_kind"]) ?? "unnamed"; approvalsByKind[k] = (approvalsByKind[k] ?? 0) + 1;
      } else if (e.kind === "change_feedback") {
        if (e.detail["helped"] === true) helped++; else if (e.detail["helped"] === false) notHelped++;
      }
      const a = e.detail["agent_id"] ?? e.detail["agent"];
      if (typeof a === "string" && e.kind === "confirm_response") agents[a] = (agents[a] ?? 0) + 1;
    }
    const landedByAgent: Record<string, number> = {};
    for (const c of changes) if (c.agent) { agents[c.agent] ??= 0; if (c.result === "landed") landedByAgent[c.agent] = (landedByAgent[c.agent] ?? 0) + 1; }

    // Approvals an agent asked for: the audit chain keeps a request and a decision record for each, with times, long after the
    // approval files are deleted, so the chain is the source (approvals/wait_times.ts). Unanswered requests have no wait, never zero.
    const chainRows = hasTable("audit_chain") ? all(`SELECT payload, timestamp FROM audit_chain ORDER BY id ASC`).map((r) => ({ payload: String(r["payload"]), timestamp: String(r["timestamp"]) })) : [];
    const inRange = chainRows.filter((r) => (!opts.since || r.timestamp >= opts.since) && (!opts.until || r.timestamp < opts.until));
    const chainWaits = approvalWaitTimes(inRange);
    const chainSummary = summarizeApprovalWaits(chainWaits);
    asked += chainSummary.requested; approved += chainSummary.approved; denied += chainSummary.denied;
    for (const w of chainWaits) if (w.waitMs !== undefined) waits.push(w.waitMs);
    const verified = changes.filter((c) => c.failedBeforePass !== null);
    const landedChain = hasTable("audit_chain") ? num(one(`SELECT COUNT(*) AS n FROM audit_chain WHERE payload LIKE '%"event":"component_change"%'`)?.["n"]) : 0;
    const manifestRows = hasTable("manifest") ? num(one(`SELECT COUNT(*) AS n FROM manifest WHERE component_id != 'purix-codebase-index'`)?.["n"]) : null;

    return {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      range: { from: opts.since ?? null, to: opts.until ?? null },
      firstEventAt: hasTable("events") ? str(one("SELECT MIN(timestamp) AS t FROM events")?.["t"]) ?? null : null,
      components: manifestRows,
      changesLanded: landedChain,
      changesLandedInRange: kindCounts["change_landed"] ?? 0,
      changesWithId: changes.length,
      verificationPasses: kindCounts["verification_pass"] ?? 0,
      verificationFailures: kindCounts["verification_failure"] ?? 0,
      firstAttemptPass: { passed: verified.filter((c) => c.failedBeforePass === 0).length, of: verified.length },
      stopped: { total: stoppedTotal, byKind, gateEvaluations: kindCounts["gate_evaluation"] ?? 0 },
      tests: { totals, verificationsWithCounts: withCounts, verificationsWithoutCounts: withoutCounts },
      approvals: { asked, approved, denied, medianWaitMs: median(waits), waitsRecorded: waits.length },
      spend: spend(opts, landedIds),
      isolation, notTestedFiles, notCheckedFiles,
      unadoptedWrites: kindCounts["unadopted_write"] ?? 0,
      hookDenials: kindCounts["hook_denied"] ?? 0,
      securityAdvisories: advisoryTotal,
      rework: reworkWithin(chainRows, new Date()),
      secretsRemoved: secrets, rolledBack: rolled, dependencies: deps, lastAudit, auditRuns,
      agents, landedByAgent, repairs,
      reuse: { libraryHits: repairs.outcomes["library_hit"] ?? 0, escalations: repairs.escalations },
      driftAccepted: kindCounts["reconciliation"] ?? 0,
      notesKept: kindCounts["memory_recorded"] ?? 0,
      approvalsByKind, changedCoverage: cov,
      feedback: { helped, notHelped },
      sources: ["events", "llm_call_log", "budget_state", "audit_chain", "manifest"],
    };
  };

  const changes = (opts: SummaryOptions & { limit?: number } = {}): ChangeRecord[] => {
    const list = assemble(readEvents(opts, TIMELINE_EVENT_LIMIT));
    const limit = opts.limit && opts.limit > 0 ? opts.limit : list.length;
    return list.slice(-limit).reverse();
  };

  const stops = (opts: SummaryOptions & { limit?: number } = {}): StopRecord[] => {
    const evs = readEvents(opts, opts.limit ?? 500, STOP_KIND_LIST);
    return evs.map((e) => ({ kind: e.kind as StopKind, reason: STOP_KINDS[e.kind as StopKind], at: e.timestamp, component: e.componentId, detail: e.detail })).reverse();
  };

  return {
    stateDir,
    close: () => { try { db.close(); } catch { /* already closed */ } },
    summary,
    changes,
    change: (changeId) => assemble(readEvents({}, TIMELINE_EVENT_LIMIT), { onlyId: changeId })[0] ?? null,
    stops,
    components: () => {
      if (!hasTable("manifest")) return [];
      return all(`SELECT component_id, data FROM manifest WHERE component_id != 'purix-codebase-index' ORDER BY component_id`).map((r) => {
        const d = parseDetail(r["data"]);
        const hist = Array.isArray(d["version_history"]) ? (d["version_history"] as Record<string, unknown>[]) : [];
        const last = hist.length > 0 ? str(hist[hist.length - 1]?.["timestamp"]) : null;
        return { componentId: String(r["component_id"]), type: str(d["component_type"]) ?? "unknown", version: typeof d["current_version"] === "number" ? (d["current_version"] as number) : 0, lastChangedAt: last };
      });
    },
    auditChainRows: () => ({
      rows: hasTable("audit_chain") ? all(`SELECT id, payload, timestamp, prev_hash, hash FROM audit_chain ORDER BY id ASC`).map((r) => ({ id: num(r["id"]), payload: String(r["payload"]), timestamp: String(r["timestamp"]), prev_hash: String(r["prev_hash"]), hash: String(r["hash"]) })) : [],
      checkpoint: hasTable("audit_checkpoints") ? (() => { const c = one(`SELECT last_pruned_id, checkpoint_hash FROM audit_checkpoints ORDER BY id DESC LIMIT 1`); return c ? { last_pruned_id: num(c["last_pruned_id"]), checkpoint_hash: String(c["checkpoint_hash"]) } : null; })() : null,
    }),
    eventsAfter: (rowid, limit = 200) => {
      if (!hasTable("events")) return [];
      return all(`SELECT rowid AS rid, id, timestamp, kind, component_id, operation, detail FROM events WHERE rowid > ? ORDER BY rowid ASC LIMIT ${Math.max(1, Math.floor(limit))}`, rowid)
        .map((r) => ({ rowid: num(r["rid"]), id: String(r["id"]), timestamp: String(r["timestamp"]), kind: String(r["kind"]), componentId: str(r["component_id"]), operation: str(r["operation"]), detail: parseDetail(r["detail"]) }));
    },
    trend: (now = new Date()) => {
      const weekMs = 7 * 86_400_000;
      const start = now.getTime() - 4 * weekMs;
      const evs = readEvents({ since: new Date(start).toISOString() }, TIMELINE_EVENT_LIMIT);
      const list = assemble(evs);
      const buckets: WeekBucket[] = [0, 1, 2, 3].map((i) => ({ from: new Date(start + i * weekMs).toISOString(), to: new Date(start + (i + 1) * weekMs).toISOString(), changes: 0, landed: 0, stopped: 0, passedFirstTime: 0, verified: 0 }));
      const at = (iso: string) => Math.min(3, Math.max(0, Math.floor((Date.parse(iso) - start) / weekMs)));
      for (const c of list) {
        const b = buckets[at(c.startedAt)]!;
        b.changes++;
        if (c.result === "landed") b.landed++;
        if (c.failedBeforePass !== null) { b.verified++; if (c.failedBeforePass === 0) b.passedFirstTime++; }
      }
      for (const e of evs) if ((STOP_KIND_LIST as string[]).includes(e.kind)) buckets[at(e.timestamp)]!.stopped++;
      return buckets;
    },
    maxEventRowid: () => (hasTable("events") ? num(one("SELECT MAX(rowid) AS m FROM events")?.["m"]) : 0),
    exportAll: (opts = {}) => ({ schemaVersion: LEDGER_SCHEMA_VERSION, summary: summary(opts), changes: changes(opts), stops: stops(opts) }),
  };
}
