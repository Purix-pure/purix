// packages/core/src/eval/scoring.ts
//
// AI-10 (PURIX-33): scoring and statistics for the L1 eval. Pure functions over per-call records.
//
// What counts as a match. The expected result is the original file. "Exact" means byte-for-byte equal. "Normalised"
// means equal after line endings are unified, trailing spaces on each line are dropped and trailing blank lines are
// ignored, so a model that returns LF for a CRLF file is not marked wrong for a cosmetic difference. The decision rule
// uses the normalised match ("first-try match").
import type { ApplyOutcome } from "./arms.js";
import type { ArmId } from "./arms.js";
import type { MutationOperator } from "./mutations.js";

export type Tier = "low" | "high";

export interface TrialRecord {
  caseId: string;
  operator: MutationOperator;
  eol: "lf" | "crlf";
  arm: ArmId;
  tier: Tier;
  trial: number;
  status: ApplyOutcome["status"] | "provider_error";
  exact: boolean;
  normalized: boolean;
  stage?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

export function normalizeForMatch(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

export function scoreOutcome(outcome: ApplyOutcome, expected: string): { exact: boolean; normalized: boolean } {
  if (outcome.status !== "applied" || outcome.result === undefined) return { exact: false, normalized: false };
  return { exact: outcome.result === expected, normalized: normalizeForMatch(outcome.result) === normalizeForMatch(expected) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Statistics

/** Wilson score interval for a proportion (z = 1.96 gives about 95%). */
export function wilson(successes: number, n: number, z = 1.96): { p: number; lo: number; hi: number } {
  if (n === 0) return { p: 0, lo: 0, hi: 0 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

function logChoose(n: number, k: number): number {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

/**
 * Exact McNemar test: two-sided binomial test on the discordant pairs (b = only arm A right, c = only arm B right)
 * with success probability 0.5. Returns 1 when there are no discordant pairs.
 */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, 2 * tail);
}

export interface PairedComparison {
  tier: Tier;
  a: ArmId;
  b: ArmId;
  /** Pairs where both arms ran on the same case and trial. */
  pairs: number;
  bothRight: number;
  onlyA: number;
  onlyB: number;
  neither: number;
  /** (B - A) in percentage points of normalised first-try match. */
  diffPoints: number;
  pValue: number;
}

const pairKey = (r: TrialRecord) => `${r.caseId}#${r.trial}`;
const ran = (r: TrialRecord) => r.status !== "skipped";

export function pairedComparison(records: TrialRecord[], a: ArmId, b: ArmId, tier: Tier): PairedComparison {
  const byKey = (arm: ArmId) => new Map(records.filter((r) => r.arm === arm && r.tier === tier && ran(r)).map((r) => [pairKey(r), r]));
  const A = byKey(a);
  const B = byKey(b);
  let bothRight = 0;
  let onlyA = 0;
  let onlyB = 0;
  let neither = 0;
  for (const [k, ra] of A) {
    const rb = B.get(k);
    if (!rb) continue;
    if (ra.normalized && rb.normalized) bothRight++;
    else if (ra.normalized) onlyA++;
    else if (rb.normalized) onlyB++;
    else neither++;
  }
  const pairs = bothRight + onlyA + onlyB + neither;
  return { tier, a, b, pairs, bothRight, onlyA, onlyB, neither, diffPoints: pairs === 0 ? 0 : ((onlyB - onlyA) / pairs) * 100, pValue: mcnemarExact(onlyA, onlyB) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Per arm and tier summary

export interface ArmSummary {
  arm: ArmId;
  tier: Tier;
  /** Calls scored (skipped and provider errors are not in n). */
  n: number;
  skipped: number;
  providerErrors: number;
  appliedRate: number;
  exactRate: number;
  match: { p: number; lo: number; hi: number };
  unclassifiedRate: number;
  invalidJsonRate: number;
  applyFailedRate: number;
  meanInputTokens: number;
  meanOutputTokens: number;
  costUsd: number;
  /** Total tokens (in + out) per normalised match; null when nothing matched. */
  tokensPerResolved: number | null;
  /** Share of this arm's matches that needed an anchor stage other than exact (A1). */
  rescuedByCascade: number;
}

export function summarize(records: TrialRecord[]): ArmSummary[] {
  const groups = new Map<string, TrialRecord[]>();
  for (const r of records) {
    const key = `${r.arm}|${r.tier}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  const out: ArmSummary[] = [];
  for (const [key, all] of groups) {
    const [arm, tier] = key.split("|") as [ArmId, Tier];
    const scored = all.filter((r) => r.status !== "skipped" && r.status !== "provider_error");
    const n = scored.length;
    const rate = (f: (r: TrialRecord) => boolean) => (n === 0 ? 0 : scored.filter(f).length / n);
    const matched = scored.filter((r) => r.normalized).length;
    const tokens = scored.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
    out.push({
      arm,
      tier,
      n,
      skipped: all.filter((r) => r.status === "skipped").length,
      providerErrors: all.filter((r) => r.status === "provider_error").length,
      appliedRate: rate((r) => r.status === "applied"),
      exactRate: rate((r) => r.exact),
      match: wilson(matched, n),
      unclassifiedRate: rate((r) => r.status === "unclassified"),
      invalidJsonRate: rate((r) => r.status === "invalid_json"),
      applyFailedRate: rate((r) => r.status === "apply_failed"),
      meanInputTokens: n === 0 ? 0 : scored.reduce((s, r) => s + r.inputTokens, 0) / n,
      meanOutputTokens: n === 0 ? 0 : scored.reduce((s, r) => s + r.outputTokens, 0) / n,
      costUsd: all.reduce((s, r) => s + r.costUsd, 0),
      tokensPerResolved: matched === 0 ? null : tokens / matched,
      rescuedByCascade: matched === 0 ? 0 : scored.filter((r) => r.normalized && r.stage !== undefined && r.stage !== "exact").length / matched,
    });
  }
  return out.sort((x, y) => (x.tier === y.tier ? x.arm.localeCompare(y.arm) : x.tier.localeCompare(y.tier)));
}

// ---------------------------------------------------------------------------------------------------------------------
// The decision rule, written before the run (PURIX-33, AI-10)

export const RULE = { minGainPoints: 8, maxLossOtherTierPoints: 2, maxExtraTokenShare: 0.15 } as const;

export interface RuleVerdict {
  arm: ArmId;
  tier: Tier;
  passes: boolean;
  gainPoints: number;
  otherTierPoints: number | null;
  tokenRatio: number | null;
  reasons: string[];
}

/**
 * A new edit format becomes the default for `tier` only if, against `baseline` (A0):
 *  - it gains at least 8 points of first-try match on that tier,
 *  - it loses no more than 2 points on the other tier,
 *  - it costs no more than 15% extra tokens per resolved case.
 * Anything not measured counts against the arm: the rule is not met on a guess.
 */
export function evaluateDecisionRule(records: TrialRecord[], arm: ArmId, tier: Tier, baseline: ArmId = "A0"): RuleVerdict {
  const other: Tier = tier === "low" ? "high" : "low";
  const reasons: string[] = [];
  const here = pairedComparison(records, baseline, arm, tier);
  const gainPoints = here.diffPoints;
  if (here.pairs === 0) reasons.push(`no paired results on the ${tier} tier`);
  else if (gainPoints < RULE.minGainPoints) reasons.push(`gain on ${tier} is ${gainPoints.toFixed(1)} points, below ${RULE.minGainPoints}`);

  const there = pairedComparison(records, baseline, arm, other);
  let otherTierPoints: number | null = null;
  if (there.pairs === 0) reasons.push(`the ${other} tier was not measured`);
  else {
    otherTierPoints = there.diffPoints;
    if (otherTierPoints < -RULE.maxLossOtherTierPoints) reasons.push(`loses ${(-otherTierPoints).toFixed(1)} points on ${other}, more than ${RULE.maxLossOtherTierPoints}`);
  }

  const sums = summarize(records);
  const a = sums.find((s) => s.arm === baseline && s.tier === tier)?.tokensPerResolved ?? null;
  const b = sums.find((s) => s.arm === arm && s.tier === tier)?.tokensPerResolved ?? null;
  let tokenRatio: number | null = null;
  if (a === null || b === null) reasons.push(`tokens per resolved case could not be computed on ${tier}`);
  else {
    tokenRatio = b / a;
    if (tokenRatio > 1 + RULE.maxExtraTokenShare) reasons.push(`costs ${((tokenRatio - 1) * 100).toFixed(0)}% more tokens per resolved case, above ${RULE.maxExtraTokenShare * 100}%`);
  }
  return { arm, tier, passes: reasons.length === 0, gainPoints, otherTierPoints, tokenRatio, reasons };
}
