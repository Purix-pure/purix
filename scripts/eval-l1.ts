// scripts/eval-l1.ts
//
// AI-10 (PURIX-33): runner for the L1 apply-rate eval. Library code is packages/core/src/eval/; this file is only the
// command line, the file reading and the provider hookup. It is not part of any published package.
//
//   pnpm eval:l1 --dry --budget-usd 1                          canned replies, no key, no network (tests the harness)
//   pnpm eval:l1 --budget-usd 5 --cases 200 --trials 1         screening run against the configured provider
//   pnpm eval:l1 --budget-usd 40 --trials 3 --out .eval/run1   a run to decide on; writes run1.jsonl and run1.md
//
// It REFUSES to start without --budget-usd, and stops before a call that would pass it. It records ids, token counts,
// cost, latency and outcomes per call. It never records prompts or replies.
//
// The provider comes from the usual setup (`purix provider set`, or PURIX_LLM_PROVIDER plus the key variable). Each
// call goes straight to the provider; it does NOT go through callLlm, so a run does not write the project's budget
// ledger. The AI-05 call log is not in this tree yet; when it lands, switch the real model hookup to record there.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ARM_IDS, armsFor, type ArmId } from "../packages/core/src/eval/arms.ts";
import { dryModel } from "../packages/core/src/eval/dry.ts";
import { loadDiffXyzCases } from "../packages/core/src/eval/diffxyz.ts";
import { generateCases, type EvalCase, type SourceFile } from "../packages/core/src/eval/mutations.ts";
import { formatReport } from "../packages/core/src/eval/report.ts";
import { runEval, type CallModel } from "../packages/core/src/eval/runner.ts";
import type { Tier } from "../packages/core/src/eval/scoring.ts";

const ROOT = resolve(import.meta.dirname, "..");

function fail(message: string): never {
  process.stderr.write(`eval-l1: ${message}\n`);
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    "budget-usd": { type: "string" },
    dry: { type: "boolean", default: false },
    cases: { type: "string", default: "200" },
    trials: { type: "string", default: "1" },
    seed: { type: "string", default: "1" },
    tiers: { type: "string", default: "low,high" },
    arms: { type: "string", default: ARM_IDS.join(",") },
    source: { type: "string", default: join(ROOT, "packages", "core", "src") },
    "crlf-share": { type: "string", default: "0.25" },
    out: { type: "string" },
    diffxyz: { type: "string" },
    "diffxyz-license-confirmed": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  strict: true,
});

if (values.help) {
  process.stdout.write("Usage: pnpm eval:l1 --budget-usd <n> [--dry] [--cases 200] [--trials 1] [--seed 1] [--tiers low,high] [--arms A0,A1,A2,A3,A4] [--source <dir>] [--crlf-share 0.25] [--out <path>] [--diffxyz <file.jsonl> --diffxyz-license-confirmed]\n");
  process.exit(0);
}

const budgetUsd = Number(values["budget-usd"]);
if (values["budget-usd"] === undefined || !Number.isFinite(budgetUsd) || budgetUsd <= 0) {
  fail("--budget-usd is required and must be a positive number. The run will not start without a spending limit.");
}
const int = (name: string, raw: string | undefined, min: number): number => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) fail(`--${name} must be an integer of at least ${min}`);
  return n;
};
const caseCount = int("cases", values.cases, 1);
const trials = int("trials", values.trials, 1);
const seed = int("seed", values.seed, 0);
const crlfShare = Number(values["crlf-share"]);
if (!(crlfShare >= 0 && crlfShare <= 1)) fail("--crlf-share must be between 0 and 1");

