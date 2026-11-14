#!/usr/bin/env node
// scripts/purix-04-run-all.mjs: the one command that tests Purix from start to end. Replaces purix-04-run-all.ps1.
//
//   node scripts/purix-04-run-all.mjs                  everything, once each
//   node scripts/purix-04-run-all.mjs --list           show the stages and what each one tests, run nothing
//   node scripts/purix-04-run-all.mjs --only gates,tests
//   node scripts/purix-04-run-all.mjs --skip slow      leave out coverage, conformance, flows, release, windows
//   node scripts/purix-04-run-all.mjs --serial         one test file at a time (use on Windows or a slow machine)
//   node scripts/purix-04-run-all.mjs --fail-fast      stop at the first failure
//   node scripts/purix-04-run-all.mjs --network        also run the dependency-audit detection check (needs internet)
//   node scripts/purix-04-run-all.mjs --tag v0.4.0-beta.0   also check the package versions match this tag
//   node scripts/purix-04-run-all.mjs --strict-known   a stage marked `known` (a defect already found and written down) fails the run too
//
// SPEED: the `speed` group times every command, the agent hook, the MCP server and index on growing projects against the
// budgets in scripts/speed-budgets.json (scripts/speed-test.mjs; `pnpm run speed` runs it alone). It runs right after the build,
// while the machine is quiet, and is part of the slow group (`--skip slow` leaves it out).
//
// LEFTOVER STATE: after the test suites a stage compares the repository with how it was when the run started and fails if a test left a
// .purix folder under packages/ or a new untracked file behind (a test that writes into the source tree hides in a green run).
//
// RULE: every stage tests a different thing, and every test file runs in exactly one stage. Each stage declares what it
// tests in `kind`; the script refuses to start if two stages declare the same kind. Add a new check by giving it a new kind,
// not by running an existing check a second time.
//
// What was merged into this file (each ran the same checks as another script before):
//   - the race, mcp-stdout-purity, read-only and cli.integration stages: those files are already part of the package suites
//   - turbo `test` inside release-check: the same suites again; release-check `package` mode now runs only release-only checks
//   - install, boundary, single-point, artifact, typecheck, build, smoke and coverage inside release-check `full`
//   - the core tests under llm/ licensing/ gates/ sandbox/ verify/: they run under the coverage gate and are left out of the core stage
// Every stage writes its own log to <repo>/.test-logs/<timestamp>/NN-name.log and the run ends with SUMMARY.md.
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hideSandboxTools } from "./hide-sandbox-tools.mjs";

// Tests assume no sandbox tool on PATH (see hide-sandbox-tools.mjs); every stage below inherits this PATH.
hideSandboxTools();

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const value = (n) => { const i = args.indexOf(n); return i > -1 ? args[i + 1] : undefined; };
const only = (value("--only") ?? "").split(",").filter(Boolean);
const skip = (value("--skip") ?? "").split(",").filter(Boolean);
const tag = value("--tag");
const serial = flag("--serial");
const failFast = flag("--fail-fast");
const withNetwork = flag("--network");
const strictKnown = flag("--strict-known");
const listOnly = flag("--list");
const isWin = process.platform === "win32";

function findRoot(dir) {
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "turbo.json")) && existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = dirname(dir);
  }
  console.error("Run this from inside the purix repo (no turbo.json + pnpm-workspace.yaml found).");
  process.exit(2);
}
const root = findRoot(dirname(fileURLToPath(import.meta.url)));
const hasEslintConfig = readdirSync(root).some((f) => /^eslint\.config\.(js|mjs|cjs|ts|mts|cts)$/.test(f));

// group: what --only / --skip select. slow: left out by `--skip slow`.
const SLOW = new Set(["speed", "coverage", "conformance", "flows", "release", "windows", "network"]);
const nodeTest = (pkg) =>
  serial
    ? `pnpm --filter @purix/${pkg} exec node --import tsx --test --test-concurrency=1 "src/**/*.test.ts"`
    : `pnpm --filter @purix/${pkg} test`;


