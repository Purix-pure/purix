// packages/core/src/llm/test_runner.ts
//
// TEST-REPORT F10: the greenfield planning prompt used to tell every model
// "This project uses Bun's built-in test runner … import from \"bun:test\"",
// regardless of the project. On a Node/tsx project the generated test then
// failed scaffold verification with
//   error TS2307: Cannot find module 'bun:test'
// (the verifier itself runs node:test via tsx, Jest, Vitest, and Mocha — it
// never runs Bun). The runner is now detected from the project.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type TestRunner = "node" | "bun" | "vitest" | "jest" | "mocha";

interface PackageJsonLike {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * Best-effort detection: the `test` script wins, then declared dependencies,
 * then a Bun lockfile. Anything unrecognised — or no package.json — defaults
 * to Node's built-in runner, which needs no dependency at all.
 */
export function detectTestRunner(baseDir: string = process.cwd()): TestRunner {
  let pkg: PackageJsonLike;
  try {
    pkg = JSON.parse(readFileSync(join(baseDir, "package.json"), "utf8")) as PackageJsonLike;
  } catch {
    return existsSync(join(baseDir, "bun.lockb")) || existsSync(join(baseDir, "bun.lock")) ? "bun" : "node";
  }
  const testScript = pkg.scripts?.test ?? "";
  if (/\bbun\s+test\b/.test(testScript)) return "bun";
  if (/\bvitest\b/.test(testScript)) return "vitest";
  if (/\bjest\b/.test(testScript)) return "jest";
  if (/\bmocha\b/.test(testScript)) return "mocha";
  if (/--test\b/.test(testScript)) return "node";
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if ("vitest" in deps) return "vitest";
  if ("jest" in deps || "@jest/globals" in deps) return "jest";
  if ("mocha" in deps) return "mocha";
  if ("@types/bun" in deps || "bun-types" in deps) return "bun";
  if (existsSync(join(baseDir, "bun.lockb")) || existsSync(join(baseDir, "bun.lock"))) return "bun";
  return "node";
}

/** The prompt paragraph telling the model which test imports to use. */
export function testRunnerGuidance(runner: TestRunner): string {
  const explicit = "Never rely on describe/it/expect as ambient globals.";
  switch (runner) {
    case "bun":
      return `This project uses Bun's built-in test runner, not Jest or Mocha. Any test
file must explicitly import test utilities from "bun:test":
import { describe, it, expect } from "bun:test";
${explicit}`;
    case "vitest":
      return `This project uses Vitest. Any test file must explicitly import test utilities:
import { describe, it, expect } from "vitest";
${explicit}`;
    case "jest":
      return `This project uses Jest. Any test file must explicitly import test utilities:
import { describe, it, expect } from "@jest/globals";
${explicit}`;
    case "mocha":
      return `This project uses Mocha with Node's assert. Any test file must explicitly import:
import { describe, it } from "mocha";
import assert from "node:assert/strict";
${explicit}`;
    default:
      return `This project uses Node's built-in test runner (node:test), not Jest, Mocha or Bun.
Any test file must explicitly import test utilities and assertions:
import { describe, it } from "node:test";
import assert from "node:assert/strict";
${explicit}`;
  }
}
