// src/cli/dashboard/check_state.ts
//
// The `purix check` state shown on a project card. `purix check` works on the folder it runs in (the store is found from the current
// directory), so a server that lists many projects cannot call it in process. It runs it as a separate, read-only process in each
// project's folder, in the background, and the page shows the last answer. A page never waits for it: a project with no answer yet reads
// "checking", and the answer appears on the next load. At most two run at once, an answer is reused for two minutes, and a run that
// takes longer than 20 seconds is stopped and reads "could not be checked", which is not the same as clean.
//
// What this does not do: write anything (the probe passes --no-register so the project's "last seen" time is not moved by the dashboard
// looking at it), reach the network (`purix check` makes no network call), or run a model.
import { execFile } from "node:child_process";

export type CardOutcome = "pass" | "fail" | "error" | "skipped" | "not-applicable";

export type CardCheckState =
  | { kind: "checking" }
  | { kind: "done"; outcome: CardOutcome; summary: string; at: number; refreshing: boolean }
  | { kind: "unavailable"; why: string; at: number; refreshing: boolean };

/** Runs one check in a folder and returns the stdout of `purix check --json`, or why it could not run. */
export type CheckRunner = (projectPath: string) => Promise<{ stdout: string } | { error: string }>;

export interface CheckStateProvider {
  get(projectPath: string): CardCheckState;
  /** True while any project has no answer yet, so the page can ask the browser to reload once. */
  anyChecking(): boolean;
}

export interface CheckStateOptions {
  run: CheckRunner;
  now?: () => number;
  ttlMs?: number;
  maxParallel?: number;
}

const OUTCOMES: readonly string[] = ["pass", "fail", "error", "skipped", "not-applicable"];

/** Reads the report JSON. Anything that is not the documented shape (schema 1, a known outcome, a summary string) is "unavailable", never a guess. */
export function parseCheckReport(stdout: string): { outcome: CardOutcome; summary: string } | { error: string } {
  let json: unknown;
  try { json = JSON.parse(stdout); } catch { return { error: "the check printed something that is not JSON" }; }
  const r = json as { schema?: unknown; outcome?: unknown; summary?: unknown };
  if (!r || typeof r !== "object" || r.schema !== 1) return { error: "the check report has a version this dashboard does not read" };
  if (typeof r.outcome !== "string" || !OUTCOMES.includes(r.outcome) || typeof r.summary !== "string") return { error: "the check report is missing its outcome" };
  return { outcome: r.outcome as CardOutcome, summary: r.summary.slice(0, 300) };
}

export function createCheckStateProvider(opts: CheckStateOptions): CheckStateProvider {
  const now = opts.now ?? (() => Date.now());
  const ttl = opts.ttlMs ?? 120_000;
  const maxParallel = opts.maxParallel ?? 2;
  interface Entry { state: Exclude<CardCheckState, { kind: "checking" }> | null; running: boolean }
  const entries = new Map<string, Entry>();
  const queue: string[] = [];
  let active = 0;

  const pump = (): void => {
    while (active < maxParallel && queue.length > 0) {
      const path = queue.shift()!;
      const e = entries.get(path)!;
      active++;
      void opts.run(path).then(
        (res) => res,
        (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
      ).then((res) => {
        const at = now();
        if ("error" in res) e.state = { kind: "unavailable", why: res.error, at, refreshing: false };
        else {
          const parsed = parseCheckReport(res.stdout);
          e.state = "error" in parsed ? { kind: "unavailable", why: parsed.error, at, refreshing: false } : { kind: "done", outcome: parsed.outcome, summary: parsed.summary, at, refreshing: false };
        }
        e.running = false;
        active--;
        pump();
      });
    }
  };

  return {
    get(path) {
      let e = entries.get(path);
      if (!e) { e = { state: null, running: false }; entries.set(path, e); }
      const stale = e.state === null || now() - e.state.at > ttl;
      if (stale && !e.running) { e.running = true; queue.push(path); pump(); }
      if (e.state === null) return { kind: "checking" };
      return { ...e.state, refreshing: e.running };
    },
    anyChecking() {
      for (const e of entries.values()) if (e.state === null) return true;
      return false;
    },
  };
}

/** The real runner: this same CLI, in the project's folder, with a time limit and a cap on what it may print. */
export function spawnCheckRunner(cliEntry: string, timeoutMs = 20_000): CheckRunner {
  return (projectPath) => new Promise((resolve) => {
    execFile(process.execPath, [cliEntry, "check", "--json", "--no-register"], { cwd: projectPath, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env: process.env }, (err, stdout) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 0;
      // Exit 0 and 1 both carry a report (1 = the check found a problem). Exit 2, a timeout or a missing folder carry none.
      if (err && (code === 2 || (err as { killed?: boolean }).killed || typeof (err as { code?: unknown }).code !== "number")) {
        resolve({ error: (err as { killed?: boolean }).killed ? "the check took longer than 20 seconds and was stopped" : "the check could not run in that folder" });
        return;
      }
      resolve({ stdout: String(stdout) });
    });
  });
}

const OUTCOME_WORD: Record<CardOutcome, string> = {
  pass: "clean",
  fail: "problem found",
  error: "could not be completed",
  skipped: "not fully verified",
  "not-applicable": "nothing to check",
};

/** The one-glance words for a card: clean, drifted or problem, never synced / not fully verified. Never "clean" without a pass. */
export function cardCheckWords(s: CardCheckState): { label: string; detail: string; attention: boolean } {
  if (s.kind === "checking") return { label: "checking", detail: "A check is running in the background. Reload in a moment.", attention: false };
  if (s.kind === "unavailable") return { label: "could not be checked", detail: s.why, attention: false };
  return { label: OUTCOME_WORD[s.outcome], detail: s.summary, attention: s.outcome === "fail" || s.outcome === "error" };
}
