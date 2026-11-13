// src/platform/spawn_sync.ts
//
// Runtime migration (ADR-048 / ADR-040): Bun's global `spawnSync` had one
// call shape used identically at all four of its call sites in this
// codebase — sandbox/sandbox_exec.ts, verify/verify.ts, verify/idiom.ts,
// security/deps_audit.ts — command as a single string array, options as
// { cwd?, env?, stdout: "pipe", stderr: "pipe" }, result read back as
// { exitCode, stdout, stderr } with stdout/stderr exposing .toString().
//
// Node's node:child_process.spawnSync has a different shape: command and
// args are separate parameters, and the result uses `status` (not
// `exitCode`) plus Buffer stdout/stderr. Rather than hand-adapt that
// difference at four separate call sites — which is exactly the kind of
// drift that leaves one call site handling a null exit code differently
// from another — this is the one place that shape translation happens.
// Every call site below keeps calling `spawnSync(commandArray, opts)` and
// reading `.exitCode` / `.stdout.toString()` / `.stderr.toString()`
// exactly as before; only the import path changes.
import crossSpawn from "cross-spawn";

// ---------------------------------------------------------------------------------------------------------------------
// A1 shared rail: one table of time and output budgets for every child process.
//
// Before this, spawnSync set no `timeout`, no `killSignal` and no `maxBuffer` (research 02 §1.1, §1.2; reproduced on the
// current code): a child that never ends was waited on for as long as it ran, and output over Node's default 1 MiB came back
// as `exitCode: null` with the output dropped and an ENOBUFS message, which every caller then read as "binary not found".
//
// Tiers follow research 02 section 7: T0 hook lookup, T1 secret scan / security gate / parse check, T2 selected tests and
// incremental compile, T3 dependents cascade and full affected tests, T4 merge queue and scheduled scans.
//
// PROVISIONAL NUMBERS. `targetMs` is the research's target. `deadlineMs` is the hard stop and is MY CHOICE, not a measurement:
// research 02 section 1.1 says to replace it with three times the project's measured P95 once there is timing data. Nothing
// here has been measured on a real project. Do not quote these as evidence-backed limits.
// ---------------------------------------------------------------------------------------------------------------------
export type SpawnTier = "T0" | "T1" | "T2" | "T3" | "T4";

export interface TierBudget {
  /** The tier's published target, for reporting only. Never enforced. */
  readonly targetMs: number | null;
  /** Hard stop. The child is killed and the call reports `stopped: "timeout"`. */
  readonly deadlineMs: number;
  /** Hard cap on captured stdout or stderr, each. Above it the call reports `stopped: "output_limit"`. */
  readonly maxOutputBytes: number;
}

const ONE_MIB = 1024 * 1024;

export const TIER_BUDGETS: Readonly<Record<SpawnTier, TierBudget>> = Object.freeze({
  T0: Object.freeze({ targetMs: 100, deadlineMs: 1_000, maxOutputBytes: ONE_MIB }),
  T1: Object.freeze({ targetMs: 2_000, deadlineMs: 10_000, maxOutputBytes: ONE_MIB }),
  T2: Object.freeze({ targetMs: 10_000, deadlineMs: 60_000, maxOutputBytes: ONE_MIB }),
  T3: Object.freeze({ targetMs: null, deadlineMs: 600_000, maxOutputBytes: ONE_MIB }),
  T4: Object.freeze({ targetMs: null, deadlineMs: 3_600_000, maxOutputBytes: ONE_MIB }),
});

/**
 * The tier a call gets when it names none. T3, the loosest interactive tier, so an existing caller is only ever stopped by a
 * run that goes past ten minutes. This is the one deliberate behaviour change in A1: before, no run was ever stopped.
 */
export const DEFAULT_SPAWN_TIER: SpawnTier = "T3";

export interface SpawnSyncOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdout?: "pipe";
  stderr?: "pipe";
  /** Budget row to use. Default: DEFAULT_SPAWN_TIER. */
  tier?: SpawnTier;
  /** Overrides the tier's deadline for this call. Must be a positive finite number, else the tier's value is used. */
  deadlineMs?: number;
  /** Overrides the tier's output cap (per stream) for this call. Must be a positive finite number, else the tier's value is used. */
  maxOutputBytes?: number;
}

/**
 * Why a call ended without a normal exit, when this wrapper can tell. Absent on a normal exit, including a non-zero one.
 * Every value here is an infrastructure result (verify/outcome.ts infrastructureKindOfStop), never a failure of the code under test.
 */
export type SpawnStop = "timeout" | "output_limit" | "resource_limit" | "not_found" | "spawn_error" | "signal";