const tiers = (values.tiers ?? "").split(",").map((t) => t.trim()).filter(Boolean) as Tier[];
if (tiers.length === 0 || tiers.some((t) => t !== "low" && t !== "high")) fail('--tiers must be "low", "high" or "low,high"');
const armIds = (values.arms ?? "").split(",").map((a) => a.trim()).filter(Boolean) as ArmId[];
if (armIds.length === 0 || armIds.some((a) => !ARM_IDS.includes(a))) fail(`--arms must be a list from ${ARM_IDS.join(", ")}`);
if (!armIds.includes("A0") && armIds.length > 0) process.stderr.write("eval-l1: note: A0 is not in --arms, so there is no baseline for the paired comparison.\n");

// ---- cases ---------------------------------------------------------------------------------------------------------

function collectSources(dir: string, out: SourceFile[] = []): SourceFile[] {
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name === "dist" || name === "fixtures" || name.startsWith(".")) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) collectSources(full, out);
    else if (/\.ts$/.test(name) && !/\.(?:test|d)\.ts$/.test(name)) {
      const content = readFileSync(full, "utf-8");
      const lines = content.split(/\r?\n/).length;
      if (lines >= 20 && lines <= 400) out.push({ path: relative(ROOT, full).split("\\").join("/"), content });
    }
  }
  return out;
}

let cases: EvalCase[];
if (values.diffxyz) {
  const loaded = loadDiffXyzCases(readFileSync(values.diffxyz, "utf-8"), { licenseConfirmed: values["diffxyz-license-confirmed"] === true, maxCases: caseCount });
  cases = loaded.cases;
  process.stderr.write(`eval-l1: Diff-XYZ adapter: ${cases.length} cases, ${loaded.skipped} records skipped. Field names are NOT verified against the real dataset.\n`);
} else {
  const sources = collectSources(resolve(values.source ?? ""));
  if (sources.length === 0) fail(`no usable .ts files (20 to 400 lines) under ${values.source}`);
  cases = generateCases(sources, { count: caseCount, seed, crlfShare });
}
if (cases.length === 0) fail("no cases could be generated from the source files");

// ---- model ---------------------------------------------------------------------------------------------------------

let callModel: CallModel;
let price: (tier: Tier) => { input: number; output: number };
let providerName: string | undefined;

if (values.dry) {
  callModel = dryModel;
  price = () => ({ input: 1, output: 4 });
} else {
  const { getProvider, priceFor } = await import("../packages/core/src/llm/providers.ts");
  const provider = getProvider();
  providerName = provider.id;
  price = (tier) => priceFor(provider.id, tier);
  callModel = async (prompt, tier) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await provider.generate(prompt.user, tier, prompt.system);
        return { text: r.text ?? "", inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens };
      } catch (err) {
        if (attempt >= 3 || !provider.isTransientError(err)) throw err;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
      }
    }
  };
}

// ---- run -----------------------------------------------------------------------------------------------------------

const outBase = values.out ? resolve(values.out) : null;
if (outBase) {
  mkdirSync(dirname(outBase), { recursive: true });
  writeFileSync(`${outBase}.jsonl`, "");
}

process.stderr.write(`eval-l1: ${cases.length} cases x ${armIds.length} arms x ${tiers.length} tiers x ${trials} trial(s), budget $${budgetUsd}${values.dry ? " (dry run)" : ""}\n`);
const result = await runEval({
  cases,
  arms: armsFor(armIds),
  tiers,
  trials,
  callModel,
  budgetUsd,
  price,
  onRecord: (r) => {
    if (outBase) appendFileSync(`${outBase}.jsonl`, `${JSON.stringify(r)}\n`);
  },
});

const report = formatReport(result.records, {
  dry: values.dry === true,
  provider: providerName,
  cases: cases.length,
  trials,
  seed,
  spentUsd: result.spentUsd,
  budgetUsd,
  stoppedForBudget: result.stoppedForBudget,
  notRun: result.notRun,
});
if (outBase) writeFileSync(`${outBase}.md`, report);
process.stdout.write(report);
if (outBase) process.stderr.write(`eval-l1: wrote ${outBase}.jsonl and ${outBase}.md\n`);
