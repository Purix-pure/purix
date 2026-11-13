// packages/core/src/tools/installer.ts
//
// ADR-060 D3/D4: install one catalog entry. No prompting here (that is consent.ts), no audit (that is
// broker.ts); this file only does the install and says what happened. Every step that can refuse
// returns a typed reason instead of throwing.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync, type SpawnStop } from "../platform/spawn_sync.js";
import { hashLockFiles, validateEntry } from "./catalog.js";
import { createFileExclusive, writeFileAtomic } from "../platform/atomic_write.js";
import { toolDir } from "./state.js";
import type { CatalogEntry, LockRecord, Platform, RefusalReason } from "./types.js";

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Why the command ended without a normal exit, when the runner can tell (platform/spawn_sync.ts). Optional: a runner written before this field existed is unaffected. */
  stopped?: SpawnStop;
  /** The signal that ended the command, set with stopped: "signal" (for example "SIGKILL"). */
  signal?: string;
}

/**
 * Hard stop for one install command (venv, pip install, npm ci). PROVISIONAL, my choice and not a measurement: research 12
 * measured cold installs of 0.6 to 48 s on one machine with a warm network, so five minutes leaves room for a slow link while
 * a hang no longer waits out the shared default of ten. Replace it when there is timing data from real projects.
 */
export const INSTALL_DEADLINE_MS = 300_000;
/** Hard stop for `python --version` and the like. */
const PROBE_DEADLINE_MS = 10_000;

/** Process port. The default wraps platform/spawn_sync.ts (cross-spawn), the repo's one spawn point. */
export interface Runner {
  run(argv: string[], opts: { cwd: string; deadlineMs?: number }): RunResult;
}

export const defaultRunner: Runner = {
  run(argv, opts) {
    const r = spawnSync(argv, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe", ...(opts.deadlineMs ? { deadlineMs: opts.deadlineMs } : {}) });
    return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString(), ...(r.stopped ? { stopped: r.stopped } : {}), ...(r.signal ? { signal: r.signal } : {}) };
  },
};

export interface InstallContext {
  baseDir: string;
  platform: Platform;
  now: Date;
  runner: Runner;
  minReleaseAgeDays: number;
  /** Hard stop for each install command. Default INSTALL_DEADLINE_MS. */
  deadlineMs?: number;
}

export type InstallOutcome =
  | { ok: true; record: LockRecord }
  | { ok: false; reason: RefusalReason; message: string; hint?: string };

const DAY_MS = 86_400_000;

function fail(reason: RefusalReason, message: string, hint?: string): InstallOutcome {
  return { ok: false, reason, message, ...(hint ? { hint } : {}) };
}

export function binRelPath(entry: CatalogEntry, platform: Platform): string {
  if (entry.method === "pip-venv") {
    return platform === "win32" ? `venv/Scripts/${entry.bin}.exe` : `venv/bin/${entry.bin}`;
  }
  return platform === "win32" ? `node_modules/.bin/${entry.bin}.cmd` : `node_modules/.bin/${entry.bin}`;
}

/** Checks that need no disk and no network. Shared by install and by `plan`-time explanations. */
export function preflight(entry: CatalogEntry, ctx: Pick<InstallContext, "platform" | "now" | "minReleaseAgeDays">): InstallOutcome | null {
  if (!entry.platforms.includes(ctx.platform)) {
    return fail("unsupported-platform", `${entry.id} is not offered for ${ctx.platform} (offered for: ${entry.platforms.join(", ")}).`);
  }
  const ageMs = ctx.now.getTime() - Date.parse(entry.releasedAt);
  if (ageMs < ctx.minReleaseAgeDays * DAY_MS) {
    return fail(
      "too-new",
      `${entry.id}@${entry.version} was released ${entry.releasedAt.slice(0, 10)}, less than ${ctx.minReleaseAgeDays} days ago; refusing to install a version that new.`,
      "New releases are held back so a malicious publish can be noticed and pulled first."
    );
  }
  if (entry.lockSha256 !== hashLockFiles(entry.files)) {
    return fail("lock-hash-mismatch", `${entry.id}: the catalog's lock files do not match their recorded sha256. The catalog is damaged or was edited.`);
  }
  const problems = validateEntry(entry);
  if (problems.length > 0) {
    return fail("lock-invalid", `${entry.id}: catalog lock is not fully pinned and hashed (${problems[0]}).`);
  }
  return null;
}

/**
 * A command that was stopped (time limit, output cap, machine out of resources) is infrastructure, not "the tool is missing" and
 * not "the command failed". Null when the command ended on its own.
 */
