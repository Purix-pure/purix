// scripts/benchmark-run.ts
//
// Runs the paired benchmark of docs/BENCHMARK_PROTOCOL.md and writes the runs file that benchmark-analyze.ts reads. Each task is done
// twice with the same agent: once with the plain command, once with the Purix command. Order is randomised per task from a seed that is
// written into the output, so the draw can be checked. It makes no network call of its own; the AGENT commands you give it will.
//
//   node --import tsx scripts/benchmark-run.ts plan.json runs.json [--dry-run]
//
// plan.json:
//   {
//     "schema": 1, "seed": 7,
//     "plain": "claude -p \"$(cat \"$PURIX_BENCH_PROMPT_FILE\")\" ...",       // run in the workspace, shell command
//     "purix": "claude -p ... (same agent and model, Purix connected)",
//     "tasks": [{ "id": "t1", "template": "tasks/t1/repo", "prompt": "tasks/t1/prompt.md",
//                 "accept": "npm test --silent", "acceptDir": "tasks/t1/hidden", "timeoutSeconds": 1800 }]
//   }
// Paths are relative to plan.json. For every arm a fresh copy of `template` is made in a temp folder and the agent command runs there
// with PURIX_BENCH_PROMPT_FILE (the prompt text file), PURIX_BENCH_ARM ("plain" | "purix") and PURIX_BENCH_TASK set. The hidden
// acceptance tests (`acceptDir`) are copied in ONLY AFTER the agent has finished, then `accept` runs; exit code 0 means accepted.
// The agent may write `.purix-bench-result.json` in the workspace: {"costUsd": n, "interruptions": n}. Anything it does not write is left
// out of the file ("not recorded"), never filled with a zero. `reviewDefects` is not measured here: a later independent review adds it.
//
// What this does not do: it does not sandbox the agent (it runs on this machine, with this person's credentials), it does not pick the
// tasks, and a timeout or a crash of the agent is recorded as the arm's result (accepted decided by the tests), not as a missing arm.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ArmResult, Pair, RunsFile } from "./benchmark-analyze.ts";

export interface PlanTask { id: string; template: string; prompt: string; accept: string; acceptDir?: string; timeoutSeconds?: number }
export interface Plan { schema: 1; seed?: number; plain: string; purix: string; tasks: PlanTask[] }
export type Arm = "plain" | "purix";
export interface RunsOutput extends RunsFile { seed: number; order: Record<string, Arm[]> }

