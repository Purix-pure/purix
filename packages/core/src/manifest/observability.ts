// src/manifest/observability.ts
import { listEvents, type EventRecord } from "./events.js";
import { listLibrary } from "./library.js";

const MIN_SAMPLES_FOR_TREND = 6;
const APPROVAL_FATIGUE_MIN_SAMPLES = 10;
const APPROVAL_FATIGUE_RATE_THRESHOLD = 0.95;

export interface RateWithSample {
  rate: number | null;
  count: number;
  total: number;
}

export interface ConfidenceTrend {
  recentAvg: number;
  priorAvg: number;
  recentCount: number;
  priorCount: number;
  direction: "up" | "down" | "flat";
}

export interface ComponentFailureCount {
  key: string;
  count: number;
}

export interface ApprovalStat {
  checkpointKind: string;
  approved: number;
  declined: number;
  rate: number;
}

export interface LibraryGrowthWeek {
  weekStart: string;
  count: number;
}

export interface ObservabilityReport {
  totalRequests: number;
  escalation: RateWithSample;
  verificationFailureClusters: ComponentFailureCount[];
  confidenceTrend: ConfidenceTrend | null;
  reconciliationCount: number;
  approvalStats: ApprovalStat[];
  approvalFatigueWarnings: string[];
  idiomFindingRate: RateWithSample;
  // §10: "test-integrity flag rate, tracked separately from the
  // coverage-gate rate — different failure signatures, and conflating
  // them hides which one is actually driving human-review load." Both
  // share gate_evaluation as their denominator, since both gates only
  // ever run as part of the same TrustGate pass.
  testIntegrityFlagRate: RateWithSample;
  coverageGateFlagRate: RateWithSample;
  libraryGrowth: { totalPromoted: number; weeks: LibraryGrowthWeek[] };
}

function startOfWeek(iso: string): string {
  const d = new Date(iso);
  const day = d.getUTCDay();
  const diff = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function avg(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function computeConfidenceTrend(classificationEvents: EventRecord[]): ConfidenceTrend | null {
  const confidences = classificationEvents
    .map((e) => e.detail.confidence)
    .filter((c): c is number => typeof c === "number");
  if (confidences.length < MIN_SAMPLES_FOR_TREND) return null;

  const mid = Math.floor(confidences.length / 2);
  const prior = confidences.slice(0, mid);
  const recent = confidences.slice(mid);
  const priorAvg = avg(prior);
  const recentAvg = avg(recent);
  const delta = recentAvg - priorAvg;
  const direction: ConfidenceTrend["direction"] = Math.abs(delta) < 0.02 ? "flat" : delta < 0 ? "down" : "up";

  return { recentAvg, priorAvg, recentCount: recent.length, priorCount: prior.length, direction };
}

function computeVerificationFailureClusters(failureEvents: EventRecord[]): ComponentFailureCount[] {
  const counts = new Map<string, number>();
  for (const e of failureEvents) {
    const key = `${e.component_id ?? "(unknown)"}:${e.operation ?? "(unknown)"}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
}

function computeApprovalStats(confirmEvents: EventRecord[]): { stats: ApprovalStat[]; warnings: string[] } {
  const byKind = new Map<string, { approved: number; declined: number }>();
  for (const e of confirmEvents) {
    const kind = typeof e.detail.checkpoint_kind === "string" ? e.detail.checkpoint_kind : "(unspecified)";
    const bucket = byKind.get(kind) ?? { approved: 0, declined: 0 };
    if (e.detail.approved) bucket.approved += 1;
    else bucket.declined += 1;
    byKind.set(kind, bucket);
  }

  const stats: ApprovalStat[] = [...byKind.entries()].map(([checkpointKind, b]) => ({
    checkpointKind,
    approved: b.approved,
    declined: b.declined,
    rate: b.approved + b.declined === 0 ? 0 : b.approved / (b.approved + b.declined),
  }));

  const warnings: string[] = [];
  for (const s of stats) {
    const total = s.approved + s.declined;
    if (total >= APPROVAL_FATIGUE_MIN_SAMPLES && s.rate >= APPROVAL_FATIGUE_RATE_THRESHOLD) {
      warnings.push(
        `"${s.checkpointKind}" checkpoints are approved ${(s.rate * 100).toFixed(0)}% of the time across ${total} samples — ` +
          `§7.5's approval-fatigue risk, not evidence the checkpoint is well-tuned. Worth a sampling audit.`
      );
    }
  }

  return { stats, warnings };
}

