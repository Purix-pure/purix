// src/verify/idiom.ts
import { spawnSync } from "../platform/spawn_sync.js";
import { existsSync } from "node:fs";
import { resolve, relative } from "node:path";

export interface IdiomFinding {
  path: string;
  line: number;
  rule: string;
  message: string;
}

export interface IdiomCheckResult {
  findings: IdiomFinding[];
  ran: boolean;
  status?: "not_installed";
  reason?: string;
  actionHint?: string;
}

/**
 * Section 10: idiom-check failure is a SOFT fail — flagged for cleanup,
 * NEVER a rollback trigger. This function has no "fail" status at all
 * by design; it only ever returns findings. Correctness gates the
 * commit (verify.ts / tests.ts). Style does not.
 *
 * Skips cleanly (ran: false) if the project has no local ESLint or no
 * config — same fallback discipline as verify.ts's tsc check. This
 * doesn't force an ESLint dependency onto every project.
 */
export function checkIdioms(filePaths: string[], baseDir: string = process.cwd()): IdiomCheckResult {
  const localEslint = resolve(baseDir, "node_modules/.bin/eslint");
  // Full list of config file names ESLint 9+ actually resolves (flat config)
  // plus the legacy formats it still accepts, per ESLint's own documented
  // config-file resolution. Previously only 5 of these 12 were recognized —
  // a project using, say, eslint.config.mts or .eslintrc.yml was fully
  // configured but got `ran: false` here, indistinguishable from "no
  // ESLint at all," which is exactly the false-negative this function's
  // own soft-fail design is meant to avoid.
  const hasConfig = [
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    "eslint.config.ts",
    "eslint.config.mts",
    "eslint.config.cts",
    ".eslintrc.json",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.yml",
    ".eslintrc.yaml",
    ".eslintrc",
  ].some((f) => existsSync(resolve(baseDir, f)));

  if (!existsSync(localEslint) || !hasConfig) {
    return { findings: [], ran: false };
  }

  const result = spawnSync(
    [localEslint, "--format", "json", "--no-error-on-unmatched-pattern", ...filePaths.map((p) => resolve(p))],
    { cwd: baseDir, stdout: "pipe", stderr: "pipe" }
  );

  let parsed: any[];
  try {
    parsed = JSON.parse(result.stdout.toString());
  } catch {
    return { findings: [], ran: false }; // parse failure ≠ clean, just unknown — don't fake a result
  }

  const findings: IdiomFinding[] = [];
  for (const fileResult of parsed) {
    for (const msg of fileResult.messages ?? []) {
      
      // idiom.ts, in checkIdioms, when pushing findings
      findings.push({ path: relative(baseDir, fileResult.filePath), line: msg.line ?? 0, rule: msg.ruleId ?? "unknown", message: msg.message });
    }
    
  }
  
  return { findings, ran: true };
}