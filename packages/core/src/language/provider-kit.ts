// packages/core/src/language/provider-kit.ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { runIsolated, type IsolatedRunOptions, type IsolatedRunResult } from "../sandbox/sandbox_exec.js";
import { isTestPath } from "../verify/test_discovery.js";
import { isPythonTestPath } from "../verify/python_test_discovery.js";
import { matchPath } from "../gates/path_match.js";
import { normalizeRepoPath } from "../gates/path_normalize.js";
import type { LanguageProvider } from "./provider.js";

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
  // F02-03: exitCode null with no stop marker, or a program that was not found or could not be started, is "not installed". A run that was
  // stopped for time or output is not: the tool is there, it just did not finish, and the caller must say so.
  if (res.exitCode === null && (!res.stopped || res.stopped === "not_found" || res.stopped === "spawn_error")) {
    return { status: "not_installed" };
  }
  return res;
}

// ---------------------------------------------------------------------------------------------------------------------
// A1 shared rail: which files a repair may never edit, decided by the language that owns them.
//
// Before: compile.ts asked one function (isTestFilePath = the JavaScript/TypeScript rule) about every file, so a repair could
// rewrite `assert x == 1` to `assert True` in tests/test_a.py, or empty the include list in vitest.config.ts, and the lock said
// nothing (research 07, reproduced on the current code: 7 of 8 probe paths accepted).
//
// TRANSITIONAL: language/providers/typescript.ts and python.ts belong to the languages phase (A10a), so A1 does not edit them.
// Until they define `isTestFile` / `testConfigPaths` themselves, the table below supplies the two built-in languages by provider
// id. A provider that defines its own members always wins over the table, and once both built-ins do, the table can be deleted.
// ---------------------------------------------------------------------------------------------------------------------
export interface TestFileRules {
  isTestFile?(path: string): boolean;
  testConfigPaths?: readonly string[];
}

const JS_TS_FILE = /\.[cm]?[jt]sx?$/i;

export const BUILTIN_TEST_FILE_RULES: Readonly<Record<string, Required<TestFileRules>>> = Object.freeze({
  typescript: {
    // The discovery rule, plus a plural `tests/` folder (very common in JavaScript projects, and not in discovery's rule).
    isTestFile: (path: string) => isTestPath(path) || (JS_TS_FILE.test(path) && path.split("/").slice(0, -1).some((s) => s === "tests")),
    testConfigPaths: ["vitest.config.*", "vitest.workspace.*", "jest.config.*", ".mocharc.*", "playwright.config.*", "cypress.config.*", "karma.conf.*", "ava.config.*", "**/__snapshots__/**", "*.snap"],
  },
  python: {
    isTestFile: isPythonTestPath,
    testConfigPaths: ["pytest.ini", "tox.ini", ".coveragerc", "**/__snapshots__/**"],
  },
});

/** The rules for one provider: its own members, else the transitional table by id, else nothing. */
export function testFileRulesOf(provider: Pick<LanguageProvider, "id" | "isTestFile" | "testConfigPaths">): TestFileRules {
  const builtin = BUILTIN_TEST_FILE_RULES[provider.id];
  const isTestFile = provider.isTestFile ? provider.isTestFile.bind(provider) : builtin?.isTestFile;
  const testConfigPaths = provider.testConfigPaths ?? builtin?.testConfigPaths;
  return { ...(isTestFile ? { isTestFile } : {}), ...(testConfigPaths ? { testConfigPaths } : {}) };
}

function matchesAnyConfigPattern(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchPath(path, pattern.includes("/") ? pattern : `**/${pattern}`, { overLength: "match" }));
}

/**
 * True when ANY of these providers says `path` is one of its test files or test-config files. Union on purpose: this answers
 * "may a repair touch this?", a deny question, so a project with two languages is protected by both languages' rules.
 * The path is checked as given and lower-cased, so a rule written for `test_a.py` also catches `TEST_A.PY` on a case-insensitive disk
 * (over-matching on a case-sensitive one, which is the safe direction here).
 */
export function isProtectedTestPath(path: string, providers: readonly Pick<LanguageProvider, "id" | "isTestFile" | "testConfigPaths">[]): boolean {
  const normal = normalizeRepoPath(path);
  const folded = normal.toLowerCase();
  for (const provider of providers) {
    const rules = testFileRulesOf(provider);
    if (rules.isTestFile && (rules.isTestFile(normal) || rules.isTestFile(folded))) return true;
    if (rules.testConfigPaths && matchesAnyConfigPattern(normal, rules.testConfigPaths)) return true;
  }
  return false;
}
