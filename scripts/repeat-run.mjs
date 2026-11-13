// scripts/repeat-run.mjs
//
// N-08: run a test command many times in a row and report which tests failed in any run, and how often.
// A single red run says little about a test that fails once in 700; twenty runs show whether it is the same test every
// time and how often it breaks. The command is run as given, the TAP lines "not ok N - name" are collected from its output,
// and the summary names each test that failed with its failure count.
//
//   node scripts/repeat-run.mjs [--runs 20] [--keep-going] [--quarantine docs/flaky-quarantine.json] -- pnpm run test
//
// --runs N       how many runs (default 20, at most 200)
// --keep-going   do not stop at the first run that fails (the scheduled job uses it; a local check usually does not need it)
// --quarantine F a JSON file listing flaky tests that are known and owned: { "tests": [ { "name": "...", "owner": "...", "until": "2026-12-31", "why": "..." } ] }.
//                A failure of a listed test is reported but does not fail the run, until its `until` date passes; after that it fails the run
//                again (a quarantine is a deadline, not a hiding place). Every entry needs a name, an owner and a date, or the run refuses to start.
//                Testing plan 2.1: "fix it in the same release or list it in a quarantine file with an owner and a date".
// The full output of every failed run is written to $REPEAT_RUN_LOGS (default ./repeat-run-logs), one file per run.
// Exit code: 0 if every run passed, 1 if any run failed, 2 on a usage error. When GITHUB_STEP_SUMMARY is set, the summary
// is appended there as well.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const isMain = Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;
// Importing this file (to test the helpers below) must not read the importer's command line or exit, so options are read only when it is the program.
const argv = isMain ? process.argv.slice(2) : [];
const sep = argv.indexOf("--");
const own = sep === -1 ? [] : argv.slice(0, sep);
const command = sep === -1 ? [] : argv.slice(sep + 1);

function usage(message) {
  if (message) console.error(`repeat-run: ${message}`);
  console.error("usage: node scripts/repeat-run.mjs [--runs N] [--keep-going] [--quarantine FILE] -- <command> [args...]");
  process.exit(2);
}

let runs = 20;
let keepGoing = false;
let quarantineFile;
for (let i = 0; i < own.length; i++) {
  if (own[i] === "--runs") {
    runs = Number.parseInt(own[++i] ?? "", 10);
  } else if (own[i] === "--keep-going") {
    keepGoing = true;
  } else if (own[i] === "--quarantine") {
    quarantineFile = own[++i];
  } else {
    usage(`unknown option ${own[i]}`);
  }
}
if (isMain) {
  if (!Number.isInteger(runs) || runs < 1 || runs > 200) usage("--runs must be a whole number from 1 to 200");
  if (command.length === 0) usage("no command given after --");
}

const logDir = process.env.REPEAT_RUN_LOGS ?? "repeat-run-logs";

/**
 * Names of tests reported failed. Node prints TAP ("not ok 3 - name") when its output is not a terminal, and the spec reporter
 * ("✖ name (12ms)") when it is, or when a newer Node changes the default (the CI matrix runs `latest`). Both are read, so a change of
 * reporter cannot turn "these tests failed" into "no 'not ok' line found". A trailing "# duration" / "# SKIP" note, a "(12ms)" timing and
 * the "✖ failing tests:" header are not part of a name. In the spec output a failed suite is repeated in the closing summary; names are
 * de-duplicated by the caller.
 */
