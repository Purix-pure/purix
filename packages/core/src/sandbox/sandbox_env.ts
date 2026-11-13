// src/sandbox/sandbox_env.ts
//
// What a child process may see of the person's environment. A4-1 minimal (security review V1b): this was a NAME DENY-LIST
// (API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL), and 9 of 15 credential-like names passed it (AWS_ACCESS_KEY_ID, DATABASE_URL,
// SSH_AUTH_SOCK, KUBECONFIG among them). A deny-list cannot name every secret; it is now an ALLOW-LIST: the child gets the
// variables a toolchain needs to start and nothing else.
//
// This is a filter on one thing, the environment. It is not network isolation or filesystem containment (those are runIsolated's
// job where a sandbox tool exists), and a project's own binary that runs here can still read files the user can read.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envSnapshot, purixEnv } from "../platform/env.js";

/**
 * Names a toolchain needs to start, compared without regard to case (Windows spells SystemRoot and Path in mixed case).
 * Everything else is dropped, including EDITOR, SHELL, NODE_OPTIONS, LD_PRELOAD, PYTHONPATH and every PURIX_ variable.
 */
const ALLOWED = new Set([
  "PATH", "LANG", "LANGUAGE", "TZ", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR", "CI", "NODE_ENV", "TMPDIR", "TMP", "TEMP",
  // Windows: a process does not start correctly without these.
  "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
  "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "PROGRAMDATA",
]);
const ALLOWED_PREFIXES = ["LC_"];

/**
 * Runner context that must never reach a child. When Purix's own test suite is what drives a verification (it is, on this repo),
 * the outer `node --test` sets NODE_TEST_CONTEXT on itself. Inherited, it makes the child's test runner think it is a duplicate
 * run of the same process and skip every test with exit 0 and no output, which reads upstream as "all tests passed". Not on the
 * allow-list, so it is gone already; named here so the reason is kept next to the rule (ADR-048 fallout).
 */
const RUNNER_CONTEXT_KEYS = new Set(["NODE_TEST_CONTEXT"]);

const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_()]*$/;

/** Names the person chose to pass through in PURIX_SANDBOX_ENV_PASS (comma separated). Only plain variable names count: no patterns. */
function passList(source: NodeJS.ProcessEnv): Set<string> {
  const raw = source.PURIX_SANDBOX_ENV_PASS;
  const out = new Set<string>();
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const name = part.trim();
    if (PLAIN_NAME.test(name) && name.toUpperCase() !== "PURIX_SANDBOX_ENV_PASS") out.add(name.toUpperCase());
  }
  return out;
}

export interface SandboxEnvOptions {
  /** Where HOME (and USERPROFILE, for Windows tools) point: a scratch directory. Absent: no HOME at all, never the real one. */
  home?: string;
  /** The environment to filter. Default: the live one. For tests. */
  source?: NodeJS.ProcessEnv;
}

export function sandboxEnv(opts: SandboxEnvOptions = {}): Record<string, string> {
  const source = opts.source ?? envSnapshot();
  const passed = passList(source);
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (RUNNER_CONTEXT_KEYS.has(upper)) continue;
    if (ALLOWED.has(upper) || ALLOWED_PREFIXES.some((p) => upper.startsWith(p)) || passed.has(upper)) safe[key] = value;
  }
  if (opts.home !== undefined) {
    safe.HOME = opts.home;
    safe.USERPROFILE = opts.home;
  }
  return safe;
}

/**
 * Runs `fn` with a throwaway directory to use as HOME, and removes it afterwards. For the two steps that run a project's own
 * tool outside runIsolated (the TypeScript compiler and ESLint), which have no writable directory of their own to offer.
 */
export function withScratchHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "purix-home-"));
  try {
    return fn(home);
  } finally {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // a leftover empty temp directory is not worth failing a verification over
    }
  }
}

/** True when PURIX_STRICT_ISOLATION is set to anything but "", "0", "false" or "no": a step that would run with no sandbox is refused instead. */
export function strictIsolation(): boolean {
  const v = (purixEnv("PURIX_STRICT_ISOLATION") ?? "").trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "no";
}
