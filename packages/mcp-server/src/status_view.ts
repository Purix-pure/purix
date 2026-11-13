// packages/mcp-server/src/status_view.ts
//
// AI-14 (PURIX-33): short, bounded views of `purix_status` and `purix_audit_trail` for an agent.
//
// The full views dump every component (or every landed commit) as JSON or markdown. On a project with a hundred
// components that is tens of thousands of tokens spent on text an agent mostly does not need. The concise view says what
// needs attention first and stops at a fixed budget, naming the call that returns the rest.
//
// Pure functions only: the handler in server.ts does the file reads and passes in what was found.
import { estimateTokens } from "@purix/core/llm/context/tokens";
import type { ManifestEntry } from "@purix/core/manifest/schema";
import type { AuditTrailReport } from "@purix/core/manifest/audit_export";
import { isTestFilePath } from "@purix/core/verify/test_integrity";
import { isPythonTestFilePath } from "@purix/core/verify/python_test_integrity";

/** Largest estimated size of a concise view. The plan's cap is 500; this leaves room for the last line and the notice. */
export const CONCISE_MAX_TOKENS = 500;
/** Soft target the list stops at, so the closing notice still fits under CONCISE_MAX_TOKENS. */
const LIST_TOKEN_LIMIT = 430;

export type DetailLevel = "concise" | "full";

/** The single place the `detail` argument is read. Returns an error message (naming the field and the next call) for a bad value. */
export function parseDetail(raw: unknown, tool: "purix_status" | "purix_audit_trail"): { ok: true; detail: DetailLevel } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, detail: "concise" };
  if (raw === "concise" || raw === "full") return { ok: true, detail: raw };
  return {
    ok: false,
    message: `Refused: "detail" must be "concise" or "full" (got ${JSON.stringify(typeof raw === "string" ? raw.slice(0, 30) : typeof raw)}). Call ${tool} again with detail set to one of those two values, or leave it out for "concise".`,
  };
}

const INDEX_ROW_ID = "purix-codebase-index";

/** True when a component has no test file among its tracked files. */
export function hasNoTestFile(entry: ManifestEntry): boolean {
  return !(entry.files ?? []).some((p) => isTestFilePath(p) || isPythonTestFilePath(p));
}

export interface StatusProbe {
  entry: ManifestEntry;
  /** The files on disk no longer hash to the stored baseline. */
  drifted: boolean;
}

function lastChange(entry: ManifestEntry): { v: number; op: string; at: string } | null {
  const h = entry.version_history ?? [];
  if (h.length === 0) return null;
  let last = h[0]!;
  for (const x of h) if (x.timestamp > last.timestamp || (x.timestamp === last.timestamp && x.version > last.version)) last = x;
  return { v: last.version, op: last.operation, at: last.timestamp.slice(0, 10) };
}

/** Lower sorts first: failing components, then drift, then unverified, then missing tests. */
function attentionRank(p: StatusProbe): number {
  if (p.entry.verification_status === "fail") return 0;
  if (p.drifted) return 1;
  if (p.entry.verification_status === "pending") return 2;
  return 3;
}

function needsAttention(p: StatusProbe): boolean {
  return p.entry.verification_status !== "pass" || p.drifted || hasNoTestFile(p.entry);
}

/**
 * Counts, then the components that need attention (worst first, then most recently changed), each with its last change.
 * Stops at a token budget and says how many were left out and which call returns them.
 */