// ---------------------------------------------------------------------------------------------------------------------
// Leftover state. Taken once, before any stage runs, so the stage near the end can say what the run itself left behind.
// ---------------------------------------------------------------------------------------------------------------------
const gitOut = (a) => { const r = spawnSync("git", a, { cwd: root, encoding: "utf8" }); return r.status === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : null; };
/** Every .purix folder directly inside a package folder (a package is not a governed project: nothing there may have state). */
function packageStateFolders() {
  const out = [];
  const pk = join(root, "packages");
  if (!existsSync(pk)) return out;
  for (const d of readdirSync(pk)) { try { if (statSync(join(pk, d, ".purix")).isDirectory()) out.push(`packages/${d}/.purix`); } catch { /* absent */ } }
  return out;
}
const untrackedNow = () => (gitOut(["ls-files", "--others", "--exclude-standard"]) ?? []).filter((f) => !f.startsWith(".test-logs/"));
const before = { state: new Set(packageStateFolders()), untracked: new Set(untrackedNow()), hadGit: existsSync(join(root, ".git")) };
function leftoverState() {
  const problems = [];
  for (const f of packageStateFolders()) if (!before.state.has(f)) problems.push(`${f} was created during this run (a test wrote project state into a package folder)`);
  // Without a git checkout only the folder check above can be made.
  if (before.hadGit) {
    for (const f of untrackedNow()) if (!before.untracked.has(f)) problems.push(`${f} is a new untracked file made during this run`);
  }
  return problems;
}

