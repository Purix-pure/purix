// src/cli/commands/observe.ts
//
// `purix watch`, `purix statusline`, `purix feedback`: three ways to see what Purix did, all reading the same record
// (core observe/ledger_reader.ts) the result line and the dashboard read. None of them can change what Purix decided: watch and
// statusline only read; feedback adds one record, the person's own answer to "did this help?", and nothing reads it to decide anything.
//
// Approval stays in the terminal: watch NAMES a waiting request and the command that answers it, but there is no key or flag here
// that answers one. That is the rule `purix approve` exists to keep.
import type { Command } from "commander";
import { resolve } from "node:path";

export const FEEDBACK_REASONS = ["wrong", "slow", "too-many-prompts", "other"] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

// ---------------------------------------------------------------------------------------------------- watch

export interface WatchDeps {
  stateDir: string;
  baseDir: string;
  out: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  /** Stops the loop when it fires. */
  signal?: AbortSignal;
  intervalMs: number;
  /** How many recent events to show before following. */
  last: number;
  /** Print what is there and return, instead of following. */
  once: boolean;
}

/** Follows the project's record and prints one line per event and per waiting approval. Returns when `signal` fires, or at once with `once`. */
export async function runWatch(deps: WatchDeps): Promise<void> {
  const { openLedger } = await import("@purix/core/observe/ledger_reader");
  const { eventLine, waitingLine } = await import("@purix/core/observe/event_lines");
  const { listApprovals } = await import("@purix/core/approvals/pending");

  const announced = new Set<string>();
  const announceWaiting = () => {
    try {
      for (const r of listApprovals(deps.baseDir, deps.now())) {
        if (r.state === "pending" && !announced.has(r.id)) {
          announced.add(r.id);
          deps.out(waitingLine(r.id, r.tool, r.componentId, deps.now()));
        }
      }
    } catch { /* a side channel: an unreadable approvals folder means no WAITING line this time */ }
  };

  let ledger = openLedger(deps.stateDir);
  if (!ledger) {
    deps.out("No Purix record here yet. Waiting for the first change; stop with Ctrl+C.");
    if (deps.once) return;
  }
  let cursor = 0;
  if (ledger) {
    const max = ledger.maxEventRowid();
    const from = Math.max(0, max - Math.max(1, deps.last) * 6);
    const recent = ledger.eventsAfter(from, Math.max(1, deps.last) * 6).map((e) => ({ e, line: eventLine(e) })).filter((x) => x.line !== null).slice(-Math.max(1, deps.last));
    for (const x of recent) deps.out(x.line!);
    cursor = max;
    announceWaiting();
    if (deps.once) { ledger.close(); return; }
    deps.out("Watching. New events appear below. Stop with Ctrl+C.");
  }
  while (!deps.signal?.aborted) {
    await deps.sleep(deps.intervalMs);
    if (deps.signal?.aborted) break;
    ledger ??= openLedger(deps.stateDir);
    if (!ledger) continue;
    try {
      for (const e of ledger.eventsAfter(cursor)) {
        cursor = Math.max(cursor, e.rowid);
        const line = eventLine(e);
        if (line) deps.out(line);
      }
    } catch { /* a read that fails is tried again on the next tick */ }
    announceWaiting();
  }
  ledger?.close();
}

// ------------------------------------------------------------------------------------------------ statusline

/** What Claude Code sends a status line command on stdin (only the fields used here). */
export interface StatuslineInput { cwd?: string; workspace?: { current_dir?: string; project_dir?: string } }

export function parseStatuslineInput(text: string): StatuslineInput {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" ? (v as StatuslineInput) : {};
  } catch {
    return {};
  }
}

export type StatuslineRange = "today" | "7d" | "all";

