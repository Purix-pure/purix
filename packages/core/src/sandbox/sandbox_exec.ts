// src/sandbox/sandbox_exec.ts
import { ambientEnv } from "../platform/env.js";
import { spawnSync, type SpawnStop, type SpawnSyncOptions } from "../platform/spawn_sync.js";
import { existsSync, mkdirSync } from "node:fs";
import { sandboxEnv, strictIsolation } from "./sandbox_env.js";

export type IsolationLevel = "network-namespace" | "os-sandbox" | "none";

export interface IsolatedRunOptions {
  cwd: string;
  writableDir: string; // the one directory the command is allowed to write to
  extraReadOnlyBinds?: string[]; // real paths that need to resolve inside the sandbox (e.g. a symlink target)
  env?: Record<string, string>;
  /** Spawn budget for this run (platform/spawn_sync.ts). Default: the tier default. Only tests and callers with a reason to be tighter set these. */
  deadlineMs?: number;
  maxOutputBytes?: number;
}

export interface IsolatedRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  isolation: IsolationLevel;
  /** F02-03: set when the run was stopped (timeout, output over the cap, out of a resource) or could not be started. Absent on any normal exit, including a failing one. */
  stopped?: SpawnStop;
  /** The signal that ended the run, set with `stopped: "signal"`. */
  signal?: string;
}

function budgetOf(opts: IsolatedRunOptions): Pick<SpawnSyncOptions, "deadlineMs" | "maxOutputBytes"> {
  return { ...(opts.deadlineMs !== undefined ? { deadlineMs: opts.deadlineMs } : {}), ...(opts.maxOutputBytes !== undefined ? { maxOutputBytes: opts.maxOutputBytes } : {}) };
}

