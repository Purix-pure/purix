// src/platform/spawn_sync.ts
//
// Runtime migration (ADR-009 / ADR-016): Bun's global `spawnSync` had one
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

export interface SpawnSyncOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdout?: "pipe";
  stderr?: "pipe";
}

export interface SpawnSyncResult {
  exitCode: number | null;
  stdout: { toString(): string };
  stderr: { toString(): string };
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
 */
export function spawnSync(command: string[], opts: SpawnSyncOptions = {}): SpawnSyncResult {
  const [bin, ...args] = command;
  if (!bin) {
    return { exitCode: null, stdout: { toString: () => "" }, stderr: { toString: () => "" } };
  }
  const result = crossSpawn.sync(bin, args, {
    cwd: opts.cwd,
    env: opts.env as NodeJS.ProcessEnv | undefined,
    encoding: "buffer",
  });
  if (result.error) {
    return { exitCode: null, stdout: { toString: () => "" }, stderr: { toString: () => String(result.error?.message ?? "") } };
  }
  return {
    exitCode: result.status,
    stdout: { toString: () => (result.stdout ?? Buffer.alloc(0)).toString("utf-8") },
    stderr: { toString: () => (result.stderr ?? Buffer.alloc(0)).toString("utf-8") },
  };
}
