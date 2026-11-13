#!/usr/bin/env node
// scripts/speed-test.mjs: how fast does Purix answer? Replaces scripts/benchmark-cli-help.mjs.
//
//   node scripts/speed-test.mjs                      commands + hooks + mcp, 5 timed runs each
//   node scripts/speed-test.mjs --list               show what is timed and what each budget is, run nothing
//   node scripts/speed-test.mjs --only commands,hooks,mcp,scale
//   node scripts/speed-test.mjs --runs 9             more runs = steadier medians (default 5, plus 1 untimed warm-up)
//   node scripts/speed-test.mjs --factor 2           multiply every budget (slow machine). Also PURIX_SPEED_FACTOR=2
//   node scripts/speed-test.mjs --save-baseline f    write this run's medians to f
//   node scripts/speed-test.mjs --compare f          also fail on a slow-down against a baseline saved on THIS machine
//   node scripts/speed-test.mjs --scale-sizes 500,2000,8000   (the default; sizes come from speed-budgets.json)
//
// WHAT IT TIMES (each is wall-clock time of the real built CLI, the way a user or an agent hook would run it):
//   commands  --help of every command (startup + argument parsing), then the real run of every command that can run
//             offline in a throw-away project: read-only, light-write and the index/adopt/lock chain
//   hooks     `purix hook <agent> pre-tool-use` for a blocked and an allowed edit. An agent runs this before EVERY edit.
//   mcp       start the MCP server and finish the handshake, list tools, and call each read tool
//   scale     `purix index` on projects of growing size, twice: on a plain folder (the folder walk) and inside a real git repository
//             (git's own file list, the path every real project takes); fails if the time grows faster than the project does
//
// HOW IT DECIDES (the research behind it is in docs/TESTING-PLAN.md, section "Speed"):
//   - Budgets are in scripts/speed-budgets.json. They come from Nielsen's response-time limits (0.1 s feels instant, 1 s keeps
//     the user's flow of thought, 10 s is the limit of attention), not from what Purix happens to do today.
//   - Every command is run several times and the MEDIAN is judged, never one run (Mozilla's performance system also measures
//     each change several times because one run is mostly noise).
//   - Budgets are scaled by this machine's speed: the time `node -e ""` takes here against the reference machine, so a slow
//     Windows runner is not failed for being slow.
//   - A command that exits with an unexpected code is a FAIL, not a timing: the time of a crash means nothing.
//   - The list of commands is DISCOVERED from the built CLI. A command that exists but is not classified below is a FAIL, and a
//     scenario naming a command that does not exist is a FAIL, so this file cannot go stale without saying so.
// Needs a build first: pnpm run build. Writes .test-logs/speed/speed-latest.json and .md. Exit 0 = no FAIL, 1 = a FAIL, 2 = usage.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, platform, arch, cpus } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : undefined; };
const usage = (m) => { console.error(`speed-test: ${m}`); process.exit(2); };

const RUNS = Number.parseInt(val("--runs") ?? "5", 10);
if (!Number.isInteger(RUNS) || RUNS < 3 || RUNS > 50) usage("--runs must be a whole number from 3 to 50 (a median needs at least 3)");
const ONLY = (val("--only") ?? "commands,hooks,mcp").split(",").filter(Boolean);
for (const o of ONLY) if (!["commands", "hooks", "mcp", "scale"].includes(o)) usage(`--only: unknown section "${o}"`);
const USER_FACTOR = Number(val("--factor") ?? process.env.PURIX_SPEED_FACTOR ?? "1");
if (!Number.isFinite(USER_FACTOR) || USER_FACTOR <= 0) usage("--factor must be a positive number");
const SCALE_SIZES = (val("--scale-sizes") ?? "").split(",").filter(Boolean).map(Number);
const COMPARE = val("--compare");
const SAVE_BASELINE = val("--save-baseline");

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const cli = join(root, "packages", "cli", "dist", "cli.js");
const budgets = JSON.parse(readFileSync(join(here, "speed-budgets.json"), "utf8"));
if (SCALE_SIZES.length === 0) SCALE_SIZES.push(...budgets.scale.sizes);
if (SCALE_SIZES.length < 3 || SCALE_SIZES.some((n, i) => !Number.isInteger(n) || n < 1 || (i > 0 && n <= SCALE_SIZES[i - 1]))) usage("--scale-sizes needs at least three whole numbers in rising order, e.g. 500,2000,8000");
if (!flag("--list") && !existsSync(cli)) { console.error(`speed-test: ${cli} not found. Run "pnpm run build" first.`); process.exit(2); }

