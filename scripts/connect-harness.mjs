#!/usr/bin/env node
// scripts/connect-harness.mjs: C-24 (PURIX-36). One row per coding agent `purix connect` can write to.
//
//   node scripts/connect-harness.mjs                       every agent
//   node scripts/connect-harness.mjs --only claude-code,cursor
//   node scripts/connect-harness.mjs --table docs/CLIENT_SUPPORT.md    also (re)write the support table from the rows
//   node scripts/connect-harness.mjs --expect 14           expected tool count (default: read from live_test.test.ts)
//
// For each agent, in a throwaway HOME and project:
//   1. run the REAL built CLI: `purix connect <agent> --no-hooks --no-instructions --no-verify`; require exit 0 and a file inside the sandbox;
//   2. read the entry the agent's own config now holds (JSON, JSONC, TOML or YAML, whichever that agent uses);
//   3. start the server EXACTLY as that entry says (command, args, env), with a `purix` launcher for the built CLI first on PATH;
//   4. MCP handshake, tools/list (must include purix_status, same count for every agent), call purix_status (read),
//      call purix_tools_request_install (the one write tool that needs no model and installs nothing: it only records a request).
//
// WHAT A PASS MEANS: the config Purix wrote for that agent is readable and the server it names starts and answers. It does NOT
// show that the agent itself loads the file or calls the tool; that needs the real client (C-20, docs/client-runs.json). The
// support table therefore says "Supported" only for an agent that has a passing real-client row, and says "Not verified with the
// real client" for every other one, whatever this harness shows.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, platform, arch } from "node:os";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const value = (n) => { const i = args.indexOf(n); return i > -1 ? args[i + 1] : undefined; };
const only = (value("--only") ?? "").split(",").filter(Boolean);
const tablePath = value("--table");
const isWin = process.platform === "win32";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "packages", "cli", "dist", "cli.js");
if (!existsSync(cli)) {
  console.error(`connect-harness: ${cli} not found. Run "pnpm run build" first.`);
  process.exit(2);
}

// Dependencies of add-mcp (the library that writes the configs), resolved from where add-mcp itself lives.
const requireFromCli = createRequire(join(root, "packages", "cli", "package.json"));
// add-mcp exposes only an "import" condition, so require.resolve cannot find it: take its folder from the cli's node_modules.
const addMcpDir = realpathSync(join(root, "packages", "cli", "node_modules", "add-mcp"));
const addMcpEntry = join(addMcpDir, "dist", "lib.js");
const requireFromAddMcp = createRequire(join(addMcpDir, "package.json"));
const jsonc = requireFromAddMcp("jsonc-parser");
const toml = requireFromAddMcp("@iarna/toml");
const yaml = requireFromAddMcp("js-yaml");
const addMcp = await import(pathToUrl(addMcpEntry));
const addMcpVersion = JSON.parse(readFileSync(join(addMcpDir, "package.json"), "utf-8")).version;
const requireFromRoot = createRequire(join(root, "package.json"));
const sdkClient = await import(pathToUrl(requireFromRoot.resolve("@modelcontextprotocol/sdk/client/index.js")));
const sdkStdio = await import(pathToUrl(requireFromRoot.resolve("@modelcontextprotocol/sdk/client/stdio.js")));
const cliVersion = JSON.parse(readFileSync(join(root, "packages", "cli", "package.json"), "utf-8")).version;

function pathToUrl(p) { return new URL(`file://${p.startsWith("/") ? "" : "/"}${p.split(sep).join("/")}`).href; }

function expectedToolCount() {
  const given = value("--expect");
  if (given) return Number(given);
  try {
    const t = readFileSync(join(root, "packages", "mcp-server", "src", "live_test.test.ts"), "utf-8");
    const m = /expect\(toolNames\)\.toHaveLength\((\d+)\)/.exec(t);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}
const EXPECT = expectedToolCount();

// ---- sandbox ----
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "purix-harness-")));
const bin = join(sandbox, "bin");
mkdirSync(bin, { recursive: true });
// A `purix` the config's command can find: exactly what `npm install -g @purix/cli` provides, pointed at the build under test.
// --negative-control: a launcher that always fails, to prove the harness can fail (every agent must then be reported FAIL).
const negative = args.includes("--negative-control");
writeFileSync(join(bin, "purix"), negative ? "#!/bin/sh\nexit 1\n" : `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`);
chmodSync(join(bin, "purix"), 0o755);
writeFileSync(join(bin, "purix.cmd"), negative ? "@echo off\r\nexit /b 1\r\n" : `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`);