export function failedTestNames(output) {
  const names = [];
  for (const line of output.split(/\r?\n/)) {
    const tap = /(?:^|[\s:])not ok \d+ - (.+?)\s*(?:# .*)?$/.exec(line);
    if (tap) { names.push(tap[1].trim()); continue; }
    const spec = /^(?:\S+:\s)?\s*✖ (?!failing tests)(.+?)(?:\s+\(\d+(?:\.\d+)?m?s\))?\s*$/.exec(line);
    if (spec) names.push(spec[1].trim());
  }
  return names;
}

/** Reads and checks a quarantine file. Returns a Map from test name to its entry, or exits 2 with the reason. */
export function loadQuarantine(file, now = new Date()) {
  if (!file) return new Map();
  if (!existsSync(file)) { console.error(`repeat-run: quarantine file ${file} does not exist`); process.exit(2); }
  let doc;
  try { doc = JSON.parse(readFileSync(file, "utf8")); } catch (e) { console.error(`repeat-run: ${file} is not valid JSON: ${e.message}`); process.exit(2); }
  const map = new Map();
  for (const [i, t] of (doc.tests ?? []).entries()) {
    const missing = ["name", "owner", "until"].filter((k) => typeof t[k] !== "string" || t[k].trim() === "");
    if (missing.length || Number.isNaN(Date.parse(t.until))) {
      console.error(`repeat-run: quarantine entry ${i + 1} in ${file} needs a name, an owner and a valid until date (problem: ${missing.length ? `missing ${missing.join(", ")}` : `"${t.until}" is not a date`})`);
      process.exit(2);
    }
    map.set(t.name, { ...t, expired: Date.parse(t.until) < now.getTime() });
  }
  return map;
}

/**
 * Turborepo replays a passing task's saved output instead of running it again ("pkg:test: cache hit, replaying logs").
 * Twenty runs through turbo would then be one real run and nineteen replays, and the summary would still say every run
 * passed. A repeat run has to refuse that rather than report it. Only the test task counts: build and typecheck tasks are
 * meant to be cached.
 */
export function replayedFromCache(output) {
  return /:test: cache hit/i.test(output);
}

function runOnce() {
  return new Promise((resolve) => {
    const chunks = [];
    const child = spawn(command[0], command.slice(1), { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => chunks.push(d));
    child.on("error", (err) => resolve({ code: 1, output: `could not start ${command[0]}: ${err.message}` }));
    child.on("exit", (code, signal) => resolve({ code: signal ? 1 : (code ?? 1), output: Buffer.concat(chunks).toString("utf8") }));
  });
}

if (isMain) {
  const quarantine = loadQuarantine(quarantineFile);
  const failures = new Map(); // test name -> number of runs it failed in
  const failedRuns = [];
  const started = Date.now();
  let runsStarted = 0;
  for (let n = 1; n <= runs; n++) {
    runsStarted = n;
    const { code, output } = await runOnce();
    if (replayedFromCache(output)) {
      console.error(`run ${n}/${runs}: the command's output was replayed from a cache (turbo "cache hit"), so the tests did not run again.`);
      console.error("Run the tests without the cache, for example `turbo run test --force`, or give the test task \"cache\": false in turbo.json.");
      process.exit(2);
    }
    const names = [...new Set(failedTestNames(output))];
    if (code !== 0 || names.length > 0) {
      failedRuns.push(n);
      mkdirSync(logDir, { recursive: true });
      writeFileSync(join(logDir, `run-${String(n).padStart(3, "0")}.log`), output);
      for (const name of names) failures.set(name, (failures.get(name) ?? 0) + 1);
      console.log(`run ${n}/${runs}: FAILED (exit ${code})${names.length ? `: ${names.join("; ")}` : ": no 'not ok' line found, see the log"}`);
      if (!keepGoing) break;
    } else {
      console.log(`run ${n}/${runs}: passed`);
    }
  }
  const minutes = ((Date.now() - started) / 60000).toFixed(1);
  // A failed run is excused only if EVERY test that failed in it is quarantined and not past its date (and some test name was found).
  const excused = (name) => { const q = quarantine.get(name); return q !== undefined && !q.expired; };
  const lines = [`Repeat run of \`${command.join(" ")}\``, `Runs started: ${runsStarted} of ${runs}, failed: ${failedRuns.length}, time: ${minutes} min`];
  const unexcused = [...failures.keys()].filter((n) => !excused(n));
  if (failures.size > 0) {
    lines.push("", "Tests that failed, with the number of runs they failed in:");
    for (const [name, count] of [...failures].sort((a, b) => b[1] - a[1])) {
      const q = quarantine.get(name);
      lines.push(`- ${name}: ${count}${q ? (q.expired ? ` (QUARANTINE EXPIRED ${q.until}, owner ${q.owner}: fix it or renew it)` : ` (quarantined until ${q.until}, owner ${q.owner}${q.why ? `: ${q.why}` : ""})`) : ""}`);
    }
  } else if (failedRuns.length > 0) {
    lines.push("", `Runs ${failedRuns.join(", ")} exited non-zero without a 'not ok' line (build or setup failure); see ${logDir}.`);
  } else {
    lines.push("", "Every run passed.");
  }
  const onlyQuarantined = failures.size > 0 && unexcused.length === 0;
  if (onlyQuarantined) lines.push("", "Every failing test is quarantined with an owner and a date. The run is not failed, and the flakiness is still there: it is a list to work through.");
  console.log(`\n${lines.join("\n")}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  // A run that failed with no test name (a build or setup failure) is never excused.
  const unnamedFailure = failedRuns.length > 0 && failures.size === 0;
  process.exit(unnamedFailure || unexcused.length > 0 ? 1 : 0);
}
