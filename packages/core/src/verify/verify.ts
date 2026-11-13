// src/verify/verify.ts
import { existsSync, rmSync } from "fs";
import { resolve } from "path";
import type { IsolationLevel } from "../sandbox/sandbox_exec.js";
import { locateTool, missingToolHint } from "../tools/broker.js";
import type { InfrastructureKind } from "./outcome.js";
import { runToolIsolated, type ToolRun } from "../sandbox/tool_run.js";

export type FailureErrorClass = "syntax";

export type VerificationResult =
  | { status: "pass"; isolation: IsolationLevel; /** F06-05: true when the search for tests stopped at its file limit, so a file listed in notTested may have a test that was never looked at. Absent when the search finished. */ testSearchCut?: boolean; /** C3: which of the notTested files the cut search covered. Absent means a cut search covered all of them (and in records from before this field). */ testSearchCutFiles?: string[]; /** Changed source files that no test is related to. A pass with entries here means "checked, but NOT tested", never "tested". */ notTested?: string[]; /** A10a-1: changed files in a language Purix has no provider for. Nothing ran on them. A pass with entries here is NOT a clean pass for those files. */ notChecked?: string[]; /** F01-06: credential-looking files that were left out of the verification copy. A test that needs one of them failed or was skipped for that reason, not because of the code. */ excludedForSafety?: string[]; /** C4: findings that did not block (Low and Medium severity) and files the security code rules did not read. Absent when there are none. */ securityAdvisories?: { path: string; line: number; category: string; message: string }[]; securityNotRead?: { path: string; reason: string }[]; /** F06-04: how much of the changed code the passing test run ran. Information only. Absent when coverage was not measured at all. */ changedCoverage?: import("./changed_line_coverage.js").ChangedCoverageSummary }
  | { status: "fail"; reason: string; /** True when a deterministic security block (secret scan / security gate) failed it: no model call can legitimately fix this, so healing and escalation must not run. */ policyBlock?: boolean; /** What kind of failure this is, when a stage knows ("syntax": the parse check failed before anything was copied). Absent means unclassified. */ errorClass?: FailureErrorClass, /** A1: set when the check did not fail because of the code but because Purix could not run it (timeout, output over the cap, no sandbox, out of resources). An entry with this set is never repair-eligible and never renders as a failure of the change. Nothing sets it yet; the stages that can (A4, A8, A10) fill it in their own sessions. Absent means the code failed. */ infrastructure?: InfrastructureKind; /** F01-06: see the pass variant. */ excludedForSafety?: string[] }
  | { status: "not_installed"; reason: string; actionHint?: string };

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

  // The project's own tsc, else the pinned copy installed through `purix tools install typescript`.
  const tsc = locateTool({ baseDir }, "typescript");
  if (!tsc) {
    return { status: "not_installed", reason: "TypeScript is not installed", actionHint: missingToolHint({ baseDir }, "typescript") };
  }
  const command = tsc.command;


  const tsconfigPath = resolve(baseDir, "tsconfig.json");
  const hasTsconfig = existsSync(tsconfigPath);

  const fileListArgs = [
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
  ];
  // T1 (security review V1): the project's own compiler runs through the sandbox like the test runners do: network off, the project
  // read-only, a scratch folder for writes and HOME, the allow-listed environment. Where no sandbox tool exists it runs unisolated and the
  // result says isolation: "none"; with PURIX_STRICT_ISOLATION on it does not run and the result says so (infrastructure, not a code failure).
  const run = (args: string[]): ToolRun => runToolIsolated(args, baseDir, { toolHome: tsc.toolHome, what: "The TypeScript check" });
  let result = hasTsconfig ? run([...command, "-p", tsconfigPath, "--noEmit"]) : run(fileListArgs);

  // TEST-REPORT F11: newer tsc (7.x) refuses the file-list form when a
  // tsconfig.json exists in an ANCESTOR directory (a monorepo subfolder, or
  // the conformance workspace inside this repo):
  //   error TS5112: tsconfig.json is present but will not be loaded if files
  //   are specified on commandline. Use '--ignoreConfig' to skip this error.
  // This branch deliberately ignores any config, so retry once with the flag
  // the compiler itself names. Older tsc never reaches this retry (it exits 0),
  // so the flag is only ever sent to a compiler that understands it.
  if (!hasTsconfig && result.kind === "ran" && result.exitCode !== 0 && /TS5112/.test(`${result.stderr}${result.stdout}`)) {
    result = run([...fileListArgs, "--ignoreConfig"]);
  }

  if (result.kind === "infrastructure") {
    return { status: "fail", reason: result.reason, infrastructure: result.infrastructure };
  }
  // F02-03: a compile that hit its time limit. Unlabelled on purpose: the repair loop confirms against the original code before it decides.
  if (result.kind === "timed_out") {
    return { status: "fail", reason: result.reason };
  }

  if (result.exitCode === 0) {
    // The isolation level is whatever the run really had: "network-namespace" or "os-sandbox" in a sandbox, "none" without one.
    return { status: "pass", isolation: result.isolation };
  }

  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  // A project that sets `incremental` or `composite` makes tsc write a .tsbuildinfo file even with --noEmit. The sandbox keeps the project
  // read-only, so that write fails (TS5033). That is the sandbox, not the code, so it is reported as a check that could not run.
  if (result.isolation !== "none" && /TS5033/.test(`${stderr}\n${stdout}`)) {
    return {
      status: "fail",
      reason:
        "The TypeScript check could not run in the sandbox: this project makes tsc write a build-info file (incremental or composite), and the sandbox keeps the project read-only. " +
        "This is not a failure of your code. Details: " + (stderr || stdout).split("\n")[0],
      infrastructure: "sandbox_unavailable",
    };
  }
  return { status: "fail", reason: stderr || stdout || "tsc failed with no output" };
}

export function rollbackFiles(filePaths: string[]): void {
  for (const path of filePaths) {
    if (existsSync(path)) rmSync(path);
  }
}