// ---- reading what each agent's config holds ----
function parseConfig(format, text) {
  if (format === "toml") return toml.parse(text);
  if (format === "yaml") return yaml.load(text);
  const errors = [];
  const v = jsonc.parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 && v === undefined) throw new Error("not valid JSON");
  return v;
}
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function findPurix(node) {
  if (!isObj(node) && !Array.isArray(node)) return undefined;
  if (isObj(node) && isObj(node.purix)) return node.purix;
  for (const v of Object.values(node)) { const f = findPurix(v); if (f) return f; }
  return undefined;
}
/** Normalises the different server shapes (string or array command, env / environment / envs, nested command objects) to { command, args, env }. */
function normalise(entry) {
  let command = entry.command ?? entry.cmd;
  let argv = entry.args ?? [];
  let env = entry.env ?? entry.environment ?? entry.envs ?? {};
  if (isObj(command)) { argv = command.args ?? argv; env = command.env ?? env; command = command.path ?? command.command; }
  if (Array.isArray(command)) { argv = [...command.slice(1), ...argv]; command = command[0]; }
  if (typeof command !== "string") return undefined;
  return { command, args: argv.map(String), env: isObj(env) ? Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)])) : {} };
}

const results = [];
const agentIds = addMcp.getAgentTypes().filter((id) => only.length === 0 || only.includes(id));

