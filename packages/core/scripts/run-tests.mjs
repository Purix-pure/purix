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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXCLUDED_PATH_SEGMENT = "language/conformance/fixtures/";

// Two switches used by scripts/purix-04-run-all.mjs so that no test runs twice. Both are off unless the env var is set,
// so `pnpm test` behaves exactly as before.
//   PURIX_CORE_SKIP_COVERED=1   leave out the tests under llm/, licensing/, gates/, sandbox/, verify/. The coverage gate
//                               (`pnpm run coverage`) runs exactly those, so the runner runs them there instead of here.
//   PURIX_TEST_CONCURRENCY=N    pass --test-concurrency=N to the parallel group (1 = one file at a time, for slow or
//                               race-prone machines such as Windows).
const COVERED_DIRS = /^src\/(llm|licensing|gates|sandbox|verify)\//;
const skipCovered = process.env.PURIX_CORE_SKIP_COVERED === "1";
const concurrency = Number.parseInt(process.env.PURIX_TEST_CONCURRENCY ?? "", 10);

const testFiles = [];
for await (const file of glob("src/**/*.test.ts")) {
  const normalized = file.split("\\").join("/");
  if (normalized.includes(EXCLUDED_PATH_SEGMENT)) continue;
  if (skipCovered && COVERED_DIRS.test(normalized)) continue;
  testFiles.push(file);
}

if (testFiles.length === 0) {
  console.error("run-tests.mjs: no test files matched src/**/*.test.ts — refusing to run zero tests.");
  process.exit(1);
}

// Test files that save/clear the machine-global login (saveSession/clearSession
// from security/session, i.e. ~/.purix/session.enc). `node --test` runs files in
// parallel, so one file's clearSession() can log another file out mid-test (this
// made tier_signed.test.ts flaky), and they also overwrite the developer's real
// login. Run them one at a time, with a throwaway home directory.
const GLOBAL_SESSION_IMPORT = /import\s*\{[^}]*\b(?:saveSession|clearSession)\b[^}]*\}\s*from\s*["'][^"']*security\/session(?:\.js)?["']/;
const serialFiles = testFiles.filter((f) => GLOBAL_SESSION_IMPORT.test(readFileSync(f, "utf8")));
const parallelFiles = testFiles.filter((f) => !serialFiles.includes(f));

function runNode(files, extraArgs, env) {
  return new Promise((resolve) => {
    if (files.length === 0) return resolve(0);
    const child = spawn(process.execPath, ["--import", "tsx", "--test", ...extraArgs, ...files], { stdio: "inherit", env });
    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

const fakeHome = mkdtempSync(join(tmpdir(), "purix-test-home-"));
const codeA = await runNode(parallelFiles, Number.isInteger(concurrency) && concurrency > 0 ? [`--test-concurrency=${concurrency}`] : [], process.env);
const codeB = await runNode(serialFiles, ["--test-concurrency=1"], { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome });
try {
  rmSync(fakeHome, { recursive: true, force: true });
} catch {
  // best effort: it is a temp directory
}
process.exit(codeA !== 0 ? codeA : codeB);