function hasBinary(bin: string): boolean {
  return spawnSync(["which", bin], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
}

// Fix (Docker/sandbox isolation gap): hasBinary("bwrap") only proves the
// bwrap binary is on PATH — it says nothing about whether bwrap can
// actually create a sandbox at runtime. Inside a standard (non-privileged)
// Docker container, bwrap is frequently *installed* but fails to start
// because unprivileged user-namespace creation is blocked by Docker's
// default seccomp/AppArmor profile unless the container is run with
// --cap-add SYS_ADMIN / --security-opt seccomp=unconfined, or the host
// kernel disables kernel.unprivileged_userns_clone. Before this fix, that
// failure was indistinguishable from a normal sandboxed-command failure —
// runIsolated returned isolation: "network-namespace" either way, so a
// caller (and verifyInSandbox's result) could report "verified under real
// isolation" for a call where no isolation actually happened. bwrap's own
// startup errors are always emitted with a "bwrap: " prefix and occur
// before the wrapped command produces any stdout, which is what lets us
// tell the two failure modes apart without a bwrap-specific dependency.
const BWRAP_SETUP_FAILURE_PATTERNS = [
  /bwrap: Creating new namespace failed/i,
  /bwrap: setting up uid map/i,
  /bwrap: loopback: Failed/i,
  /bwrap:.*namespace.*permission denied/i,
  /bwrap:.*operation not permitted/i,
  /user namespaces are not permitted/i,
  /clone\(CLONE_NEWUSER\)/i,
];

export function isBwrapSetupFailure(exitCode: number | null, stdout: string, stderr: string): boolean {
  if (exitCode === 0) return false;
  if (stdout.trim().length > 0) return false; // the wrapped command produced output — bwrap itself started fine
  return BWRAP_SETUP_FAILURE_PATTERNS.some((pattern) => pattern.test(stderr));
}

/**
 * Thrown when bwrap is present on PATH but failed to actually create the
 * sandbox namespace — most commonly because we're running inside a
 * container that blocks unprivileged user namespaces. This is deliberately
 * a thrown error, not a returned IsolatedRunResult with isolation: "none",
 * so it cannot be silently mistaken for either (a) a legitimate sandboxed
 * command that happened to fail, or (b) the already-documented "no sandbox
 * tool found, running unisolated and saying so" fallback path. Both of
 * those are known, intentional result shapes; this is neither — it's a
 * broken environment that must stop the caller, not degrade quietly under
 * it.
 */
export class SandboxUnavailableError extends Error {
  constructor(stderr: string) {
    super(
      "bwrap is installed but failed to create an isolated sandbox, most likely because this " +
        "is running inside a container that blocks unprivileged user namespaces (Docker does " +
        "this by default). Refusing to silently fall back to unisolated execution.\n\n" +
        "To fix, either:\n" +
        "  1. Run the container with: --cap-add SYS_ADMIN --security-opt seccomp=unconfined\n" +
        "  2. Run this command outside a container\n" +
        "  3. Explicitly opt into unisolated execution if you understand the risk\n\n" +
        `Raw bwrap error:\n${stderr}`
    );
    this.name = "SandboxUnavailableError";
  }
}

/**
 * Thrown in strict mode (PURIX_STRICT_ISOLATION) when a step would run with no sandbox at all. Like SandboxUnavailableError it is
 * a thrown error and not an `isolation: "none"` result: the person asked for "no sandbox, no run", so the command is never started.
 * verifyInSandbox turns it into an infrastructure result ("sandbox_unavailable"), which the repair loop never acts on.
 */
export class IsolationRequiredError extends Error {
  constructor(what = "this step") {
    super(
      `Strict isolation is on (PURIX_STRICT_ISOLATION), and ${what} would run with no sandbox, so it was not run. ` +
        "A sandbox needs bubblewrap (bwrap) on Linux or sandbox-exec on macOS; Windows has none. " +
        "Install bubblewrap, or unset PURIX_STRICT_ISOLATION to allow unisolated runs (the result will then say isolation: none)."
    );
    this.name = "IsolationRequiredError";
  }
}

/**
 * Section 24's open sandbox-isolation question, given a real (if
 * partial) answer instead of staying an open decision forever.
 *
 * Linux: bubblewrap (bwrap) — the same sandbox runtime Flatpak uses,
 * no root or daemon needed. Denies network entirely (--unshare-net is
 * the actual "egress denial by default" guarantee), restricts writes to
 * exactly writableDir, everything else read-only or absent.
 *
 * macOS: sandbox-exec — deprecated by Apple but still shipped and
 * functional. Generated profile denies network, scopes writes the same way.
 *
 * Neither found (including all of Windows): runs unisolated and SAYS SO
 * — the caller is expected to surface that to the person, same "fail
 * loud, not silent" rule verify.ts already follows for its own tsc
 * fallback. This is a reasonable default recipe, not a guarantee against
 * every environment quirk — if Node or a toolchain binary needs to read
 * its own cache dir (npm's ~/.npm, pnpm's local store) and the bwrap
 * profile below doesn't allow it, that shows up as a sandbox config
 * problem, not a code problem. Widen the binds if so.
 */
export function runIsolated(command: string[], opts: IsolatedRunOptions): IsolatedRunResult {
  // extraReadOnlyBinds are frequently toolchain-owned cache/gopath/bundle/target
  // dirs computed via toolchainSubdir(), which only guarantees its *parent*
  // (.purix/tmp/<lang>) exists, not the leaf subdir itself. bwrap's --ro-bind
  // (and macOS's subpath allow, for consistency) needs a real path on disk —
  // without this, the very first sandboxed call for a language whose install()
  // step hasn't already created that leaf dir as a side effect fails with
  // "Can't find source path", independent of anything the command itself does.
  // Creating an empty dir here is always safe: it's exactly what an empty
  // toolchain cache looks like before first use.
  for (const bindPath of opts.extraReadOnlyBinds ?? []) {
    if (!existsSync(bindPath)) {
      mkdirSync(bindPath, { recursive: true });
    }
  }

  if (process.platform === "linux" && hasBinary("bwrap")) {
    const extraBinds = (opts.extraReadOnlyBinds ?? []).flatMap((p) => ["--ro-bind", p, p]);
    const bwrapArgs = [
      "bwrap",
      "--ro-bind", "/usr", "/usr",
      "--ro-bind", "/bin", "/bin",
      "--ro-bind", "/lib", "/lib",
      ...(existsSync("/lib64") ? ["--ro-bind", "/lib64", "/lib64"] : []),
      "--dev", "/dev",
      "--proc", "/proc",
      "--tmpfs", "/tmp",
      // These three come AFTER --tmpfs /tmp on purpose. bwrap applies bind
      // operations in argument order, and a later mount on a path nested
      // inside an earlier one wins for that nested path. opts.cwd /
      // opts.writableDir / extraReadOnlyBinds are frequently themselves
      // under the OS temp dir (e.g. verifyInSandbox's mkdtempSync(tmpdir())
      // root) — with --tmpfs /tmp listed first, punching the real binds in
      // afterward correctly exposes them through the fresh tmpfs. The
      // previous order (tmpfs last) silently shadowed any cwd/writableDir
      // under /tmp with an empty tmpfs, which is why bwrap would fail with
      // "Can't chdir to <path>: No such file or directory" for exactly the
      // callers (drift/migration verification) that use a system tmp dir.
      "--ro-bind", opts.cwd, opts.cwd,
      "--bind", opts.writableDir, opts.writableDir,
      ...extraBinds,
      "--unshare-net",
      "--unshare-pid",
      "--die-with-parent",
      "--chdir", opts.cwd,
      ...command,
    ];
    const result = spawnSync(bwrapArgs, { stdout: "pipe", stderr: "pipe", env: { ...sandboxEnv({ home: opts.writableDir }), ...(opts.env ?? {}) }, ...budgetOf(opts) });
    const resultStdout = result.stdout.toString();
    const resultStderr = result.stderr.toString();
    // A run that was stopped (deadline, output cap) has no exit code and no words of its own, so it must not be mistaken for a setup failure.
    if (!result.stopped && isBwrapSetupFailure(result.exitCode, resultStdout, resultStderr)) {
      throw new SandboxUnavailableError(resultStderr);
    }
    return { exitCode: result.exitCode, stdout: resultStdout, stderr: resultStderr, isolation: "network-namespace", ...(result.stopped ? { stopped: result.stopped } : {}), ...(result.signal ? { signal: result.signal } : {}) };
  }

  if (process.platform === "darwin" && hasBinary("sandbox-exec")) {
    // Security fix (review finding #2): the previous profile used a blanket
    // (allow file-read*), meaning sandboxed code could read anything the
    // invoking user could read (~/.ssh, ~/.aws/credentials, cookie stores,
    // etc.) and stage it into writableDir, from where it could surface in a
    // manifest entry or be forwarded to the escalation LLM as "neighbor
    // context." Tightened to an explicit read allowlist mirroring the Linux
    // bwrap path above — real toolchain/OS paths plus cwd, nothing broader.
    // Widen this list if a real sandboxed run fails on a missing path
    // (e.g. a toolchain's own cache dir), same "widen the binds" note as
    // bwrap. ~/.npm and pnpm's local store cover the common case of a
    // fallback `npx`/`pnpm dlx` invocation needing to read its cache;
    // this does not grant write access to either, only read.
    const home = ambientEnv("HOME") ?? "";
    const readAllowSubpaths = [
      "/usr",
      "/bin",
      "/System/Library",
      "/private/tmp",
      "/dev",
      opts.cwd,
      ...(home ? [`${home}/.npm`, `${home}/Library/pnpm`, `${home}/.local/share/pnpm`] : []),
      ...(opts.extraReadOnlyBinds ?? []),
    ];
    const profile = `
(version 1)
(deny default)
(allow process-fork)
${readAllowSubpaths.map((p) => `(allow file-read* (subpath "${p}"))`).join("\n")}
(allow file-write* (subpath "${opts.writableDir}"))
(deny network*)
`.trim();
    const result = spawnSync(["sandbox-exec", "-p", profile, ...command], {
      cwd: opts.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...sandboxEnv({ home: opts.writableDir }), ...(opts.env ?? {}) },
      ...budgetOf(opts),
    });
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString(), isolation: "os-sandbox", ...(result.stopped ? { stopped: result.stopped } : {}), ...(result.signal ? { signal: result.signal } : {}) };
  }

  // A4-1: no sandbox tool on this machine. Strict mode refuses; otherwise it runs unisolated and says so (isolation: "none").
  if (strictIsolation()) throw new IsolationRequiredError(`the command "${command[0] ?? ""}"`);
  const result = spawnSync(command, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe", env: { ...sandboxEnv({ home: opts.writableDir }), ...(opts.env ?? {}) }, ...budgetOf(opts) });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString(), isolation: "none", ...(result.stopped ? { stopped: result.stopped } : {}), ...(result.signal ? { signal: result.signal } : {}) };
}