for (const id of agentIds) {
  const row = { client: id, displayName: addMcp.agents[id]?.displayName ?? id, configPath: null, config: false, server: false, tools: null, status: false, write: false, error: null };
  const dir = join(sandbox, id);
  const home = join(dir, "home");
  const proj = join(dir, "proj");
  mkdirSync(join(proj, "src"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "p", version: "1.0.0", type: "module" }));
  writeFileSync(join(proj, "src", "a.ts"), "export const a = 1;\n");
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"), NO_COLOR: "1", CI: "",
  };
  delete env.PURIX_USER_DIR;
  try {
    const c = spawnSync(process.execPath, [cli, "connect", id, "--no-hooks", "--no-instructions", "--no-verify"], { cwd: proj, env, encoding: "utf-8", timeout: 120000 });
    const text = `${c.stdout ?? ""}${c.stderr ?? ""}`;
    const wrote = /wrote (.+?)\r?\n/.exec(text)?.[1]?.trim();
    if (c.status !== 0 || !wrote) throw new Error(`connect exited ${c.status}: ${text.trim().split("\n").slice(-3).join(" | ")}`);
    const real = existsSync(wrote) ? realpathSync(wrote) : wrote;
    if (relative(sandbox, real).startsWith("..")) throw new Error(`SAFETY: connect wrote outside the sandbox: ${real}`);
    const parts = relative(sandbox, real).split(sep).slice(1);
    row.configPath = parts[0] === "home" ? `~/${parts.slice(1).join("/")}` : parts.slice(1).join("/");
    const entry = findPurix(parseConfig(addMcp.agents[id].format, readFileSync(real, "utf-8")));
    if (!entry) throw new Error("the written config has no 'purix' entry");
    const launch = normalise(entry);
    if (!launch) throw new Error(`cannot read a command from the entry: ${JSON.stringify(entry)}`);
    row.config = true;
    row.launch = `${launch.command} ${launch.args.join(" ")}`;

    const serverEnv = { ...process.env, ...launch.env, HOME: home, USERPROFILE: home, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
    const transport = new sdkStdio.StdioClientTransport({ command: launch.command, args: launch.args, cwd: proj, env: serverEnv, stderr: "pipe" });
    const client = new sdkClient.Client({ name: `purix-harness-${id}`, version: "1.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      row.server = true;
      const listed = (await client.listTools()).tools ?? [];
      row.tools = listed.length;
      if (!listed.some((t) => t.name === "purix_status")) throw new Error("purix_status is not in tools/list");
      const st = await client.callTool({ name: "purix_status", arguments: {} });
      row.status = !st.isError;
      const wr = await client.callTool({ name: "purix_tools_request_install", arguments: { toolId: "ruff", reason: "connect harness" } });
      const wtext = (wr.content ?? []).map((x) => x.text ?? "").join("\n");
      row.write = !wr.isError && /request/i.test(wtext);
      if (!row.write) row.error = `write tool answered: ${wtext.slice(0, 200)}`;
    } finally {
      await client.close().catch(() => {});
    }
  } catch (e) {
    row.error = row.error ?? String(e instanceof Error ? e.message : e).slice(0, 300);
  }
  results.push(row);
  const ok = row.config && row.server && row.status && row.write;
  console.log(`${ok ? "ok  " : "FAIL"} ${id.padEnd(20)} config=${row.config} server=${row.server} tools=${row.tools} status=${row.status} write=${row.write}${row.error ? `  ${row.error}` : ""}`);
}

// Every client's server must list the same tools, and the number the tests expect.
const counts = new Set(results.filter((r) => r.tools !== null).map((r) => r.tools));
let consistent = counts.size <= 1 && (EXPECT === null || [...counts].every((c) => c === EXPECT));
for (const r of results) if (r.tools !== null && EXPECT !== null && r.tools !== EXPECT) r.error = `${r.error ? r.error + "; " : ""}expected ${EXPECT} tools, got ${r.tools}`;

const record = { date: new Date().toISOString(), os: `${platform()}-${arch()}`, node: process.version, purix: cliVersion, addMcp: addMcpVersion, expectedTools: EXPECT, rows: results };
const logDir = join(root, ".test-logs");
mkdirSync(logDir, { recursive: true });
const outFile = join(logDir, `connect-harness-${record.date.replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-")}.json`);
writeFileSync(outFile, JSON.stringify(record, null, 2));
console.log(`\nrecord: ${outFile}`);

// ---- the support table ----
if (tablePath) {
  let realRuns = [];
  const runsFile = join(root, "docs", "client-runs.json");
  if (existsSync(runsFile)) realRuns = JSON.parse(readFileSync(runsFile, "utf-8")).runs ?? [];
  const lines = [
    "# Client support table",
    "",
    "Generated by `node scripts/connect-harness.mjs --table docs/CLIENT_SUPPORT.md`. Do not edit by hand.",
    "",
    `Harness run: ${record.date.slice(0, 10)}, ${record.os}, Node ${record.node}, Purix ${record.purix}, add-mcp ${record.addMcp}.`,
    "",
    "**How to read it.** *Config test* means Purix wrote a config for that agent, the server named in it started, answered `tools/list`, and",
    "answered one read tool (`purix_status`) and one write tool (`purix_tools_request_install`, which only records a request). It does **not**",
    "show that the agent loads the file or calls the tool. An agent is listed **Supported** only when `docs/client-runs.json` holds a passing",
    "run of the real agent (C-20). Every other agent is **Not verified with the real client**, whatever the config test shows.",
    "",
    "| Agent | Config file written | Config test | Real-agent run | Status |",
    "|---|---|---|---|---|",
  ];
  for (const r of results) {
    const pass = r.config && r.server && r.status && r.write && !r.error;
    const run = realRuns.filter((x) => x.client === r.client && x.pass === true).sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
    lines.push(`| ${r.displayName} (\`${r.client}\`) | \`${r.configPath ?? "none"}\` | ${pass ? "pass" : `FAIL: ${r.error ?? "see record"}`} | ${run ? `pass: ${run.version}, ${run.os}, ${run.date}` : "not run"} | ${run ? "Supported" : "Not verified with the real client"} |`);
  }
  mkdirSync(dirname(resolve(tablePath)), { recursive: true });
  writeFileSync(resolve(tablePath), lines.join("\n") + "\n");
  console.log(`table: ${resolve(tablePath)}`);
}

const failed = results.filter((r) => !(r.config && r.server && r.status && r.write));
try { rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 }); } catch { /* a leftover temp folder is harmless */ }
if (failed.length > 0 || !consistent) {
  console.error(`\nconnect-harness: ${failed.length} agent(s) failed${consistent ? "" : "; tool counts differ or do not match the expected number"}`);
  process.exit(1);
}
console.log(`\nconnect-harness: ${results.length} agents, config test passed for every one (this is not a real-agent result)`);