function stoppedCommand(label: string, r: RunResult, deadlineMs: number): InstallOutcome | null {
  if (r.stopped === "timeout") {
    return fail("install-timeout", `${label} was stopped after ${Math.round(deadlineMs / 1000)} seconds because it ran past its time limit. This is not a problem with the tool or your project.`, "Check your network or registry mirror and run this again.");
  }
  if (r.stopped === "output_limit" || r.stopped === "resource_limit") {
    return fail("install-limit", `${label} was stopped because ${r.stopped === "output_limit" ? "it printed more than its output limit" : "the machine ran out of memory, file handles or processes"}. This is not a problem with the tool or your project.`, "Free some resources and run this again.");
  }
  // N3 follow-up: a signal ended the command (kill -9, the kernel's out-of-memory killer). Not "program missing", not a failing exit.
  if (r.stopped === "signal") {
    return fail("command-failed", `${label} was ended by a signal${r.signal ? ` (${r.signal})` : ""}. Purix cannot tell whether something outside or the command itself did it. This is not shown to be a problem with the tool or your project.`, "Run this again; if it repeats, check the machine's memory and process limits.");
  }
  return null;
}

function failedCommand(label: string, r: RunResult): InstallOutcome {
  const detail = (r.stderr.trim() || r.stdout.trim() || (r.exitCode === null ? "could not start the command" : `exit code ${r.exitCode}`)).slice(0, 600);
  return fail("command-failed", `${label} failed: ${detail}`);
}

export function installEntry(entry: CatalogEntry, ctx: InstallContext): InstallOutcome {
  const refused = preflight(entry, ctx);
  if (refused) return refused;

  const deadlineMs = ctx.deadlineMs ?? INSTALL_DEADLINE_MS;
  const dir = toolDir(ctx.baseDir, entry.id);
  mkdirSync(dir, { recursive: true });
  // The folder ignores itself, same convention as .purix/tmp (platform/layout.ts).
  createFileExclusive(join(dir, ".gitignore"), "# Purix tool install: safe to delete.\n*\n");
  for (const [name, content] of Object.entries(entry.files)) writeFileAtomic(join(dir, name), content);

  if (entry.method === "pip-venv") {
    const py = findPython(ctx, dir);
    if (!py) {
      return fail("runtime-missing", "Python was not found on PATH.", "Install Python 3.10 or newer from https://www.python.org/downloads/ and run this again.");
    }
    const venv = join(dir, "venv");
    if (!existsSync(venv)) {
      const r = ctx.runner.run([py, "-m", "venv", venv], { cwd: dir, deadlineMs });
      const stoppedVenv = stoppedCommand("Creating the virtual environment", r, deadlineMs);
      if (stoppedVenv) return stoppedVenv;
      if (r.exitCode !== 0) return failedCommand("creating the virtual environment", r);
    }
    const venvPython = ctx.platform === "win32" ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");
    const r = ctx.runner.run(
      [venvPython, "-m", "pip", "install", "--require-hashes", "--only-binary", ":all:", "--no-deps", "--disable-pip-version-check", "--no-input", "-r", join(dir, "requirements.txt")],
      { cwd: dir, deadlineMs }
    );
    const stoppedPip = stoppedCommand("pip install", r, deadlineMs);
    if (stoppedPip) return stoppedPip;
    if (r.exitCode !== 0) return failedCommand("pip install", r);
  } else {
    const r = ctx.runner.run(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: dir, deadlineMs });
    const stoppedNpm = stoppedCommand("npm ci", r, deadlineMs);
    if (stoppedNpm) return stoppedNpm;
    if (r.exitCode !== 0) {
      if (r.exitCode === null) return fail("runtime-missing", "npm was not found on PATH.", "Install Node.js (which includes npm) and run this again.");
      return failedCommand("npm ci", r);
    }
  }

  const rel = binRelPath(entry, ctx.platform);
  if (!existsSync(join(dir, ...rel.split("/")))) {
    return fail("bin-missing", `${entry.id} installed but ${rel} was not found inside ${dir}.`);
  }
  return {
    ok: true,
    record: {
      id: entry.id,
      package: entry.package,
      version: entry.version,
      method: entry.method,
      lockSha256: entry.lockSha256,
      installedAt: ctx.now.toISOString(),
      binRelPath: rel,
    },
  };
}

function findPython(ctx: InstallContext, cwd: string): string | null {
  for (const candidate of ctx.platform === "win32" ? ["python", "python3"] : ["python3", "python"]) {
    const r = ctx.runner.run([candidate, "--version"], { cwd, deadlineMs: PROBE_DEADLINE_MS });
    if (r.exitCode === 0) return candidate;
  }
  return null;
}
