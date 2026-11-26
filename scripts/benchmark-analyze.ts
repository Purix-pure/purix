// scripts/benchmark-analyze.ts
//
// Reads a file of paired runs (the same task done by a plain agent and by the same agent with Purix) and prints, per measure, what the
// pairs show. It is a separate script and not a `purix` command on purpose: it works on a file a person collected, makes no network call,
// reads nothing from a project's record, and its output is a report to read, not a product claim.
//
// Rules (docs/BENCHMARK_PROTOCOL.md): no single score; no ranking of agents or models; no dollar value for bugs prevented; a measure with
// fewer than MIN_PAIRS usable pairs reads "not enough pairs", never a number; a missing value reads "not recorded", never zero; a pair
// where either arm lacks a value is left out of that measure only, and the count of pairs used is always printed beside the figure.
//
//   node --import tsx scripts/benchmark-analyze.ts runs.json [--json]
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

export const MIN_PAIRS = 10;

export interface ArmResult {
  /** Did the task's own acceptance tests (written before the run, hidden from the agent) pass? */
  accepted?: boolean;
  costUsd?: number;
  seconds?: number;
  /** Human interruptions: approvals asked, questions asked. */
  interruptions?: number;
  /** Defects found in a later, independent review of the result. */
  reviewDefects?: number;
}
export interface Pair { task: string; plain?: ArmResult; purix?: ArmResult }
export interface RunsFile { schema: 1; pairs: Pair[] }

export type Measure = "accepted" | "costUsd" | "seconds" | "interruptions" | "reviewDefects";
export const MEASURES: readonly Measure[] = ["accepted", "costUsd", "seconds", "interruptions", "reviewDefects"];

export type MeasureReport =
  | { measure: Measure; kind: "not-enough-pairs"; pairs: number; needed: number }
  | { measure: Measure; kind: "binary"; pairs: number; bothPass: number; bothFail: number; onlyPurix: number; onlyPlain: number; signTestP: number }
  | { measure: Measure; kind: "numeric"; pairs: number; medianDiff: number; ciLow: number; ciHigh: number; purixLower: number; purixHigher: number; ties: number };

/** Two-sided exact sign test on the discordant pairs (binomial, p = 0.5). 1 when there are none. */
export function signTestP(a: number, b: number): number {
  const n = a + b;
  if (n === 0) return 1;
  const k = Math.min(a, b);
  // P(X <= k) for X ~ Bin(n, .5), doubled, capped at 1. Computed with logs so n of a few hundred is safe.
  let logC = 0; let sum = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    sum += Math.exp(logC - n * Math.LN2);
  }
  return Math.min(1, 2 * sum);
}

export function median(xs: number[]): number {
  const s = [...xs].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** A small deterministic generator, so the same file always gives the same interval. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** 95% percentile bootstrap interval of the median of the paired differences (Purix minus plain). */
export function bootstrapMedianCI(diffs: number[], resamples = 2000, seed = 1): [number, number] {
  const rnd = mulberry32(seed);
  const meds: number[] = [];
  for (let r = 0; r < resamples; r++) {
    const s: number[] = [];
    for (let i = 0; i < diffs.length; i++) s.push(diffs[Math.floor(rnd() * diffs.length)]!);
    meds.push(median(s));
  }
  meds.sort((x, y) => x - y);
  return [meds[Math.floor(0.025 * (resamples - 1))]!, meds[Math.ceil(0.975 * (resamples - 1))]!];
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

export function analyze(file: RunsFile): MeasureReport[] {
  return MEASURES.map((measure): MeasureReport => {
    const usable: [number, number][] = [];
    for (const p of file.pairs) {
      const a = measure === "accepted" ? (typeof p.plain?.accepted === "boolean" ? Number(p.plain.accepted) : undefined) : num(p.plain?.[measure]);
      const b = measure === "accepted" ? (typeof p.purix?.accepted === "boolean" ? Number(p.purix.accepted) : undefined) : num(p.purix?.[measure]);
      if (a !== undefined && b !== undefined) usable.push([a, b]); // plain, purix
    }
    if (usable.length < MIN_PAIRS) return { measure, kind: "not-enough-pairs", pairs: usable.length, needed: MIN_PAIRS };
    if (measure === "accepted") {
      const onlyPurix = usable.filter(([a, b]) => a === 0 && b === 1).length;
      const onlyPlain = usable.filter(([a, b]) => a === 1 && b === 0).length;
      return { measure, kind: "binary", pairs: usable.length, bothPass: usable.filter(([a, b]) => a === 1 && b === 1).length, bothFail: usable.filter(([a, b]) => a === 0 && b === 0).length, onlyPurix, onlyPlain, signTestP: signTestP(onlyPurix, onlyPlain) };
    }
    const diffs = usable.map(([a, b]) => b - a);
    const [ciLow, ciHigh] = bootstrapMedianCI(diffs);
    return { measure, kind: "numeric", pairs: usable.length, medianDiff: median(diffs), ciLow, ciHigh, purixLower: diffs.filter((d) => d < 0).length, purixHigher: diffs.filter((d) => d > 0).length, ties: diffs.filter((d) => d === 0).length };
  });
}

const LABEL: Record<Measure, string> = { accepted: "Acceptance tests passed", costUsd: "Cost (USD, estimated)", seconds: "Time (seconds)", interruptions: "Interruptions", reviewDefects: "Defects found in review" };

export function formatReport(reports: MeasureReport[], totalPairs: number): string {
  const out = [`${totalPairs} paired tasks. Differences are Purix minus plain. No overall score is computed.`, ""];
  for (const r of reports) {
    out.push(`${LABEL[r.measure]}:`);
    if (r.kind === "not-enough-pairs") out.push(`  not enough pairs (${r.pairs} usable, ${r.needed} needed)`);
    else if (r.kind === "binary") out.push(`  ${r.pairs} pairs: both passed ${r.bothPass}, both failed ${r.bothFail}, only Purix passed ${r.onlyPurix}, only plain passed ${r.onlyPlain}; exact sign test p = ${r.signTestP.toFixed(3)}`);
    else out.push(`  ${r.pairs} pairs: median difference ${r.medianDiff} (95% interval ${r.ciLow} to ${r.ciHigh}); Purix lower in ${r.purixLower}, higher in ${r.purixHigher}, equal in ${r.ties}`);
  }
  out.push("", "An interval that includes 0 means these pairs do not show a difference. Tasks you chose are not a sample of all tasks. Measures a pair lacks read \"not recorded\" and are left out of that measure only.");
  return out.join("\n") + "\n";
}

export function parseRunsFile(text: string): RunsFile {
  const j = JSON.parse(text) as Partial<RunsFile>;
  if (j.schema !== 1 || !Array.isArray(j.pairs)) throw new Error("The file is not a runs file (expected {\"schema\":1,\"pairs\":[...]}).");
  return { schema: 1, pairs: j.pairs.filter((p): p is Pair => !!p && typeof p.task === "string") };
}

// Compared as file URLs (as the other scripts do): `file://${argv[1]}` never matches on Windows (`file:///E:/...` against `file://E:\...`).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (!path) { console.error("Usage: node --import tsx scripts/benchmark-analyze.ts runs.json [--json]"); process.exit(2); }
  try {
    const file = parseRunsFile(readFileSync(path, "utf8"));
    const reports = analyze(file);
    process.stdout.write(process.argv.includes("--json") ? JSON.stringify({ pairs: file.pairs.length, reports }, null, 2) + "\n" : formatReport(reports, file.pairs.length));
  } catch (err) { console.error(err instanceof Error ? err.message : String(err)); process.exit(2); }
}
