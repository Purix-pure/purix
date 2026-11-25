// packages/core/src/verify/metrics_detail.ts
//
// The part of a verification_pass event's detail that records what the run counted and how long it took, so a receipt and the
// dashboard can say "41 tests passed, 2 skipped, 3.1 s" from a stored fact. Spread into the detail at every place that records a
// passing verification, next to searchCutDetail and securityNotesDetail.
//
// Counts come from the runners' own reports. A run that reported none leaves the field out: absent means "not recorded", never "zero".
// Nothing here reads a file, a prompt or a reply; it holds numbers only.
import { LEDGER_SCHEMA_VERSION } from "../observe/ledger_version.js";

export interface VerificationMetrics {
  testCounts?: { passed: number; failed: number; skipped: number };
  verifyMs?: number;
  /** Optional duplication check: counts only. */
  duplication?: { before: number; after: number; linesChecked: number; filesCompared: number; cut: boolean };
  /** F06-04: how much of the changed code a passing run ran. Numbers and counts only; file names stay out of this record. */
  changedCoverage?: { covered: number; total: number; ratio?: number; uncovered?: Record<string, number[]>; partial?: Record<string, number[]>; notMeasured?: string[]; whyNotMeasured?: string };
}

export interface ChangedCoverageDetail {
  covered: number;
  total: number;
  ratio?: number;
  /** How many changed files had lines no test ran, and how many lines in all. */
  uncovered_files: number;
  uncovered_lines: number;
  not_measured_files: number;
  why_not_measured?: string;
}

function validDup(d: VerificationMetrics["duplication"]): d is NonNullable<VerificationMetrics["duplication"]> {
  return d !== undefined && [d.before, d.after, d.linesChecked, d.filesCompared].every((n) => Number.isInteger(n) && n >= 0) && typeof d.cut === "boolean";
}

function coverageDetail(c: VerificationMetrics["changedCoverage"]): ChangedCoverageDetail | undefined {
  if (!c || ![c.covered, c.total].every((n) => Number.isInteger(n) && n >= 0)) return undefined;
  const unc = Object.values(c.uncovered ?? {});
  return {
    covered: c.covered,
    total: c.total,
    ...(typeof c.ratio === "number" && Number.isFinite(c.ratio) ? { ratio: Math.round(c.ratio * 1000) / 1000 } : {}),
    uncovered_files: unc.length,
    uncovered_lines: unc.reduce((n, l) => n + l.length, 0),
    not_measured_files: (c.notMeasured ?? []).length,
    ...(c.whyNotMeasured ? { why_not_measured: c.whyNotMeasured.slice(0, 200) } : {}),
  };
}

export function metricsDetail(v: VerificationMetrics): { schema: number; test_counts?: { passed: number; failed: number; skipped: number }; verify_ms?: number; changed_coverage?: ChangedCoverageDetail; duplication?: { before: number; after: number; lines_checked: number; files_compared: number; cut: boolean } } {
  const counts = v.testCounts;
  const validCounts =
    counts !== undefined &&
    [counts.passed, counts.failed, counts.skipped].every((n) => Number.isInteger(n) && n >= 0);
  return {
    schema: LEDGER_SCHEMA_VERSION,
    ...(validCounts ? { test_counts: { passed: counts.passed, failed: counts.failed, skipped: counts.skipped } } : {}),
    ...(typeof v.verifyMs === "number" && Number.isFinite(v.verifyMs) && v.verifyMs >= 0 ? { verify_ms: Math.round(v.verifyMs) } : {}),
    ...(coverageDetail(v.changedCoverage) ? { changed_coverage: coverageDetail(v.changedCoverage)! } : {}),
    ...(validDup(v.duplication) ? { duplication: { before: v.duplication.before, after: v.duplication.after, lines_checked: v.duplication.linesChecked, files_compared: v.duplication.filesCompared, cut: v.duplication.cut } } : {}),
  };
}