function computeLibraryGrowth(): { totalPromoted: number; weeks: LibraryGrowthWeek[] } {
  const entries = listLibrary();
  const byWeek = new Map<string, number>();
  for (const e of entries) {
    const week = startOfWeek(e.promoted_at);
    byWeek.set(week, (byWeek.get(week) ?? 0) + 1);
  }
  const weeks = [...byWeek.entries()]
    .map(([weekStart, count]) => ({ weekStart, count }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  return { totalPromoted: entries.length, weeks };
}

function computeRate(numeratorEvents: EventRecord[], denominatorEvents: EventRecord[]): RateWithSample {
  return {
    rate: denominatorEvents.length > 0 ? numeratorEvents.length / denominatorEvents.length : null,
    count: numeratorEvents.length,
    total: denominatorEvents.length,
  };
}

export function buildObservabilityReport(): ObservabilityReport {
  const requestEvents = listEvents({ kind: "request" });
  const escalationEvents = listEvents({ kind: "escalation_start" });
  const failureEvents = listEvents({ kind: "verification_failure" });
  const idiomEvents = listEvents({ kind: "idiom_findings" });
  const classificationEvents = listEvents({ kind: "classification" });
  const confirmEvents = listEvents({ kind: "confirm_response" });
  const reconciliationEvents = listEvents({ kind: "reconciliation" });
  const gateEvaluationEvents = listEvents({ kind: "gate_evaluation" });
  const testIntegrityFlagEvents = listEvents({ kind: "test_integrity_flag" });
  const coverageGateFlagEvents = listEvents({ kind: "coverage_gate_flag" });

  const totalRequests = requestEvents.length;
  const escalation: RateWithSample = {
    rate: totalRequests > 0 ? escalationEvents.length / totalRequests : null,
    count: escalationEvents.length,
    total: totalRequests,
  };

  const idiomTotalFindings = idiomEvents.reduce((sum, e) => sum + (typeof e.detail.count === "number" ? e.detail.count : 0), 0);
  const idiomFindingRate: RateWithSample = {
    rate: idiomEvents.length > 0 ? idiomTotalFindings / idiomEvents.length : null,
    count: idiomTotalFindings,
    total: idiomEvents.length,
  };

  const { stats: approvalStats, warnings: approvalFatigueWarnings } = computeApprovalStats(confirmEvents);

  return {
    totalRequests,
    escalation,
    verificationFailureClusters: computeVerificationFailureClusters(failureEvents),
    confidenceTrend: computeConfidenceTrend(classificationEvents),
    reconciliationCount: reconciliationEvents.length,
    approvalStats,
    approvalFatigueWarnings,
    idiomFindingRate,
    testIntegrityFlagRate: computeRate(testIntegrityFlagEvents, gateEvaluationEvents),
    coverageGateFlagRate: computeRate(coverageGateFlagEvents, gateEvaluationEvents),
    libraryGrowth: computeLibraryGrowth(),
  };
}

function fmtRate(r: RateWithSample, label: string, unit = ""): string {
  if (r.rate === null) return `  ${label}: no data yet.`;
  return `  ${label}: ${(r.rate * 100).toFixed(1)}%${unit} (${r.count}/${r.total})`;
}

export function formatObservabilityReport(r: ObservabilityReport): string {
  const lines: string[] = [];

  lines.push(`Requests observed: ${r.totalRequests}`);
  lines.push("");

  lines.push(`Escalation rate (§6.3 relative to total requests):`);
  lines.push(fmtRate(r.escalation, "  rate"));
  lines.push("");

  lines.push(`Verification-failure clustering (top offenders):`);
  if (r.verificationFailureClusters.length === 0) {
    lines.push(`  no verification failures recorded.`);
  } else {
    for (const c of r.verificationFailureClusters.slice(0, 5)) {
      lines.push(`  ${c.key}: ${c.count} failure(s)`);
    }
  }
  lines.push("");

  lines.push(`Classifier confidence trend:`);
  if (!r.confidenceTrend) {
    lines.push(`  not enough classification events yet (need ${MIN_SAMPLES_FOR_TREND}+) to report a trend.`);
  } else {
    const t = r.confidenceTrend;
    lines.push(
      `  ${t.direction === "flat" ? "flat" : t.direction === "down" ? "trending DOWN" : "trending up"} — ` +
        `prior avg ${t.priorAvg.toFixed(2)} (n=${t.priorCount}) -> recent avg ${t.recentAvg.toFixed(2)} (n=${t.recentCount})`
    );
    if (t.direction === "down") {
      lines.push(`  a downward trend is worth investigating per-component before it shows up as verification failures.`);
    }
  }
  lines.push("");

  lines.push(`Reconciliation frequency (§7.2/§7.3):`);
  lines.push(`  ${r.reconciliationCount} reconciliation event(s) recorded.`);
  lines.push("");

  lines.push(`Idiom soft-fail rate (style drift, never a rollback trigger):`);
  lines.push(fmtRate(r.idiomFindingRate, "  avg findings per check", " avg"));
  lines.push("");

  lines.push(`Test-integrity vs coverage-gate flag rates (§10 — tracked separately by design):`);
  lines.push(fmtRate(r.testIntegrityFlagRate, "  test-integrity flag rate"));
  lines.push(fmtRate(r.coverageGateFlagRate, "  coverage-gate flag rate"));
  lines.push("");

  lines.push(`Advisory acceptance rate by checkpoint (§7.5):`);
  if (r.approvalStats.length === 0) {
    lines.push(`  no confirmation checkpoints recorded yet.`);
  } else {
    for (const s of r.approvalStats) {
      lines.push(`  ${s.checkpointKind}: ${(s.rate * 100).toFixed(0)}% approved (${s.approved} approved / ${s.declined} declined)`);
    }
  }
  if (r.approvalFatigueWarnings.length > 0) {
    lines.push(`  ⚠ approval-fatigue signal(s):`);
    for (const w of r.approvalFatigueWarnings) lines.push(`    ${w}`);
  }
  lines.push("");

  lines.push(`Local operation library growth (§5.2/§10):`);
  lines.push(`  ${r.libraryGrowth.totalPromoted} operation(s) promoted total.`);
  if (r.libraryGrowth.weeks.length === 0) {
    lines.push(`  no promotions yet.`);
  } else {
    for (const w of r.libraryGrowth.weeks) lines.push(`  week of ${w.weekStart}: ${w.count} promoted`);
  }

  return lines.join("\n");
}