export function buildConciseStatus(probes: StatusProbe[]): string {
  const comps = probes.filter((p) => p.entry.component_id !== INDEX_ROW_ID);
  if (comps.length === 0) return "No components are registered yet. Next: purix_index to index the codebase, or purix_create to start a component.";

  const by = { pass: 0, fail: 0, pending: 0 };
  for (const p of comps) by[p.entry.verification_status] = (by[p.entry.verification_status] ?? 0) + 1;
  const drifted = comps.filter((p) => p.drifted).length;
  const noTests = comps.filter((p) => hasNoTestFile(p.entry)).length;

  const head = `Purix status (concise): ${comps.length} components. pass ${by.pass}, fail ${by.fail}, pending ${by.pending}. Drifted ${drifted}. No test file ${noTests}.`;

  const attention = comps.filter(needsAttention).sort((a, b) => {
    const r = attentionRank(a) - attentionRank(b);
    if (r !== 0) return r;
    const la = lastChange(a.entry)?.at ?? "";
    const lb = lastChange(b.entry)?.at ?? "";
    if (la !== lb) return la < lb ? 1 : -1;
    return a.entry.component_id.localeCompare(b.entry.component_id);
  });

  if (attention.length === 0) {
    const newest = comps.map((p) => ({ id: p.entry.component_id, c: lastChange(p.entry) })).filter((x) => x.c).sort((a, b) => (a.c!.at < b.c!.at ? 1 : -1))[0];
    return `${head}\nNothing needs attention.${newest ? ` Latest change: ${newest.id} v${newest.c!.v} ${newest.c!.op} ${newest.c!.at}.` : ""}`;
  }

  const lines: string[] = [];
  let shown = 0;
  let used = estimateTokens(head) + 12;
  for (const p of attention) {
    const flags: string[] = [];
    if (p.entry.verification_status !== "pass") flags.push(p.entry.verification_status);
    if (p.drifted) flags.push("drift");
    if (hasNoTestFile(p.entry)) flags.push("no tests");
    const c = lastChange(p.entry);
    const line = `- ${p.entry.component_id.slice(0, 60)}: ${flags.join(", ")}; last ${c ? `v${c.v} ${c.op.slice(0, 24)} ${c.at}` : "no change recorded"}`;
    const cost = estimateTokens(line) + 1;
    if (used + cost > LIST_TOKEN_LIMIT) break;
    lines.push(line);
    used += cost;
    shown++;
  }

  const rest = attention.length - shown;
  const tail =
    rest > 0
      ? `${rest} more not shown. Call purix_status with detail "full" for every component, or purix_find to look one up.`
      : `Call purix_status with detail "full" for every component.`;
  return [head, `Needs attention (${shown} of ${attention.length}):`, ...lines, tail].join("\n");
}

/** Short audit summary: totals, then the newest landed commits, one line each, within the same budget. */
export function buildConciseAuditTrail(report: AuditTrailReport): { text: string; json: Record<string, unknown> } {
  const entries = report.entries;
  const components = new Set(entries.map((e) => e.component_id)).size;
  const contract = entries.filter((e) => e.contract_changed).length;
  const escalated = entries.filter((e) => e.gate_evidence.escalation_involved).length;
  const declined = entries.reduce((n, e) => n + e.gate_evidence.approvals.filter((a) => !a.approved).length, 0);
  const noApproval = entries.filter((e) => e.gate_evidence.approvals.length === 0).length;

  const scope = [report.component_filter ? `component ${report.component_filter}` : null, report.since ? `since ${report.since}` : null].filter(Boolean).join(", ");
  const head = `Purix audit trail (concise${scope ? `; ${scope}` : ""}): ${entries.length} landed commits across ${components} components. Contract-changing ${contract}. Escalated ${escalated}. Declined approvals ${declined}. With no recorded approval ${noApproval}.`;

  const newest = [...entries].sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  const lines: string[] = [];
  let used = estimateTokens(head) + estimateTokens(report.note) + 12;
  for (const e of newest) {
    const src = e.provenance.source_agent ? `${e.provenance.source_type}/${e.provenance.source_agent.slice(0, 20)}` : e.provenance.source_type;
    const conf = e.gate_evidence.confidence !== null ? ` conf ${e.gate_evidence.confidence.toFixed(2)}` : "";
    const line = `- ${e.timestamp.slice(0, 16)} ${e.component_id.slice(0, 50)} v${e.version} ${e.operation.slice(0, 24)} ${src}${conf}`;
    const cost = estimateTokens(line) + 1;
    if (used + cost > LIST_TOKEN_LIMIT) break;
    lines.push(line);
    used += cost;
  }
  const rest = entries.length - lines.length;
  const tail = rest > 0
    ? `${rest} older commits not shown. Call purix_audit_trail with detail "full" for every row, or add componentId or since to narrow it.`
    : `Call purix_audit_trail with detail "full" for the evidence behind each commit.`;
  const text = [head, ...(lines.length ? ["Newest first:", ...lines] : ["No matching landed commits."]), tail, report.note].join("\n");
  return {
    text,
    json: {
      detail: "concise",
      generated_at: report.generated_at,
      component_filter: report.component_filter,
      since: report.since,
      totals: { commits: entries.length, components, contract_changing: contract, escalated, declined_approvals: declined, without_recorded_approval: noApproval },
      newest: newest.slice(0, lines.length).map((e) => ({ timestamp: e.timestamp, component_id: e.component_id, version: e.version, operation: e.operation, confidence: e.gate_evidence.confidence })),
      not_shown: rest,
      next: rest > 0 ? 'Call purix_audit_trail again with detail "full", or narrow with componentId or since.' : 'Call purix_audit_trail with detail "full" for the evidence behind each commit.',
    },
  };
}