/** kind = the one thing this stage tests. Unique across the file. `check` = a function run in this process instead of a command. */
const STAGES = [
  { group: "env", name: "machine-facts", kind: "environment record", cmd: "node --version && pnpm --version && git --version", min: 2 },
  { group: "gates", name: "install-frozen", kind: "dependencies install from the lockfile", cmd: "pnpm install --frozen-lockfile", min: 15 },
  { group: "gates", name: "boundary-check", kind: "core does not import cli", cmd: "pnpm run boundary-check", min: 5 },
  { group: "gates", name: "single-point-check", kind: "no new scattered console/fetch/env/.purix use (ADR-061), plus the checker's own tests", cmd: "pnpm run single-point-check && pnpm run single-point-check:test", min: 5 },
  { group: "gates", name: "env-docs-check", kind: "every environment variable the code reads is listed in docs/ENVIRONMENT.md, plus the checker's own tests", cmd: "pnpm run env-docs-check && pnpm run env-docs-check:test", min: 4 },
  { group: "gates", name: "import-cycle-check", kind: "no circular imports in the source (D-o), plus the checker's own tests", cmd: "pnpm run cycle-check && pnpm run cycle-check:test", min: 5 },
  { group: "gates", name: "tool-boundary-check", kind: "tools install only through the broker (ADR-060), plus the checker's own tests", cmd: "pnpm run tool-boundary-check && pnpm run tool-boundary-check:test", min: 5 },
  { group: "gates", name: "artifact-check", kind: "no build junk committed", cmd: "pnpm run artifact-check", min: 5 },
  { group: "gates", name: "claim-ledger", kind: "every ledgered public sentence still exists with its evidence; no banned phrase; unmapped claim-shaped README sentences do not grow", cmd: "node scripts/check-claims.mjs", min: 5 },
  { group: "gates", name: "checks-page", kind: "docs/WHAT_PURIX_CHECKS.md is exactly what the claims register and run log say now, plus the generator's own tests", cmd: "node scripts/generate-checks-page.mjs --check && node --test scripts/generate-checks-page.test.mjs", min: 3 },
  { group: "gates", name: "typecheck", kind: "types, all packages", cmd: "pnpm run typecheck", min: 15 },
  { group: "gates", name: "lint", kind: "lint rules", cmd: "pnpm run lint", min: 15, unavailable: hasEslintConfig ? undefined : "no eslint.config.* in this tree (CI in the real repo has it)" },
  { group: "build", name: "build", kind: "packages build (everything below needs dist/)", cmd: "pnpm run build", min: 15 },
  {
    group: "speed", name: "speed-commands", kind: "speed: every command's --help and real run, the agent hook, and the MCP server answer inside their budgets",
    cmd: "node scripts/speed-test.mjs --only commands,hooks,mcp", min: 25, // 141 items x 6 runs; hit the old 8 min limit (481 s) on a slow Windows box with every item passing
  },
  {
    group: "speed", name: "speed-scale", kind: "speed: index time grows about in step with project size, on a plain folder and inside a git repository (no quadratic growth)",
    cmd: "node scripts/speed-test.mjs --only scale", min: 15, // took 243 s of the old 6 min on the same box
  },
  {
    group: "tests", name: "core-suite", kind: "core unit and integration tests (minus the coverage-owned folders)",
    cmd: "pnpm --filter @purix/core test", min: 30, env: { PURIX_CORE_SKIP_COVERED: "1", ...(serial ? { PURIX_TEST_CONCURRENCY: "1" } : {}) },
  },
  { group: "tests", name: "mcp-server-suite", kind: "mcp-server tests (approval, path containment, elicitation round trip)", cmd: nodeTest("mcp-server"), min: 15 },
  { group: "tests", name: "cli-suite", kind: "cli tests (commands, read-only commands, mcp stdout purity, integration, hooks e2e)", cmd: nodeTest("cli"), min: 40 },
  { group: "tests", name: "no-leftover-state", kind: "the test suites left nothing behind in the repository (no .purix under packages/, no new untracked file)", check: leftoverState },
  { group: "coverage", name: "coverage-gate-90", kind: "90% coverage on llm/licensing/gates/sandbox/verify, and those folders' tests", cmd: "pnpm run coverage", min: 30 },
  { group: "conformance", name: "language-conformance", kind: "TypeScript and Python checks behave the same", cmd: "pnpm exec tsx packages/core/src/language/conformance/run.ts", min: 15 },
  { group: "flows", name: "ci-lock-flow", kind: "purix lock then check --strict on a fresh checkout", cmd: "node scripts/ci-lock-flow.mjs", min: 10 },
  { group: "flows", name: "ci-hook-flow", kind: "hook payloads of six agents against a project made by the real CLI", cmd: "node scripts/ci-hook-flow.mjs", min: 10 },
  { group: "flows", name: "ci-bypass-flow", kind: "a simulated agent runs the installed hook commands: hooks installed block a direct edit; uninstalled, the edit lands and check --strict names it", cmd: "node scripts/ci-bypass-flow.mjs", min: 30 },
  { group: "flows", name: "connect-harness", kind: "every agent purix connect supports: the config it wrote starts a server that answers (config level, not a real-agent result)", cmd: "node scripts/connect-harness.mjs", min: 60 },
  { group: "flows", name: "mcp-smoke-test", kind: "real MCP stdio server: handshake and tool calls", cmd: "node scripts/smoke-test.mjs", min: 10, after: () => rmSync(join(root, "purix-mcp-report.md"), { force: true }) },
  {
    group: "release", name: "release-only-checks", kind: "pack, clean install of tarballs, versions, tarball contents, workflow parity, dependency audit",
    cmd: `node scripts/release-check.mjs package${tag ? ` --tag ${tag}` : ""}`, min: 20,
  },
  {
    group: "windows", name: "windows-real-machine", kind: "Windows-only behaviour: launchers, CRLF, BOM, locked files, killed server, secret permissions",
    cmd: "powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\windows-test.ps1", min: 40,
    unavailable: isWin ? undefined : "Windows only",
  },
  {
    group: "network", name: "dependency-audit-detection", kind: "the dependency audit really detects a known vulnerability (live npm/pip)",
    cmd: "pnpm exec tsx scripts/verify-dependency-audit.ts", min: 15, unavailable: withNetwork ? undefined : "needs internet; run with --network",
  },
];

// Preflight: without pnpm every stage would fail for the same reason. Say so once instead.
if (!listOnly && spawnSync("pnpm --version", { shell: true, stdio: "ignore" }).status !== 0) {
  console.error("pnpm is not on PATH. Install the version in package.json (\"packageManager\"), for example: npm install -g pnpm@12.4.1");
  process.exit(2);
}

