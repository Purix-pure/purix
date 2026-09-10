// packages/core/src/language/provider-kit.ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { runIsolated, type IsolatedRunOptions, type IsolatedRunResult } from "../sandbox/sandbox_exec.js";

export function parseLockfileFingerprint(content: string, pattern: RegExp): Record<string, string> {
  const fingerprint: Record<string, string> = {};
  const matches = content.matchAll(pattern);
  for (const match of matches) {
    if (match[1] && match[2]) {
      fingerprint[match[1]] = match[2];
    }
  }
  return fingerprint;
}

export function resolveToolchainCache(envVars: (string | undefined)[], fallbackDirs: string[]): string | undefined {
  for (const envVar of envVars) {
    if (envVar && existsSync(envVar)) return envVar;
  }
  for (const dir of fallbackDirs) {
    const path = join(homedir(), dir);
    if (existsSync(path)) return path;
  }
  return undefined;
}

export const providerKitHooks = {
  runIsolatedOrNotInstalled,
};

export function runIsolatedOrNotInstalled(command: string[], opts: IsolatedRunOptions): IsolatedRunResult | { status: "not_installed" } {
  const res = runIsolated(command, opts);
  if (res.exitCode === null) {
    return { status: "not_installed" };
  }
  return res;
}