// ---------------------------------------------------------------------------------------------------------------------
// What is timed. `class` picks the budget in speed-budgets.json.
// ---------------------------------------------------------------------------------------------------------------------

/** Commands that are timed with a real run in a project (offline, no model, no key). okCodes = exit codes that are a correct answer. */
const READ = [
  { args: ["status"] }, { args: ["check"], ok: [0, 1] }, { args: ["check", "--strict"], ok: [0, 1] }, { args: ["check", "--json"], ok: [0, 1] },
  { args: ["stats"] }, { args: ["library"] }, { args: ["tools", "list"] }, { args: ["tools", "plan"] }, { args: ["tools", "status"] },
  { args: ["lang", "list"] }, { args: ["lang", "status", "typescript"] }, { args: ["config", "list"] }, { args: ["config", "get", "show-savings"] },
  { args: ["budget", "show"] }, { args: ["provider", "status"] }, { args: ["provider", "list"] }, { args: ["tier-status"] },
  { args: ["hooks", "status"] }, { args: ["hooks", "doctor"], ok: [0, 1] }, { args: ["secret", "status"] }, { args: ["audit-log", "verify"], ok: [0, 1] },
  { args: ["evidence", "report"] }, { args: ["evidence", "export"] }, { args: ["evidence", "trailer"] }, { args: ["telemetry", "status"] },
  { args: ["telemetry", "show"] }, { args: ["migration", "list"] }, { args: ["diagnostics"] }, { args: ["audit"], ok: [0, 1] }, { args: ["approve"] },
  { args: ["audit-log", "trail"], ok: [0, 1] },
].map((s) => ({ ...s, class: "read" }));

/** Light writes: change a little local state, still offline. Safe to repeat. They run in the throw-away project and HOME. */
const WRITE = [
  { args: ["config", "set", "show-savings", "off"] }, { args: ["config", "delete", "show-savings"] },
  { args: ["secret", "set", "SPEED_TEST_KEY", "not-a-real-secret"] }, { args: ["secret", "remove", "SPEED_TEST_KEY"] },
  { args: ["provider", "set", "gemini"] }, { args: ["telemetry", "enable"] }, { args: ["telemetry", "disable"] },
  { args: ["remember", "speed test note"] }, { args: ["hooks", "install", "claude-code"] }, { args: ["hooks", "uninstall", "claude-code"] },
  { args: ["backup", "create", "{TMP}/speed-backup.json"] }, { args: ["reconcile"] }, { args: ["lock"] },
].map((s) => ({ ...s, class: "write" }));

/** The chain every project goes through. Run on a FRESH project for each timed run. */
const CHAIN = [
  { id: "index", args: ["index"], class: "index-small" },
  { id: "adopt", args: ["adopt", "src/a.ts"], class: "write" },
  { id: "lock", args: ["lock"], class: "write" },
];

/**
 * Commands that exist but are NOT run for real here, and why. Their --help is still timed. A command that is neither in
 * READ, WRITE, CHAIN nor here makes the run FAIL: somebody added a command and nobody said how to time it.
 */