// Guard: two stages may never test the same thing.
const seen = new Map();
for (const s of STAGES) {
  if (seen.has(s.kind)) { console.error(`Duplicate test kind "${s.kind}" in stages "${seen.get(s.kind)}" and "${s.name}". Give each stage a different kind.`); process.exit(2); }
  seen.set(s.kind, s.name);
}

// Stage ids are the position in the full list, so they match the numbering in docs/TESTING-PLAN.md section 3 (1.1, 1.2, ...).
STAGES.forEach((s, i) => { s.id = `1.${i + 1}`; });

// A misspelt group used to select nothing and the run ended green with 0 stages. Say so instead.
const GROUPS = new Set([...STAGES.map((s) => s.group), "slow"]);
for (const g of [...only, ...skip]) {
  if (!GROUPS.has(g)) { console.error(`Unknown group "${g}". Groups: ${[...GROUPS].join(", ")}`); process.exit(2); }
}

const selected = STAGES.filter((s) => (only.length === 0 || only.includes(s.group)) && !skip.includes(s.group) && !(skip.includes("slow") && SLOW.has(s.group)));

if (listOnly) {
  console.log(`Purix test plan: ${selected.length} stages, each tests a different thing.\n`);
  selected.forEach((s) => console.log(`${s.id.padStart(5)}  [${s.group}] ${s.name}\n         ${s.kind}${s.unavailable ? `\n         (will be NOT CHECKED: ${s.unavailable})` : ""}`));
  process.exit(0);
}

if (selected.length === 0) { console.error("No stage matches --only/--skip. Run with --list to see the stages."); process.exit(2); }

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
const logDir = join(root, ".test-logs", stamp);
mkdirSync(logDir, { recursive: true });
const results = [];
console.log(`Purix full test run ${stamp}  |  ${process.platform}, ${cpus().length} cpu, Node ${process.version}${serial ? "  |  serial" : ""}\nLogs: ${logDir}\nDo not press Ctrl+C: a stage can be quiet for several minutes.\n`);

