// packages/core/scripts/run-tests.mjs
//
// Thin wrapper around `node --test` that excludes
// src/language/conformance/fixtures/**. Those fixtures include
// deliberately-broken files (a failing assertion, a weakened test) used
// by the conformance harness (src/language/conformance/run.ts) to verify
// that Purix's own checkers catch bad code — they are fixtures, not
// real tests, and must never be executed by the ordinary test run.
//
// A plain glob ("src/**/*.test.ts") can't express that exclusion on its
// own: `node --test` has no file-level exclude flag (only
// --test-coverage-exclude, which is coverage-report-only), and a second
// "!pattern" glob argument is treated as a literal, unmatched pattern
// rather than a negation. So this script does the filtering itself and
// passes an explicit file list to `node --test`.
import { spawn } from "node:child_process";
import { glob } from "node:fs/promises";

const EXCLUDED_PATH_SEGMENT = "language/conformance/fixtures/";

const testFiles = [];
for await (const file of glob("src/**/*.test.ts")) {
  const normalized = file.split("\\").join("/");
  if (normalized.includes(EXCLUDED_PATH_SEGMENT)) continue;
  testFiles.push(file);
}

if (testFiles.length === 0) {
  console.error("run-tests.mjs: no test files matched src/**/*.test.ts — refusing to run zero tests.");
  process.exit(1);
}

const child = spawn(process.execPath, ["--import", "tsx", "--test", ...testFiles], {
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});