// src/manifest/audit_export.ts
import { listManifest } from "./store.js";
import { listEvents } from "./events.js";
import type { Provenance } from "./schema.js";
import { getOverrideAudits, type OverrideAuditEntry } from "../security/override_audit.js";

export interface AuditGateEvidence {
  confidence: number | null;
  contract_changing_reported: boolean | null;
  test_integrity_flagged: boolean;
  coverage_flagged: boolean;
  escalation_involved: boolean;
  approvals: { checkpoint_kind: string; approved: boolean; timestamp: string }[];
  /** Gate overrides a person recorded in this version's window. Overrides carry no component id, so this is by time, not by component. */
  overrides: { gate_name: string; reason: string; actor: string; finding: string; timestamp: string }[];
}

export interface AuditTrailEntry {
  component_id: string;
  version: number;
  operation: string;
  patch_ref: string;
  contract_changed: boolean;
  timestamp: string;
  provenance: Provenance;
  gate_evidence: AuditGateEvidence;
}

export interface AuditTrailReport {
  generated_at: string;
  component_filter: string | null;
  since: string | null;
  entries: AuditTrailEntry[];
  /** Overrides recorded at a time no listed version's window holds (for example an override whose change did not land, or a --since/--component filter that left out the version). */
  overrides_not_attached: OverrideAuditEntry[];
  note: string;
}

const EPOCH = "1970-01-01T00:00:00.000Z";
const SCOPE_NOTE =
  "Covers landed commits only (real version_history entries). Aborted or human-declined attempts aren't stitched in here — see 'purix stats' for rejection/decline rates. Gate overrides are listed under the version whose time window holds them, or separately when none does.";

function gatherGateEvidence(componentId: string, windowStart: string, windowEnd: string, overrides: OverrideAuditEntry[]): AuditGateEvidence {
  const windowEvents = listEvents({ componentId }).filter((e) => e.timestamp > windowStart && e.timestamp <= windowEnd);
  const classificationEvents = windowEvents.filter((e) => e.kind === "classification");
  const lastClassification = classificationEvents[classificationEvents.length - 1];

  const approvals = windowEvents
    .filter((e) => e.kind === "confirm_response")
    .map((e) => ({
      checkpoint_kind: typeof e.detail.checkpoint_kind === "string" ? e.detail.checkpoint_kind : "(unspecified)",
      approved: e.detail.approved === true,
      timestamp: e.timestamp,
    }));

  return {
    confidence: typeof lastClassification?.detail.confidence === "number" ? lastClassification.detail.confidence : null,
    contract_changing_reported:
      typeof lastClassification?.detail.contract_changing === "boolean" ? lastClassification.detail.contract_changing : null,
    test_integrity_flagged: windowEvents.some((e) => e.kind === "test_integrity_flag"),
    coverage_flagged: windowEvents.some((e) => e.kind === "coverage_gate_flag"),
    escalation_involved: windowEvents.some((e) => e.kind === "escalation_start"),
    approvals,
    overrides: overrides
      .filter((o) => o.timestamp > windowStart && o.timestamp <= windowEnd)
      .map((o) => ({ gate_name: o.gate_name, reason: o.reason, actor: o.actor, finding: o.finding, timestamp: o.timestamp })),
  };
}

