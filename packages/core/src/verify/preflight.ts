// src/verify/preflight.ts
//
// Fail early when verification cannot possibly run. Before this, a missing TypeScript compiler or test runner showed
// up only AFTER the model had been called for the classification, three repair attempts and two high-tier
// escalations: money spent on a change that could never be verified. These checks spawn nothing and cost nothing.
//
// Narrow on purpose. It blocks only where the verifier would itself report not_installed for certain:
//   - TypeScript/JavaScript files in the component and no compiler (project's own or `purix tools install typescript`);
//   - a test file in the component, a framework detected, and no runner for it.
// Anything else is left to the verifier, so this can never refuse a change the verifier would have accepted.
import { extname } from "node:path";
import { locateTool, missingToolHint } from "../tools/broker.js";
import { detectTestFramework, locateRunner, runnerToolId } from "./tests.js";

const TS_EXTS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

export interface PreflightProblem {
  tool: string;
  message: string;
}

export function preflightVerification(files: readonly string[], baseDir: string = process.cwd()): PreflightProblem[] {
  const problems: PreflightProblem[] = [];
  if (files.some((f) => TS_EXTS.has(extname(f).toLowerCase())) && !locateTool({ baseDir }, "typescript")) {
    problems.push({ tool: "typescript", message: `TypeScript is not installed. ${missingToolHint({ baseDir }, "typescript")}` });
  }
  const testFiles = files.filter((f) => TEST_FILE.test(f));
  if (testFiles.length > 0) {
    const framework = detectTestFramework(baseDir, [...testFiles]);
    if (framework && !locateRunner(baseDir, framework)) {
      const id = runnerToolId(framework);
      problems.push({ tool: id, message: `The test runner for this project (${framework}) is not installed. ${missingToolHint({ baseDir }, id)}` });
    }
  }
  return problems;
}

/** One printable block, or null when everything needed is present. */
export function formatPreflight(problems: readonly PreflightProblem[]): string | null {
  if (problems.length === 0) return null;
  return `Nothing was sent to the model and nothing was changed: this change could not be verified here.\n${problems.map((p) => `  - ${p.message}`).join("\n")}`;
}