const HELP_ONLY = {
  "create": "needs a model (use `speed-test --live` once it exists, or eval:l1 for model latency)",
  "change": "needs a model", "modify": "needs a model", "ingest": "needs a model and a diff file", "delete": "destructive",
  "login": "needs the hosted service", "logout": "changes the machine-wide login", "mcp-serve": "timed in the mcp section",
  "connect": "writes agent config files outside the project", "hook": "timed in the hooks section",
  "tools install": "downloads a tool (network)", "tools approve": "needs a pending request and a terminal", "tools remove": "needs an installed tool",
  "provider trust": "needs a custom endpoint", "secret rotate": "covered by secret set", "budget reset": "destructive to the spend record",
  "migration accept-drift": "needs a migration", "migration activate": "needs a staged migration", "migration rollback": "needs a migration",
  "backup restore": "destructive", "telemetry reset": "covered by telemetry enable", "telemetry forget": "destructive", "deny": "needs a pending request",
  "lang refresh": "rescans installed tooling (slow by design, not on the interactive path)", "lang verify": "runs the whole conformance suite (own stage)",
  "lang install": "downloads language tooling (network)", "lang uninstall": "removes language tooling",
  "index": "timed in the chain", "adopt": "timed in the chain", "lock": "timed in the write list",
  "hooks install": "timed in the write list", "hooks uninstall": "timed in the write list", "approve": "timed in the read list",
};
/** Hidden commands the help text does not list. Each is checked to exist; add new hidden commands here. */
const HIDDEN = ["hook", "hooks", "approve", "deny", "lang install", "lang uninstall"];

/** MCP tools that are called with real arguments. Anything else the server lists must be named in MCP_SKIPPED. */
const MCP_CALLS = [
  { tool: "purix_status", args: {} }, { tool: "purix_find", args: { query: "a" } }, { tool: "purix_audit_verify", args: {} },
  { tool: "purix_tools_plan", args: {} }, { tool: "purix_tools", args: { purpose: "typescript type check" } },
];
const MCP_SKIPPED = {
  purix_approval_status: "needs a pending approval id", purix_change: "needs a model", purix_create: "needs a model", purix_modify: "needs a model",
  purix_index: "timed through the CLI chain (same code)", purix_ingest: "needs a model and a diff", purix_adopt: "timed through the CLI chain (same code)",
  purix_audit_trail: "Pro feature on the free tier", purix_tools_request_install: "starts an install request",
};