export function buildAuditTrail(opts: { componentId?: string; since?: string } = {}): AuditTrailReport {
  const all = listManifest();
  const filtered = opts.componentId ? all.filter((e) => e.component_id === opts.componentId) : all;

  const overrides = getOverrideAudits();
  const attached = new Set<string>();
  const entries: AuditTrailEntry[] = [];
  for (const entry of filtered) {
    const history = [...entry.version_history].sort((a, b) => a.version - b.version);
    for (let i = 0; i < history.length; i++) {
      const v = history[i]!;
      if (opts.since && v.timestamp < opts.since) continue;
      const windowStart = i > 0 ? history[i - 1]!.timestamp : EPOCH;
      entries.push({
        component_id: entry.component_id,
        version: v.version,
        operation: v.operation,
        patch_ref: v.patch_ref,
        contract_changed: v.contract_changed,
        timestamp: v.timestamp,
        provenance: v.provenance,
        gate_evidence: gatherGateEvidence(entry.component_id, windowStart, v.timestamp, overrides),
      });
      for (const o of overrides) if (o.timestamp > windowStart && o.timestamp <= v.timestamp) attached.add(o.id);
    }
  }

  entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return {
    generated_at: new Date().toISOString(),
    component_filter: opts.componentId ?? null,
    since: opts.since ?? null,
    entries,
    overrides_not_attached: overrides.filter((o) => !attached.has(o.id) && (!opts.since || o.timestamp >= opts.since)),
    note: SCOPE_NOTE,
  };
}

export function formatAuditTrailJson(report: AuditTrailReport): string {
  return JSON.stringify(report, null, 2);
}

export function formatAuditTrailMarkdown(report: AuditTrailReport): string {
  const lines: string[] = [];
  lines.push(`# Purix Audit Trail`);
  lines.push("");
  lines.push(`Generated: ${report.generated_at}`);
  if (report.component_filter) lines.push(`Component: ${report.component_filter}`);
  if (report.since) lines.push(`Since: ${report.since}`);
  lines.push(`Entries: ${report.entries.length}`);
  lines.push("");
  lines.push(`> ${report.note}`);
  lines.push("");

  const unattached = (): void => {
    if (report.overrides_not_attached.length === 0) return;
    lines.push(`## Overrides not tied to a landed version`);
    lines.push("");
    for (const o of report.overrides_not_attached) lines.push(`- ${o.gate_name} (${o.timestamp}, ${o.actor}): ${o.reason} — ${o.finding}`);
    lines.push("");
  };

  if (report.entries.length === 0) {
    lines.push(`No matching version history entries.`);
    lines.push("");
    unattached();
    return lines.join("\n");
  }

  for (const e of report.entries) {
    lines.push(`## ${e.component_id} — v${e.version} (${e.operation})`);
    lines.push("");
    lines.push(`- Timestamp: ${e.timestamp}`);
    lines.push(`- Patch ref: ${e.patch_ref}`);
    lines.push(`- Contract-changing (as committed): ${e.contract_changed}`);
    lines.push(`- Source: ${e.provenance.source_type}${e.provenance.source_agent ? ` (${e.provenance.source_agent})` : ""}`);

    const g = e.gate_evidence;
    lines.push(
      `- Classifier confidence: ${g.confidence !== null ? g.confidence.toFixed(2) : "n/a — no classification event in this window"}`
    );
    if (g.contract_changing_reported !== null) {
      lines.push(`- Contract-changing (as reported by the classifier): ${g.contract_changing_reported}`);
    }
    lines.push(`- Test-integrity flagged (§6.4): ${g.test_integrity_flagged}`);
    lines.push(`- Zero test coverage flagged (§6.2): ${g.coverage_flagged}`);
    lines.push(`- Escalation involved (§6.3): ${g.escalation_involved}`);
    if (g.approvals.length === 0) {
      lines.push(`- Human approvals in this window: none recorded`);
    } else {
      lines.push(`- Human approvals:`);
      for (const a of g.approvals) {
        lines.push(`  - ${a.checkpoint_kind}: ${a.approved ? "approved" : "declined"} (${a.timestamp})`);
      }
    }
    if (g.overrides.length === 0) {
      lines.push(`- Overrides in this window: none recorded`);
    } else {
      lines.push(`- Overrides in this window (by time; an override has no component id):`);
      for (const o of g.overrides) lines.push(`  - ${o.gate_name} (${o.timestamp}, ${o.actor}): ${o.reason} — ${o.finding}`);
    }
    lines.push("");
  }

  unattached();
  return lines.join("\n");
}