export function sinceFor(range: StatuslineRange, now: Date): string | undefined {
  if (range === "all") return undefined;
  if (range === "7d") return new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

type LedgerModule = typeof import("@purix/core/observe/ledger_reader");

/** The status line text for one project's record, or null when Purix has nothing recorded there. */
export function statuslineText(stateDir: string, range: StatuslineRange, now: Date, waiting: number, mod: LedgerModule): string | null {
  const ledger = mod.openLedger(stateDir);
  if (!ledger) return null;
  try {
    const s = ledger.summary({ since: sinceFor(range, now) });
    const parts: string[] = [`${s.changesLandedInRange} landed`];
    if (s.stopped.total > 0) parts.push(`${s.stopped.total} stopped`);
    if (s.tests.totals.passed > 0) parts.push(`${s.tests.totals.passed} tests`);
    if (s.spend) parts.push(`$${s.spend.spentUsd.toFixed(2)} of $${s.spend.ceilingUsd.toFixed(2)}`);
    if (waiting > 0) parts.push(`${waiting} waiting (purix approve)`);
    return `Purix ${range === "today" ? "today" : range === "7d" ? "7d" : "all time"}: ${parts.join(" · ")}`;
  } finally {
    ledger.close();
  }
}

export interface StatuslineSetupOpts { range: string; install?: boolean; uninstall?: boolean; status?: boolean; shared?: boolean; user?: boolean }

/**
 * `purix statusline --install | --uninstall | --status`. Returns the exit code (0 done or nothing to do, 1 not changed because of what is
 * in the file). It writes only Claude Code's own settings file, never the project's record, and says where.
 */
export async function runStatuslineSetup(opts: StatuslineSetupOpts, root: string, out: (line: string) => void, home?: string): Promise<number> {
  const m = await import("@purix/core/observe/statusline_install");
  const scope: import("@purix/core/observe/statusline_install").StatuslineScope = opts.user ? "user" : opts.shared ? "shared" : "local";
  const range = opts.range as import("@purix/core/observe/statusline_install").StatuslineRangeArg;
  if (opts.status) {
    for (const s of m.STATUSLINE_SCOPES) {
      const { path, state } = m.readStatuslineState(s, root, home);
      const say = state.state === "installed" ? `✅ installed (${state.command})` : state.state === "other" ? `➖ another status line is set (${state.command}); Purix leaves it alone` : state.state === "unreadable" ? `⚠  ${state.error}` : "➖ not installed";
      out(`${s.padEnd(7)} ${path}: ${say}`);
    }
    out("\nA higher level wins in Claude Code: the personal project file over the committed one over your user file. \"Installed\" is not \"showing\": restart Claude Code and accept the folder's trust prompt, which the status line waits for.");
    return 0;
  }
  if (opts.uninstall) {
    const { path, result } = m.uninstallStatusline(scope, root, home);
    if (!result.ok) { out(`❌ not changed (${path}): ${result.error}`); return 1; }
    out(`${result.changed ? "✅ status line removed from" : "✔  no Purix status line in"} ${path}`);
    return 0;
  }
  const { path, created, result } = m.installStatusline(scope, root, range, home);
  if (!result.ok) { out(`❌ not changed (${path}): ${result.error}`); return 1; }
  out(`${result.changed ? "✅ status line written to" : "✔  already installed in"} ${path}`);
  out("Restart Claude Code (or open a new session) and accept the folder's trust prompt: Claude Code shows a status line only after the folder is trusted, and only when the command exits 0 and prints something.");
  out("It prints nothing in a folder where Purix has recorded nothing. Needs `purix` on the PATH of the shell Claude Code uses.");
  if (created && scope === "local") out("Note: this created .claude/settings.local.json. It is meant to stay out of git; if this folder is a git repository and the file is not already ignored, add it to .gitignore.");
  if (scope === "user") out("This applies to every project on this machine; remove it with `purix statusline --uninstall --user`.");
  return 0;
}

async function readStdin(limitMs: number): Promise<string> {
  if (process.stdin.isTTY) return "";
  return new Promise<string>((resolveText) => {
    let data = "";
    const done = () => { clearTimeout(timer); process.stdin.pause(); resolveText(data); };
    const timer = setTimeout(done, limitMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { data += c; if (data.length > 1_000_000) done(); });
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

// ------------------------------------------------------------------------------------------------ registration

export function registerObserveCommands(program: Command) {
  program
    .command("watch")
    .description("Show what Purix is doing in this project, live: checks, stops, and approvals waiting for you (read-only)")
    .option("--last <n>", "how many recent events to show first", "10")
    .option("--interval <ms>", "how often to look for new events", "1000")
    .option("--once", "print what is there now and exit")
    .action(async (opts: { last: string; interval: string; once?: boolean }) => {
      const last = Number(opts.last), interval = Number(opts.interval);
      if (!Number.isInteger(last) || last < 1 || last > 500 || !Number.isInteger(interval) || interval < 200 || interval > 60_000) {
        console.error("Bad input: --last must be a whole number from 1 to 500 and --interval from 200 to 60000.");
        process.exitCode = (await import("@purix/core/cli-io/exit_codes")).EXIT.USAGE;
        return;
      }
      const { resolveSharedStateDir } = await import("@purix/core/state/git_common_dir");
      const controller = new AbortController();
      process.once("SIGINT", () => controller.abort());
      await runWatch({
        stateDir: resolveSharedStateDir(), baseDir: process.cwd(), out: (l) => console.log(l),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => new Date(), signal: controller.signal,
        intervalMs: interval, last, once: Boolean(opts.once),
      });
    });

  program
    .command("statusline")
    .description("One line of Purix facts for an agent's status line (Claude Code runs it and passes JSON on stdin). --install wires it into Claude Code")
    .option("--range <range>", "today, 7d or all", "today")
    .option("--install", "add it to Claude Code's settings as the status line (never replaces one that is not Purix's)")
    .option("--uninstall", "remove the status line this command added (and only that one)")
    .option("--status", "show where it is installed")
    .option("--shared", "with --install, --uninstall or --status: use the committed .claude/settings.json instead of the personal, uncommitted file")
    .option("--user", "with --install, --uninstall or --status: use ~/.claude/settings.json, so every project gets it")
    .action(async (opts: { range: string; install?: boolean; uninstall?: boolean; status?: boolean; shared?: boolean; user?: boolean }) => {
      const { EXIT } = await import("@purix/core/cli-io/exit_codes");
      if (opts.range !== "today" && opts.range !== "7d" && opts.range !== "all") {
        console.error("Bad input: --range must be today, 7d or all.");
        process.exitCode = EXIT.USAGE;
        return;
      }
      const modes = [opts.install, opts.uninstall, opts.status].filter(Boolean).length;
      if (modes > 1 || (opts.shared && opts.user) || ((opts.shared || opts.user) && modes === 0)) {
        console.error("Bad input: use one of --install, --uninstall, --status, and at most one of --shared or --user with it.");
        process.exitCode = EXIT.USAGE;
        return;
      }
      if (modes === 1) {
        process.exitCode = await runStatuslineSetup(opts, process.cwd(), console.log);
        return;
      }
      const input = parseStatuslineInput(await readStdin(300));
      const dir = resolve(input.workspace?.current_dir ?? input.workspace?.project_dir ?? input.cwd ?? process.cwd());
      const { findProjectRoot } = await import("@purix/core/platform/project_root");
      const root = findProjectRoot(dir)?.root ?? dir;
      const { resolveSharedStateDir } = await import("@purix/core/state/git_common_dir");
      const mod = await import("@purix/core/observe/ledger_reader");
      let waiting = 0;
      try {
        const { listApprovals } = await import("@purix/core/approvals/pending");
        waiting = listApprovals(root).filter((r) => r.state === "pending").length;
      } catch { /* unknown: say nothing about it */ }
      // A status line must never fail the agent's screen: nothing recorded, or an unreadable record, prints nothing and exits 0.
      const text = statuslineText(resolveSharedStateDir(root), opts.range, new Date(), waiting, mod);
      if (text) console.log(text);
    });

  program
    .command("feedback")
    .description("Say whether a change helped (your own answer, kept on this machine, shown beside the measured numbers)")
    .argument("<answer>", "yes or no")
    .argument("[changeId]", "the change's id (default: the most recent change)")
    .option("--reason <reason>", `why, when the answer is no: ${FEEDBACK_REASONS.join(", ")}`)
    .action(async (answer: string, changeId: string | undefined, opts: { reason?: string }) => {
      const { EXIT } = await import("@purix/core/cli-io/exit_codes");
      const a = answer.toLowerCase();
      if (a !== "yes" && a !== "no") { console.error('Bad input: the answer must be "yes" or "no".'); process.exitCode = EXIT.USAGE; return; }
      if (opts.reason !== undefined && !(FEEDBACK_REASONS as readonly string[]).includes(opts.reason)) {
        console.error(`Bad input: --reason must be one of ${FEEDBACK_REASONS.join(", ")}.`); process.exitCode = EXIT.USAGE; return;
      }
      const { storeExists, NO_STATE_MESSAGE } = await import("@purix/core/manifest/store");
      if (!storeExists()) { console.log(NO_STATE_MESSAGE); return; }
      const { openLedger } = await import("@purix/core/observe/ledger_reader");
      const { resolveSharedStateDir } = await import("@purix/core/state/git_common_dir");
      const ledger = openLedger(resolveSharedStateDir());
      let target = changeId;
      try {
        if (!target) target = ledger?.changes({ limit: 1 })[0]?.changeId;
        if (!target || !ledger?.change(target)) {
          console.error(target ? `No change "${target}" in this project's record.` : "No change with an id has been recorded here yet.");
          process.exitCode = EXIT.USAGE;
          return;
        }
      } finally { ledger?.close(); }
      const { recordEvent } = await import("@purix/core/manifest/events");
      const { LEDGER_SCHEMA_VERSION } = await import("@purix/core/observe/ledger_version");
      recordEvent("change_feedback", { detail: { schema: LEDGER_SCHEMA_VERSION, change_id: target, helped: a === "yes", ...(opts.reason ? { reason: opts.reason } : {}) } });
      console.log(`Recorded: ${a === "yes" ? "helped" : "did not help"} (${target}). This stays on this machine.`);
    });
}
