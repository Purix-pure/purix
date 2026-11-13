// packages/core/src/eval/runner.ts
//
// AI-10 (PURIX-33): the loop that runs cases through arms and tiers and collects one record per model call.
//
// The model call is injected (`callModel`), so this file never touches a network, a key or the environment. The script
// scripts/eval-l1.ts passes a real provider, `--dry` passes the canned one from dry.ts, and the tests pass fakes.
//
// Spend control: the loop refuses to start without a positive budget, estimates each call before making it and stops
// before the budget would be passed. Cases are the outer loop, so a run stopped early still has every arm for the
// cases it got through, which keeps the paired comparison valid.
//
// What is recorded per call: ids, tokens, cost, latency and the outcome. Never the prompt or the reply text.
import type { Arm, ArmId } from "./arms.js";
import type { PromptPair } from "../llm/prompts/frames.js";
import type { EvalCase } from "./mutations.js";
import { scoreOutcome, type Tier, type TrialRecord } from "./scoring.js";

export interface ModelReply {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface CallContext {
  arm: ArmId;
  tier: Tier;
  trial: number;
  case: EvalCase;
}

export type CallModel = (prompt: PromptPair, tier: Tier, ctx: CallContext) => Promise<ModelReply>;

export interface Price {
  /** USD per million tokens. */
  input: number;
  output: number;
}

export interface RunOptions {
  cases: EvalCase[];
  arms: Arm[];
  tiers: Tier[];
  trials: number;
  callModel: CallModel;
  budgetUsd: number;
  price: (tier: Tier) => Price;
  /** Called after every record, so the script can write results as it goes. */
  onRecord?: (r: TrialRecord) => void;
  /** Output tokens assumed for the pre-call estimate. */
  estimatedOutputTokens?: number;
  now?: () => number;
}

export interface RunResult {
  records: TrialRecord[];
  spentUsd: number;
  stoppedForBudget: boolean;
  /** Calls that were not made because the budget would have been passed. */
  notRun: number;
}

const CHARS_PER_TOKEN = 3.5;

export function estimateCostUsd(prompt: PromptPair, price: Price, outputTokens: number): number {
  const inputTokens = (prompt.system.length + prompt.user.length) / CHARS_PER_TOKEN;
  return (inputTokens / 1e6) * price.input + (outputTokens / 1e6) * price.output;
}

export async function runEval(opts: RunOptions): Promise<RunResult> {
  if (!(opts.budgetUsd > 0) || !Number.isFinite(opts.budgetUsd)) throw new Error("runEval needs a positive, finite budgetUsd");
  const now = opts.now ?? (() => Date.now());
  const outEstimate = opts.estimatedOutputTokens ?? 1000;
  const records: TrialRecord[] = [];
  let spent = 0;
  let stopped = false;
  let notRun = 0;

  const push = (r: TrialRecord) => {
    records.push(r);
    opts.onRecord?.(r);
  };

  for (let trial = 1; trial <= opts.trials && !stopped; trial++) {
    for (const c of opts.cases) {
      if (stopped) break;
      for (const arm of opts.arms) {
        for (const tier of opts.tiers) {
          const base = { caseId: c.id, operator: c.operator, eol: c.eol, arm: arm.id, tier, trial };
          if (!arm.applicable(c)) {
            push({ ...base, status: "skipped", exact: false, normalized: false, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 });
            continue;
          }
          if (stopped) {
            notRun++;
            continue;
          }
          const prompt = arm.prompt(c);
          const price = opts.price(tier);
          if (spent + estimateCostUsd(prompt, price, outEstimate) > opts.budgetUsd) {
            stopped = true;
            notRun++;
            continue;
          }
          const t0 = now();
          let reply: ModelReply;
          try {
            reply = await opts.callModel(prompt, tier, { arm: arm.id, tier, trial, case: c });
          } catch {
            push({ ...base, status: "provider_error", exact: false, normalized: false, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: now() - t0 });
            continue;
          }
          const cost = (reply.inputTokens / 1e6) * price.input + (reply.outputTokens / 1e6) * price.output;
          spent += cost;
          const outcome = arm.apply(reply.text, c);
          const score = scoreOutcome(outcome, c.original);
          push({
            ...base,
            status: outcome.status,
            exact: score.exact,
            normalized: score.normalized,
            ...(outcome.stage !== undefined ? { stage: outcome.stage } : {}),
            inputTokens: reply.inputTokens,
            outputTokens: reply.outputTokens,
            costUsd: cost,
            latencyMs: now() - t0,
          });
        }
      }
    }
  }
  return { records, spentUsd: spent, stoppedForBudget: stopped, notRun };
}
