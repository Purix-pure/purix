// src/verify/verify.ts
import { spawnSync } from "../platform/spawn_sync.js";
import { existsSync, rmSync } from "fs";
import { resolve } from "path";

export type VerificationResult =
  | { status: "pass" }
  | { status: "fail"; reason: string }
  | { status: "not_installed"; reason: string; actionHint?: string };

/**
 * BUG FIX: this used to hardcode "pnpm add -D typescript" regardless of
 * which package manager the TARGET project (baseDir) actually uses —
 * misleading advice for the (likely more common) npm/yarn case. Pick the
 * hint from whichever lockfile is actually present in baseDir, defaulting
 * to npm when none is found.
 */
function installTypescriptHint(baseDir: string): string {
  if (existsSync(resolve(baseDir, "pnpm-lock.yaml"))) return "pnpm add -D typescript";
  if (existsSync(resolve(baseDir, "yarn.lock"))) return "yarn add -D typescript";
  if (existsSync(resolve(baseDir, "bun.lock")) || existsSync(resolve(baseDir, "bun.lockb"))) return "bun add -D typescript";
  return "npm install -D typescript";
}

/**
 * BUG FIX: this used to hardcode its own tsc flag set (ES2022/ESNext/
 * bundler/strict/esModuleInterop), which had already drifted from the
 * real tsconfig.json — missing verbatimModuleSyntax,
 * allowImportingTsExtensions, noUncheckedIndexedAccess, and using
 * "module": "ESNext" where the real config says "Preserve". A patch
 * could pass this sandbox check and still fail a real `tsc` run against
 * the project's actual config — exactly the "works for one dev, fails
 * for another" gap Section 23 says pinned tool versions are supposed to
 * close. Fix: if baseDir has a tsconfig.json, defer to it entirely via
 * `tsc -p`, which type-checks the whole project under its real settings
 * (slower than checking just the changed files, but correct — worth
 * knowing, not hiding). Only falls back to the old explicit-file/flag
 * approach if no tsconfig.json exists at all.
 *
 * FOLLOW-UP FIX: the fallback branch itself still hardcoded the exact
 * stale flag set described above as the bug — it never actually got
 * updated when the `-p` path was added, so a project with no
 * tsconfig.json at all (a real case: verifyComponent's callers pass
 * whatever targetDir a given repo has, and not every repo Purix touches
 * is guaranteed to carry one) was silently checked under weaker,
 * out-of-date settings than this project's own strictness bar. Brought
 * back in sync with this project's tsconfig.json compilerOptions
 * (target/module/moduleResolution/strict/skipLibCheck plus the three
 * flags that were missing entirely). Since this list is still a
 * hand-maintained mirror rather than a single source of truth — the
 * whole reason the `-p` branch above exists — if tsconfig.json's
 * compilerOptions change, this fallback needs a matching manual update.
 */
export function verifyComponent(filePaths: string[], baseDir: string = process.cwd()): VerificationResult {
  if (filePaths.length === 0) {
    return { status: "fail", reason: "No files to verify" };
  }

  const localTscScript = resolve(baseDir, "node_modules/typescript/bin/tsc");
  const localTscBin = resolve(baseDir, "node_modules/.bin/tsc");
  const command = existsSync(localTscScript)
    ? ["node", localTscScript]
    : existsSync(localTscBin)
    ? [localTscBin]
    : null;

  if (!command) {
    return { status: "not_installed", reason: "TypeScript not installed locally", actionHint: `Run: ${installTypescriptHint(baseDir)}` };
  }


  const tsconfigPath = resolve(baseDir, "tsconfig.json");
  const hasTsconfig = existsSync(tsconfigPath);

  const result = hasTsconfig
    ? spawnSync([...command, "-p", tsconfigPath, "--noEmit"], { cwd: baseDir, stdout: "pipe", stderr: "pipe" })
    : spawnSync(
        [
          ...command,
          "--noEmit",
          "--skipLibCheck",
          "--target", "ESNext",
          "--module", "Preserve",
          "--moduleResolution", "bundler",
          "--allowImportingTsExtensions",
          "--verbatimModuleSyntax",
          "--strict",
          "--noUncheckedIndexedAccess",
          "--noFallthroughCasesInSwitch",
          "--noImplicitOverride",
          ...filePaths.map((p) => resolve(p)),
        ],
        { cwd: baseDir, stdout: "pipe", stderr: "pipe" }
      );

  if (result.exitCode === 0) return { status: "pass" };

  const stderr = result.stderr.toString().trim();
  const stdout = result.stdout.toString().trim();
  return { status: "fail", reason: stderr || stdout || "tsc failed with no output" };
}

export function rollbackFiles(filePaths: string[]): void {
  for (const path of filePaths) {
    if (existsSync(path)) rmSync(path);
  }
}