export function parsePlan(text: string): Plan {
  const j = JSON.parse(text) as Partial<Plan>;
  if (j.schema !== 1 || typeof j.plain !== "string" || typeof j.purix !== "string" || !Array.isArray(j.tasks) || j.tasks.length === 0) {
    throw new Error('The file is not a plan (expected {"schema":1,"plain":"...","purix":"...","tasks":[...]}).');
  }
  const ids = new Set<string>();
  for (const t of j.tasks) {
    if (!t || typeof t.id !== "string" || typeof t.template !== "string" || typeof t.prompt !== "string" || typeof t.accept !== "string") {
      throw new Error("Every task needs id, template, prompt and accept.");
    }
    if (ids.has(t.id)) throw new Error(`Task id "${t.id}" appears twice.`);
    ids.add(t.id);
  }
  return { schema: 1, ...(typeof j.seed === "number" ? { seed: j.seed } : {}), plain: j.plain, purix: j.purix, tasks: j.tasks };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Which arm goes first for each task: one fair coin per task from the seed. */
export function drawOrder(taskIds: string[], seed: number): Record<string, Arm[]> {
  const rnd = mulberry32(seed);
  const out: Record<string, Arm[]> = {};
  for (const id of taskIds) out[id] = rnd() < 0.5 ? ["plain", "purix"] : ["purix", "plain"];
  return out;
}

const nonNeg = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

function runShell(cmd: string, cwd: string, env: NodeJS.ProcessEnv, timeoutSeconds: number): { status: number | null; timedOut: boolean } {
  const r = spawnSync(cmd, { cwd, env, shell: true, stdio: "ignore", timeout: timeoutSeconds * 1000, killSignal: "SIGKILL" });
  return { status: r.status, timedOut: (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" };
}

export function runArm(plan: Plan, task: PlanTask, arm: Arm, baseDir: string): ArmResult {
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(baseDir, p));
  const work = mkdtempSync(join(tmpdir(), `purix-bench-${task.id}-${arm}-`));
  try {
    cpSync(abs(task.template), work, { recursive: true });
    const started = Date.now();
    const timeout = task.timeoutSeconds ?? 1800;
    runShell(arm === "plain" ? plan.plain : plan.purix, work, {
      ...process.env, PURIX_BENCH_PROMPT_FILE: abs(task.prompt), PURIX_BENCH_ARM: arm, PURIX_BENCH_TASK: task.id,
    }, timeout);
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    // The agent is done: only now do the hidden tests appear.
    if (task.acceptDir) cpSync(abs(task.acceptDir), work, { recursive: true });
    const res: ArmResult = { seconds };
    const resultFile = join(work, ".purix-bench-result.json");
    if (existsSync(resultFile)) {
      try {
        const j = JSON.parse(readFileSync(resultFile, "utf8")) as Record<string, unknown>;
        const c = nonNeg(j["costUsd"]); const i = nonNeg(j["interruptions"]);
        if (c !== undefined) res.costUsd = c;
        if (i !== undefined) res.interruptions = i;
      } catch { /* an unreadable result file means cost and interruptions are not recorded */ }
      rmSync(resultFile, { force: true });
    }
    res.accepted = runShell(task.accept, work, { ...process.env }, timeout).status === 0;
    return res;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function runPlan(plan: Plan, baseDir: string, log: (s: string) => void = () => {}): RunsOutput {
  const seed = plan.seed ?? 1;
  const order = drawOrder(plan.tasks.map((t) => t.id), seed);
  const pairs: Pair[] = [];
  for (const task of plan.tasks) {
    const pair: Pair = { task: task.id };
    for (const arm of order[task.id]!) {
      log(`${task.id}: ${arm}`);
      pair[arm] = runArm(plan, task, arm, baseDir);
    }
    pairs.push(pair);
  }
  return { schema: 1, seed, order, pairs };
}

/** The plan and output paths from the command line, or the reason they cannot be used. `--dry-run` needs only the plan. */
export function parseCli(argv: string[]): { planPath: string; outPath: string | null; dryRun: boolean } | { error: string } {
  const dryRun = argv.includes("--dry-run");
  const positional = argv.filter((a) => !a.startsWith("--"));
  // PowerShell turns `a.json b.json, --dry-run` into one argument "b.json --dry-run"; say so instead of failing on a missing file.
  const joined = positional.find((a) => /(^|[\s,])--[a-z]/.test(a) || /,\s*$/.test(a));
  if (joined !== undefined) return { error: `The argument "${joined}" looks like two arguments joined together (a comma between them?). Write them separated by spaces only: plan.json runs.json --dry-run` };
  const [planPath, outPath] = positional;
  if (!planPath) return { error: "Usage: node --import tsx scripts/benchmark-run.ts plan.json runs.json [--dry-run]   (with --dry-run only plan.json is needed)" };
  if (!dryRun && !outPath) return { error: "Name the file to write as well: node --import tsx scripts/benchmark-run.ts plan.json runs.json" };
  return { planPath, outPath: outPath ?? null, dryRun };
}

// Compared as file URLs: `file://${argv[1]}` never matches on Windows (`file:///E:/...` against `file://E:\...`), so the script did nothing there.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cli = parseCli(process.argv.slice(2));
  if ("error" in cli) { console.error(cli.error); process.exit(2); }
  try {
    const plan = parsePlan(readFileSync(cli.planPath, "utf8"));
    if (cli.dryRun) {
      const order = drawOrder(plan.tasks.map((t) => t.id), plan.seed ?? 1);
      for (const t of plan.tasks) console.log(`${t.id}: ${order[t.id]!.join(" then ")}`);
      process.exit(0);
    }
    const out = runPlan(plan, dirname(resolve(cli.planPath)), (s) => console.error(s));
    writeFileSync(cli.outPath!, JSON.stringify(out, null, 2) + "\n");
    console.error(`Wrote ${out.pairs.length} pairs to ${cli.outPath}. Analyse with: node --import tsx scripts/benchmark-analyze.ts ${cli.outPath}`);
  } catch (err) { console.error(err instanceof Error ? err.message : String(err)); process.exit(2); }
}
