// packages/core/src/eval/report.ts
//
// AI-10 (PURIX-33): turns records into the table the decision is read from. Plain Markdown, no I/O.
import { ARM_IDS, type ArmId } from "./arms.js";
import { RULE, evaluateDecisionRule, pairedComparison, summarize, type Tier, type TrialRecord } from "./scoring.js";

export interface ReportMeta {
  dry: boolean;
  provider?: string;
  cases: number;
  trials: number;
  seed: number;
  spentUsd: number;
  budgetUsd: number;
  stoppedForBudget: boolean;
  notRun: number;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const usd = (x: number) => `$${x.toFixed(4)}`;

export function formatReport(records: TrialRecord[], meta: ReportMeta): string {
  const out: string[] = [];
  if (meta.dry) out.push("> DRY RUN: replies are canned by the harness, not produced by a model. These numbers test the harness and say nothing about any model.", "");
  out.push(`# L1 apply-rate eval`, "");
  out.push(
    `Cases ${meta.cases}, trials ${meta.trials}, seed ${meta.seed}${meta.provider ? `, provider ${meta.provider}` : ""}. Spent ${usd(meta.spentUsd)} of ${usd(meta.budgetUsd)}.` +
      (meta.stoppedForBudget ? ` STOPPED EARLY: the budget would have been passed; ${meta.notRun} calls were not made.` : "")
  );
  out.push("");

  const sums = summarize(records);
  out.push("## Per arm and tier", "");
  out.push("| Tier | Arm | n | Match (95% CI) | Exact | Applied | Unclassified | Invalid JSON | Apply failed | Mean tok in/out | Tokens per match | Cascade rescued | Cost |");
  out.push("|---|---|---:|---|---:|---:|---:|---:|---:|---|---:|---:|---:|");
  for (const s of sums) {
    out.push(
      `| ${s.tier} | ${s.arm} | ${s.n} | ${pct(s.match.p)} (${pct(s.match.lo)} to ${pct(s.match.hi)}) | ${pct(s.exactRate)} | ${pct(s.appliedRate)} | ${pct(s.unclassifiedRate)} | ${pct(s.invalidJsonRate)} | ${pct(s.applyFailedRate)} | ${s.meanInputTokens.toFixed(0)} / ${s.meanOutputTokens.toFixed(0)} | ${s.tokensPerResolved === null ? "n/a" : s.tokensPerResolved.toFixed(0)} | ${pct(s.rescuedByCascade)} | ${usd(s.costUsd)} |`
    );
  }
  const skipped = sums.filter((s) => s.skipped > 0).map((s) => `${s.arm}/${s.tier}: ${s.skipped}`);
  const errors = sums.filter((s) => s.providerErrors > 0).map((s) => `${s.arm}/${s.tier}: ${s.providerErrors}`);
  if (skipped.length) out.push("", `Skipped (arm not applicable to the case): ${skipped.join(", ")}.`);
  if (errors.length) out.push("", `Provider errors (not scored): ${errors.join(", ")}.`);

  const tiers = [...new Set(records.map((r) => r.tier))].sort();
  const arms = ARM_IDS.filter((a) => a !== "A0" && records.some((r) => r.arm === a));
  out.push("", "## Paired comparison against A0 (exact McNemar test on first-try match)", "");
  out.push("| Tier | Arm | Pairs | A0 only | Arm only | Difference (points) | p |", "|---|---|---:|---:|---:|---:|---:|");
  for (const tier of tiers) {
    for (const arm of arms) {
      const p = pairedComparison(records, "A0", arm, tier);
      out.push(`| ${tier} | ${arm} | ${p.pairs} | ${p.onlyA} | ${p.onlyB} | ${p.diffPoints >= 0 ? "+" : ""}${p.diffPoints.toFixed(1)} | ${p.pValue.toFixed(4)} |`);
    }
  }

  out.push("", "## Decision rule (set before running)", "");
  out.push(
    `A new edit format becomes the default for a tier only if it gains at least ${RULE.minGainPoints} points of first-try match on that tier, loses no more than ${RULE.maxLossOtherTierPoints} points on the other tier, and costs no more than ${RULE.maxExtraTokenShare * 100}% extra tokens per resolved case. Unmeasured parts count against the arm.`,
    ""
  );
  out.push("| Tier | Arm | Meets the rule | Why not |", "|---|---|---|---|");
  for (const tier of tiers) {
    for (const arm of arms) {
      const v = evaluateDecisionRule(records, arm, tier);
      out.push(`| ${tier} | ${arm} | ${v.passes ? "yes" : "no"} | ${v.reasons.join("; ") || "-"} |`);
    }
  }
  out.push("", meta.trials < 3 ? "One trial is a screening run. Use three trials for any decision." : `${meta.trials} trials.`);
  return out.join("\n") + "\n";
}