/** The lines that say WHAT failed. The last lines of a log are usually just totals, so print these first. */
function highlights(stageName, text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  if (stageName === "lint") {
    let header = "";
    for (const l of lines) {
      if (/^\S/.test(l) && /[\\/]/.test(l) && !/^(\s|✖|>|\[)/.test(l)) header = l.trim();
      else if (/^\s+\d+:\d+\s+error\s/.test(l)) { if (header) { out.push(header); header = ""; } out.push(`  ${l.trim()}`); }
    }
  } else {
    for (const l of lines) if (/^\s*(✖|×|FAIL\b|not ok\b)/.test(l) && !/^\s*✖ failing tests:?$/.test(l)) out.push(l.trimEnd());
  }
  return [...new Set(out)].slice(0, 30);
}

let n = 0;
for (const s of selected) {
  n++;
  const logName = `${String(n).padStart(2, "0")}-${s.name}.log`;
  const logPath = join(logDir, logName);
  process.stdout.write(`[${s.group}] ${s.name} ... `);
  if (s.unavailable) {
    console.log(`NOT CHECKED (${s.unavailable})`);
    results.push({ ...s, status: "NOT CHECKED", code: "-", secs: 0, note: s.unavailable });
    continue;
  }
  const t = Date.now();
  if (s.check) {
    const problems = s.check();
    writeFileSync(logPath, problems.length ? problems.join("\n") + "\n" : "no leftover state\n");
    const status = problems.length ? "FAIL" : "PASS";
    console.log(`${status} (${Math.round((Date.now() - t) / 1000)}s)`);
    if (problems.length) console.log(problems.map((l) => `      ${l}`).join("\n"));
    results.push({ ...s, status, code: problems.length ? 1 : 0, secs: Math.round((Date.now() - t) / 1000), found: problems });
    if (failFast && status !== "PASS") break;
    continue;
  }
  const fd = openSync(logPath, "w");
  const r = spawnSync(s.cmd, { cwd: root, shell: true, stdio: ["ignore", fd, fd], timeout: s.min * 60_000, env: { ...process.env, ...(s.env ?? {}) } });
  closeSync(fd);
  const timedOut = r.error && /ETIMEDOUT/.test(String(r.error.code ?? r.error.message));
  if (timedOut && isWin && r.pid) spawnSync(`taskkill /PID ${r.pid} /T /F`, { shell: true, stdio: "ignore" });
  s.after?.();
  const code = r.status ?? (timedOut ? -999 : 1);
  const failed = timedOut ? "TIMEOUT" : "FAIL";
  const status = code === 0 ? "PASS" : s.known && !strictKnown && !timedOut ? "KNOWN FAIL" : failed;
  const secs = Math.round((Date.now() - t) / 1000);
  console.log(`${status} (exit ${code}, ${secs}s)`);
  let found = [];
  if (status !== "PASS") {
    const text = readFileSync(logPath, "utf8");
    found = highlights(s.name, text);
    if (s.name.startsWith("speed")) found = text.split(/\r?\n/).filter((l) => /^(FAIL|WARN)\b|^\s{8}\S/.test(l)).slice(0, 30);
    const shown = found.length ? found : text.trimEnd().split("\n").slice(-12).map((l) => l.replace(/\r$/, ""));
    console.log(`${shown.map((l) => `      ${l}`).join("\n")}\n      full log: ${logPath}`);
  }
  if (status === "KNOWN FAIL") console.log(`      known: ${s.known}`);
  results.push({ ...s, status, code, secs, found });
  if (failFast && status !== "PASS") break;
}

const count = (st) => results.filter((r) => r.status === st).length;
const bad = results.filter((r) => r.status === "FAIL" || r.status === "TIMEOUT");
const md = [
  `# Purix full test run ${stamp}`, "",
  `${process.platform} ${process.arch}, ${cpus().length} cpu, ${Math.round(totalmem() / 2 ** 30)} GB memory, Node ${process.version}${serial ? ", serial" : ""}`, "",
  `- ${count("PASS")} PASS, ${bad.length} FAIL or TIMEOUT, ${count("KNOWN FAIL")} KNOWN FAIL, ${count("NOT CHECKED")} NOT CHECKED`, "",
  "| Id | Group | Stage | What it tests | Status | Exit | Secs |", "|---|---|---|---|---|---|---|",
  ...results.map((r) => `| ${r.id} | ${r.group} | ${r.name} | ${r.kind} | ${r.status} | ${r.code} | ${r.secs} |`), "",
  "A NOT CHECKED row was not run and is not a pass. Do not claim it.", "A KNOWN FAIL row failed on a defect that is already written down (see the stage's `known` note in the runner); it does not stop the run but it is not a pass.", "",
  ...results.filter((r) => r.status === "KNOWN FAIL").flatMap((r) => [`- **${r.name}** (known): ${r.known}`, ""]),
  ...bad.flatMap((r) => [`## ${r.name}: what failed`, "", "```", ...(r.found.length ? r.found : ["(no failing-test lines found; read the full log)"]), "```", ""]),
];
writeFileSync(join(logDir, "SUMMARY.md"), md.join("\n"));
// The same result for a machine to read (a CI step, a trend chart, the claims check): one row per stage.
writeFileSync(join(logDir, "summary.json"), JSON.stringify({
  when: stamp, platform: process.platform, arch: process.arch, cpus: cpus().length, node: process.version, serial,
  counts: { pass: count("PASS"), failOrTimeout: bad.length, knownFail: count("KNOWN FAIL"), notChecked: count("NOT CHECKED") },
  stages: results.map((r) => ({ id: r.id, group: r.group, name: r.name, status: r.status, exit: r.code, secs: r.secs, note: r.note ?? r.known ?? undefined })),
}, null, 2));
console.log(`\nRESULT: ${count("PASS")} PASS, ${bad.length} FAIL or TIMEOUT, ${count("KNOWN FAIL")} KNOWN FAIL, ${count("NOT CHECKED")} NOT CHECKED`);
console.log(`Summary: ${join(logDir, "SUMMARY.md")}`);
if (bad.length) { console.log("Failed:"); bad.forEach((r) => console.log(` - ${r.name} (log: ${join(logDir, `${String(results.indexOf(r) + 1).padStart(2, "0")}-${r.name}.log`)})`)); }
process.exit(bad.length ? 1 : 0);