// ---------------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------------
const sorted = (xs) => [...xs].sort((a, b) => a - b);
const median = (xs) => { const s = sorted(xs); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const p95 = (xs) => sorted(xs)[Math.min(xs.length - 1, Math.ceil(0.95 * xs.length) - 1)];
const round = (n) => Math.round(n);

function measureFloor() {
  const t = [];
  for (let i = 0; i < 9; i++) { const s = performance.now(); spawnSync(process.execPath, ["-e", ""]); t.push(performance.now() - s); }
  return median(t);
}
const floorMs = measureFloor();
const machineFactor = Math.min(8, Math.max(1, floorMs / budgets.referenceFloorMs));
const FACTOR = machineFactor * USER_FACTOR;
const budgetFor = (cls) => {
  const b = budgets.classes[cls];
  if (b === undefined) throw new Error(`speed-budgets.json has no class "${cls}"`);
  return round(b.ms * FACTOR);
};

function mkProject(nFiles = 1, { git = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), "purix-speed-"));
  const home = join(base, "home"); const proj = join(base, "proj");
  mkdirSync(home, { recursive: true }); mkdirSync(join(proj, "src"), { recursive: true });
  // An empty .git folder makes the project look like a repository root without being one: index then falls back to a folder walk.
  // A real `git init` + `git add` makes index take git's own file list, which is what every real project gets.
  if (!git) mkdirSync(join(proj, ".git"));
  writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "speed", version: "1.0.0", type: "module" }));
  writeFileSync(join(proj, "src", "a.ts"), "export const a = 1;\n");
  for (let i = 1; i < nFiles; i++) {
    writeFileSync(join(proj, "src", `m${i}.ts`), `export function f${i}(x: number): number {\n  return x + ${i};\n}\nexport const c${i} = f${i}(1);\n`);
  }
  const env = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1", CLAUDE_PROJECT_DIR: "", GEMINI_PROJECT_DIR: "" };
  if (git) {
    const g = (...a) => spawnSync("git", a, { cwd: proj, env, stdio: "ignore" }).status;
    if (g("init", "-q") !== 0 || g("add", "-A") !== 0) return { base, home, proj, env, tmp: base, gitFailed: true };
  }
  return { base, home, proj, env, tmp: base };
}
function run(p, args, input, timeoutMs = 300_000) {
  const a = args.map((x) => x.replace("{TMP}", p.tmp));
  const s = performance.now();
  const r = spawnSync(process.execPath, [cli, ...a], { cwd: p.proj, env: p.env, input, encoding: "utf8", timeout: timeoutMs });
  return { ms: performance.now() - s, code: r.status ?? (r.error ? -1 : 1), text: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const rows = [];
/** Judge one measurement series. samples are ms; codes are the exit codes seen. */
function judge({ section, id, cls, samples, cold, codes, okCodes, extra = {} }) {
  const budget = budgetFor(cls);
  const med = median(samples);
  const row = { section, id, class: cls, budgetMs: budget, runs: samples.map(round), coldMs: cold === undefined ? undefined : round(cold), minMs: round(Math.min(...samples)), medianMs: round(med), p95Ms: round(p95(samples)), maxMs: round(Math.max(...samples)), status: "PASS", reason: "", ...extra };
  const bad = codes.filter((c) => !okCodes.includes(c));
  if (bad.length) { row.status = "FAIL"; row.reason = `unexpected exit code ${[...new Set(bad)].join(",")} (expected ${okCodes.join(" or ")}); a timing of a failing command means nothing`; }
  else if (med > budget) { row.status = "FAIL"; row.reason = `median ${round(med)} ms is over the ${budget} ms budget (${cls})`; }
  else if (p95(samples) > budget * 2) { row.status = "WARN"; row.reason = `median is fine but the slowest runs reach ${round(p95(samples))} ms (over twice the budget): timing is unstable`; }
  rows.push(row);
  return row;
}
const fail = (section, id, reason) => rows.push({ section, id, class: "-", budgetMs: 0, runs: [], minMs: 0, medianMs: 0, p95Ms: 0, maxMs: 0, status: "FAIL", reason });

/** Time args RUNS times after one untimed warm-up. */
function series(p, args, input) {
  const first = run(p, args, input); // warm-up: also the "cold" number users see on their first run
  const samples = []; const codes = [first.code];
  for (let i = 0; i < RUNS; i++) { const r = run(p, args, input); samples.push(r.ms); codes.push(r.code); }
  return { samples, codes, cold: first.ms };
}

// ---------------------------------------------------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------------------------------------------------
function helpOf(p, path) { return run(p, [...path, "--help"]); }
function subcommandsFrom(text) {
  const out = []; let section = "";
  for (const line of text.split(/\r?\n/)) {
    if (/^\S.*:$/.test(line)) { section = line.slice(0, -1); continue; }
    if (/^(Options|Arguments|First steps|Help)$/.test(section)) continue;
    const m = /^ {2}([a-z][a-z0-9-]*)(?:\s|$)/.exec(line);
    if (m && m[1] !== "help") out.push(m[1]);
  }
  return out;
}
function registryTopLevel() {
  const src = readFileSync(cli, "utf8");
  const m = /COMMAND_NAME_TO_SPEC = \{([\s\S]*?)\n\};/.exec(src);
  if (!m) return [];
  return [...m[1].matchAll(/^\s*"?([a-z][a-z0-9-]*)"?:/gm)].map((x) => x[1]);
}
function discover(p) {
  const found = new Map(); // "lang list" -> { path, visible }
  const walk = (path, visible) => {
    const h = helpOf(p, path);
    const want = `Usage: purix ${path.join(" ")}`;
    if (path.length && !h.text.startsWith(want)) return false; // an unknown command prints its PARENT's help and exits 0: do not count it
    found.set(path.join(" "), { path, visible });
    for (const sub of subcommandsFrom(h.text)) walk([...path, sub], visible);
    return true;
  };
  const topVisible = subcommandsFrom(run(p, ["--help"]).text);
  for (const name of new Set([...topVisible, ...registryTopLevel()])) walk([name], topVisible.includes(name));
  const missing = [];
  for (const h of HIDDEN) { if (!found.has(h)) { const path = h.split(" "); if (!walk(path, false)) missing.push(h); } }
  return { found, missing };
}

// ---------------------------------------------------------------------------------------------------------------------
// --list
// ---------------------------------------------------------------------------------------------------------------------
if (flag("--list")) {
  console.log(`Speed test plan (budgets at the reference machine; this machine's factor is applied when it runs)\n`);
  for (const [cls, b] of Object.entries(budgets.classes)) console.log(`  ${cls.padEnd(14)} ${String(b.ms).padStart(6)} ms   ${b.why}`);
  console.log(`\n  commands : --help of every command; real run of ${READ.length} read, ${WRITE.length} write and ${CHAIN.length} chain commands`);
  console.log(`  hooks    : ${budgets.classes.hook ? "pre-tool-use blocked + allowed" : ""}`);
  console.log(`  mcp      : start + handshake, list tools, ${MCP_CALLS.length} read tools`);
  console.log(`  scale    : index at ${SCALE_SIZES.join(", ")} files, growth must stay near linear (slope <= ${budgets.scale.maxSlope})`);
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------------------------------
console.log(`Purix speed test  |  ${platform()} ${arch()}, ${cpus().length} cpu, Node ${process.version}`);
console.log(`Node start-up floor here: ${round(floorMs)} ms (reference ${budgets.referenceFloorMs} ms)  ->  budgets x ${FACTOR.toFixed(2)}${USER_FACTOR !== 1 ? ` (includes --factor ${USER_FACTOR})` : ""}`);
console.log(`${RUNS} timed runs per item after 1 untimed warm-up; the MEDIAN is judged.\n`);

const prepared = mkProject(1);
const cleanup = [prepared.base];
try {
  // The chain first: it leaves behind a project that has state, which the read commands need.
  const chainSamples = Object.fromEntries(CHAIN.map((c) => [c.id, { samples: [], codes: [], cold: undefined }]));
  let last = prepared;
  const chainRuns = Math.max(3, Math.min(RUNS, 5));
  if (ONLY.includes("commands")) {
    for (let i = 0; i <= chainRuns; i++) {
      const p = i === 0 ? prepared : mkProject(1);
      if (i > 0) cleanup.push(p.base);
      for (const c of CHAIN) {
        const r = run(p, c.args);
        const slot = chainSamples[c.id];
        if (i === 0) { slot.cold = r.ms; slot.codes.push(r.code); } else { slot.samples.push(r.ms); slot.codes.push(r.code); }
      }
      last = p;
    }
    for (const c of CHAIN) judge({ section: "commands", id: `run: purix ${c.args.join(" ")} (fresh project)`, cls: c.class, samples: chainSamples[c.id].samples, cold: chainSamples[c.id].cold, codes: chainSamples[c.id].codes, okCodes: [0] });

    // Discovery and --help of everything.
    const { found, missing } = discover(last);
    for (const m of missing) fail("commands", `help: purix ${m}`, "listed as a hidden command in speed-test.mjs but the CLI has no such command: remove it from HIDDEN or restore the command");
    const classified = new Set([...READ.map((s) => s.args.slice(0, found.has(s.args.slice(0, 2).join(" ")) ? 2 : 1).join(" ")), ...WRITE.map((s) => s.args.slice(0, found.has(s.args.slice(0, 2).join(" ")) ? 2 : 1).join(" ")), ...CHAIN.map((c) => c.args[0]), ...Object.keys(HELP_ONLY)]);
    for (const s of [...READ, ...WRITE]) {
      const path = found.has(s.args.slice(0, 2).join(" ")) ? s.args.slice(0, 2) : s.args.slice(0, 1);
      if (!found.has(path.join(" "))) fail("commands", `run: purix ${s.args.join(" ")}`, `the scenario names "purix ${path.join(" ")}", which the CLI does not have: a command was renamed or removed. Update scripts/speed-test.mjs.`);
    }
    const leaves = [...found.values()].filter((f) => ![...found.keys()].some((k) => k.startsWith(`${f.path.join(" ")} `)));
    for (const leaf of leaves) {
      const key = leaf.path.join(" ");
      if (!classified.has(key)) fail("commands", `coverage: purix ${key}`, "this command exists but speed-test.mjs has never been told how to time it. Add it to READ, WRITE or CHAIN (to run it), or to HELP_ONLY with the reason it cannot run offline.");
    }
    process.stdout.write(`--help of ${found.size} commands ... `);
    for (const [key, f] of found) {
      const s = series(last, [...f.path, "--help"]);
      judge({ section: "commands", id: `help: purix ${key}${f.visible ? "" : " (hidden)"}`, cls: "help", samples: s.samples, cold: s.cold, codes: s.codes, okCodes: [0] });
    }
    console.log("done");
    const v = series(last, ["--version"]);
    judge({ section: "commands", id: "version: purix --version", cls: "version", samples: v.samples, cold: v.cold, codes: v.codes, okCodes: [0] });

    process.stdout.write(`real run of ${READ.length + WRITE.length} commands ... `);
    for (const sc of [...READ, ...WRITE]) {
      const s = series(last, sc.args);
      judge({ section: "commands", id: `run: purix ${sc.args.join(" ").replace("{TMP}/", "")}`, cls: sc.class, samples: s.samples, cold: s.cold, codes: s.codes, okCodes: sc.ok ?? [0] });
    }
    console.log("done");
  }

  // Hooks: runs before every edit an agent makes, so it has the tightest budget.
  if (ONLY.includes("hooks")) {
    const p = last;
    if (!ONLY.includes("commands")) { for (const c of CHAIN) run(p, c.args); }
    const gov = join(p.proj, "src", "a.ts"); const free = join(p.proj, "src", "free.ts");
    const payload = (f) => JSON.stringify({ tool_name: "Edit", tool_input: { file_path: f }, cwd: p.proj });
    for (const [label, file, ok] of [["edit of a governed file (blocked)", gov, [2]], ["edit of an ungoverned file (allowed)", free, [0]]]) {
      const s = series(p, ["hook", "claude-code", "pre-tool-use"], payload(file));
      judge({ section: "hooks", id: `hook pre-tool-use: ${label}`, cls: "hook", samples: s.samples, cold: s.cold, codes: s.codes, okCodes: ok });
    }
    const s = series(p, ["hook", "claude-code", "pre-tool-use"], "this is not json");
    judge({ section: "hooks", id: "hook pre-tool-use: unreadable payload (must fail closed)", cls: "hook", samples: s.samples, cold: s.cold, codes: s.codes, okCodes: [2] });
  }

  // MCP: start the real server and talk to it as an agent would.
  if (ONLY.includes("mcp")) {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const p = last;
    if (!ONLY.includes("commands")) { for (const c of CHAIN) run(p, c.args); }
    const startSamples = []; let cold; let listed = [];
    for (let i = 0; i <= RUNS; i++) {
      const c = new Client({ name: "purix-speed-test", version: "1" });
      const s = performance.now();
      await c.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp-serve"], cwd: p.proj, env: p.env, stderr: "ignore" }));
      const ms = performance.now() - s;
      if (i === 0) { cold = ms; listed = (await c.listTools()).tools.map((t) => t.name); } else startSamples.push(ms);
      await c.close();
    }
    judge({ section: "mcp", id: "mcp: start the server and finish the handshake", cls: "mcp-start", samples: startSamples, cold, codes: [0], okCodes: [0] });

    const c = new Client({ name: "purix-speed-test", version: "1" });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp-serve"], cwd: p.proj, env: p.env, stderr: "ignore" }));
    const timed = async (fn) => { await fn(); const out = []; for (let i = 0; i < RUNS; i++) { const s = performance.now(); await fn(); out.push(performance.now() - s); } return out; };
    judge({ section: "mcp", id: "mcp: tools/list on a running server", cls: "mcp-call", samples: await timed(() => c.listTools()), codes: [0], okCodes: [0] });
    for (const call of MCP_CALLS) {
      if (!listed.includes(call.tool)) { fail("mcp", `mcp: ${call.tool}`, "the speed test calls this tool but the server does not list it: a tool was renamed or removed. Update MCP_CALLS in scripts/speed-test.mjs."); continue; }
      let isError = false;
      const samples = await timed(async () => { const r = await c.callTool({ name: call.tool, arguments: call.args }); if (r.isError) isError = true; });
      judge({ section: "mcp", id: `mcp: call ${call.tool}`, cls: "mcp-call", samples, codes: [isError ? 1 : 0], okCodes: [0] });
    }
    await c.close();
    for (const t of listed) if (!MCP_CALLS.some((x) => x.tool === t) && !(t in MCP_SKIPPED)) fail("mcp", `coverage: ${t}`, "the server lists this tool but speed-test.mjs has never been told how to time it. Add it to MCP_CALLS, or to MCP_SKIPPED with the reason.");
  }

  // Scale: a command that takes twice as long on twice the project is fine; one that takes nine times as long is not.
  // Run twice: on a plain folder and inside a git repository, because index builds its file list differently in the two cases.
  if (ONLY.includes("scale")) {
    const gitOk = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
    const idxBudget = round(budgets.scale.indexAtLargestMs * FACTOR);
    const abortAfter = round(budgets.scale.abortAfterMs * FACTOR);
    for (const mode of [{ id: "folder", label: "plain folder", git: false }, { id: "git", label: "git repository", git: true }]) {
      if (mode.git && !gitOk) { console.log("scale: git is not installed here, so the git-repository run is NOT CHECKED"); continue; }
      const points = []; let stoppedAt = null;
      for (const n of SCALE_SIZES) {
        const p = mkProject(n, { git: mode.git }); cleanup.push(p.base);
        if (p.gitFailed) { stoppedAt = `git could not initialise the ${n}-file project`; break; }
        const r = run(p, ["index"], undefined, abortAfter * 2);
        const st = run(p, ["status"]); const ck = run(p, ["check"]);
        points.push({ n, indexMs: r.ms, statusMs: st.ms, checkMs: ck.ms, code: r.code });
        console.log(`scale (${mode.label}): ${String(n).padStart(5)} files  index ${String(round(r.ms)).padStart(6)} ms   status ${round(st.ms)} ms   check ${round(ck.ms)} ms`);
        if (r.ms > abortAfter || r.code !== 0) { stoppedAt = `index of ${n} files took ${round(r.ms)} ms${r.code !== 0 ? ` and exited ${r.code}` : ""}; the larger sizes were not run`; break; }
      }
      const reasons = [];
      if (stoppedAt) reasons.push(stoppedAt);
      let slope; let biggest = points[points.length - 1];
      if (points.length >= 2) {
        const a = points[points.length - 2]; const b = points[points.length - 1];
        slope = Math.log(b.indexMs / a.indexMs) / Math.log(b.n / a.n);
        if (points.every((x) => x.code === 0) && slope > budgets.scale.maxSlope) reasons.push(`index time grows like files^${slope.toFixed(2)} between ${a.n} and ${b.n} files (limit ${budgets.scale.maxSlope}; 1.0 = grows in step with the project, 2.0 = quadratic)`);
      } else reasons.push("fewer than two sizes were measured, so no slope can be given");
      if (points.some((x) => x.code !== 0)) reasons.push("index exited non-zero");
      if (biggest && biggest.indexMs > idxBudget) reasons.push(`index of ${biggest.n} files took ${round(biggest.indexMs)} ms, over the ${idxBudget} ms budget`);
      for (const k of ["statusMs", "checkMs"]) if (biggest && biggest[k] > budgetFor("read") * 3) reasons.push(`${k.replace("Ms", "")} on ${biggest.n} files took ${round(biggest[k])} ms (over 3x the read budget)`);
      rows.push({ section: "scale", id: `scale: index ${SCALE_SIZES.join(" / ")} files (${mode.label})`, class: "scale", budgetMs: idxBudget, runs: points.map((x) => round(x.indexMs)), minMs: round(Math.min(...points.map((x) => x.indexMs))), medianMs: round(biggest?.indexMs ?? 0), p95Ms: round(biggest?.indexMs ?? 0), maxMs: round(biggest?.indexMs ?? 0), status: reasons.length ? "FAIL" : "PASS", reason: reasons.join("; "), slope: slope === undefined ? "n/a" : Number(slope.toFixed(2)), points });
    }
  }
} finally {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------------------------------------------------
// Baseline compare, report
// ---------------------------------------------------------------------------------------------------------------------
if (COMPARE) {
  const base = JSON.parse(readFileSync(COMPARE, "utf8"));
  const key = (r) => `${r.section}|${r.id}`;
  for (const r of rows) {
    const b = base.medians?.[key(r)];
    if (b === undefined || r.status === "FAIL" || r.section === "scale") continue;
    const allowedExtra = budgets.regression.minExtraMs * FACTOR;
    if (r.medianMs > b * budgets.regression.ratio && r.medianMs - b > allowedExtra) {
      r.status = "FAIL"; r.reason = `slower than the saved baseline: median ${r.medianMs} ms against ${b} ms (more than ${Math.round((budgets.regression.ratio - 1) * 100)}% and ${Math.round(allowedExtra)} ms slower)`;
    }
  }
}
if (SAVE_BASELINE) {
  const medians = Object.fromEntries(rows.filter((r) => r.section !== "scale").map((r) => [`${r.section}|${r.id}`, r.medianMs]));
  writeFileSync(SAVE_BASELINE, JSON.stringify({ savedAt: new Date().toISOString(), platform: `${platform()} ${arch()}`, node: process.version, floorMs: round(floorMs), medians }, null, 2));
  console.log(`\nbaseline written: ${SAVE_BASELINE} (only compare against it on this machine)`);
}

const count = (s) => rows.filter((r) => r.status === s).length;
const pad = (s, n) => String(s).padEnd(n);
console.log("");
for (const r of rows) {
  if (r.section === "scale") { console.log(`${pad(r.status, 5)} ${pad(r.id, 66)} slope ${r.slope}${r.reason ? `\n        ${r.reason}` : ""}`); continue; }
  const line = `${pad(r.status, 5)} ${pad(r.id, 58)} median ${String(r.medianMs).padStart(6)} ms  p95 ${String(r.p95Ms).padStart(6)}  budget ${String(r.budgetMs).padStart(6)}`;
  if (r.status !== "PASS" || flag("--verbose")) console.log(`${line}${r.reason ? `\n        ${r.reason}` : ""}`);
}
const timed = rows.filter((r) => r.section !== "scale" && r.medianMs > 0);
const slowest = [...timed].sort((a, b) => b.medianMs - a.medianMs).slice(0, 5);
console.log(`\nSlowest five: ${slowest.map((r) => `${r.id.replace(/^(run|help): purix /, "")} ${r.medianMs} ms`).join("  |  ")}`);
console.log(`RESULT: ${count("PASS")} PASS, ${count("WARN")} WARN, ${count("FAIL")} FAIL  (${rows.length} items)`);

const outDir = join(root, ".test-logs", "speed");
mkdirSync(outDir, { recursive: true });
const report = { when: new Date().toISOString(), platform: `${platform()} ${arch()}`, cpus: cpus().length, node: process.version, floorMs: round(floorMs), factor: Number(FACTOR.toFixed(2)), runs: RUNS, sections: ONLY, rows };
writeFileSync(join(outDir, "speed-latest.json"), JSON.stringify(report, null, 2));
const md = [
  `# Purix speed test ${report.when}`, "", `${report.platform}, ${report.cpus} cpu, Node ${report.node}. Node start-up floor ${report.floorMs} ms; budgets x ${report.factor}. ${RUNS} timed runs, median judged.`, "",
  `${count("PASS")} PASS, ${count("WARN")} WARN, ${count("FAIL")} FAIL`, "",
  "| Status | Item | Median ms | p95 ms | Cold ms | Budget ms |", "|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.status} | ${r.id} | ${r.medianMs} | ${r.p95Ms} | ${r.coldMs ?? ""} | ${r.budgetMs} |`), "",
  ...rows.filter((r) => r.reason).flatMap((r) => [`- **${r.status}** ${r.id}: ${r.reason}`]), "",
];
writeFileSync(join(outDir, "speed-latest.md"), md.join("\n"));
console.log(`Report: ${join(outDir, "speed-latest.md")}`);
if (process.env.GITHUB_STEP_SUMMARY) { try { writeFileSync(process.env.GITHUB_STEP_SUMMARY, md.join("\n"), { flag: "a" }); } catch { /* best effort */ } }
process.exit(count("FAIL") ? 1 : 0);