export interface SpawnSyncResult {
  exitCode: number | null;
  stdout: { toString(): string };
  stderr: { toString(): string };
  /** Set when the call ended abnormally (see SpawnStop). Optional, so a caller written before this field existed is unaffected. */
  stopped?: SpawnStop;
  /** The signal that ended the child, set with `stopped: "signal"` (for example "SIGKILL"). */
  signal?: string;
  /** Wall-clock time the call took, in milliseconds. */
  durationMs?: number;
}

function positive(n: number | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** The budget a call will run under: tier row, with a valid per-call override winning over it. Exported so tests can read it. */
export function resolveSpawnBudget(opts: Pick<SpawnSyncOptions, "tier" | "deadlineMs" | "maxOutputBytes"> = {}): { tier: SpawnTier; deadlineMs: number; maxOutputBytes: number } {
  const tier = opts.tier && opts.tier in TIER_BUDGETS ? opts.tier : DEFAULT_SPAWN_TIER;
  const row = TIER_BUDGETS[tier];
  return {
    tier,
    deadlineMs: positive(opts.deadlineMs) ? opts.deadlineMs : row.deadlineMs,
    maxOutputBytes: positive(opts.maxOutputBytes) ? Math.floor(opts.maxOutputBytes) : row.maxOutputBytes,
  };
}

/** Maps a spawn error's code onto SpawnStop. Exported for tests. */
export function stopFromErrorCode(code: string | undefined): SpawnStop {
  if (code === "ETIMEDOUT") return "timeout";
  if (code === "ENOBUFS") return "output_limit";
  if (code === "ENOENT") return "not_found";
  // The machine, not the command, ran out of something (file handles, memory, process slots).
  if (code === "EMFILE" || code === "ENFILE" || code === "ENOMEM" || code === "EAGAIN") return "resource_limit";
  return "spawn_error";
}

/**
 * `command` is the full argv, e.g. ["bwrap", "--ro-bind", ...] or
 * ["npm", "audit", "--json"] — command[0] is the binary, the rest are
 * its arguments, matching how every existing call site already builds
 * this array for Bun's API.
 *
 * A missing binary (ENOENT) does not throw here — it comes back as
 * exitCode: null with empty stdout/stderr, the same shape Bun returns
 * for a failed spawn, so `hasBinary()` in sandbox_exec.ts (which checks
 * `.exitCode === 0`) keeps working unmodified.
 *
 * Every call now runs under a deadline and an output cap from TIER_BUDGETS. When one is hit the shape is unchanged
 * (exitCode: null, empty stdout, the error text on stderr) and `stopped` says which it was, so a caller that cares can tell a
 * timeout or an overflow from a missing binary. Known limit: this is a synchronous call, so on a timeout only the direct child
 * is killed; a grandchild it started may outlive it. A tree kill needs the async form (research 02 §1.1, option C).
 */
export function spawnSync(command: string[], opts: SpawnSyncOptions = {}): SpawnSyncResult {
  const [bin, ...args] = command;
  if (!bin) {
    return { exitCode: null, stdout: { toString: () => "" }, stderr: { toString: () => "" }, stopped: "spawn_error", durationMs: 0 };
  }
  const budget = resolveSpawnBudget(opts);
  const started = Date.now();
  const result = crossSpawn.sync(bin, args, {
    cwd: opts.cwd,
    env: opts.env,
    encoding: "buffer",
    timeout: budget.deadlineMs,
    killSignal: "SIGKILL",
    maxBuffer: budget.maxOutputBytes,
  });
  const durationMs = Date.now() - started;
  if (result.error) {
    return {
      exitCode: null,
      stdout: { toString: () => "" },
      stderr: { toString: () => String(result.error?.message ?? "") },
      stopped: stopFromErrorCode((result.error as NodeJS.ErrnoException).code),
      durationMs,
    };
  }
  // N3 (F02-03 remainder): a child that a signal ended (kill -9, an out-of-memory kill) has no exit status and Node reports no `error`,
  // so it used to look like an ordinary failing exit with nothing to read. The deadline and the output cap also kill with a signal, but
  // those come back through `result.error` above and are labelled there.
  const signalled = result.status === null && typeof result.signal === "string";
  return {
    exitCode: result.status,
    stdout: { toString: () => (result.stdout ?? Buffer.alloc(0)).toString("utf-8") },
    stderr: { toString: () => (result.stderr ?? Buffer.alloc(0)).toString("utf-8") },
    ...(signalled ? { stopped: "signal" as const, signal: result.signal as string } : {}),
    durationMs,
  };
}
