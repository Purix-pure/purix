// scripts/ci-bypass-flow.mjs: C-21 (PURIX-36). The bypass test.
//
// ci-hook-flow feeds `purix hook` a payload directly. That proves the ENGINE blocks; it does not prove that what `purix hooks install`
// WROTE would make an agent run the engine, or what happens when the hook is not installed. This script closes that gap with a
// SIMULATED AGENT: for each agent it reads the config file the installer wrote, finds the hook command(s) whose matcher covers the
// tool, runs exactly that command text with the payload on stdin (a POSIX shell, as the agents do), and interprets the result the way
// that agent's documentation says (exit 2 blocks for Claude Code / Codex / Cursor; a {"decision":"deny"} body for Gemini CLI and
// Antigravity; a non-zero exit makes the OpenCode plugin throw). A write the simulated agent is not blocked from is APPLIED to disk.
//
//   HOOKS INSTALLED   a direct edit of the governed file is blocked and the file is unchanged; a shell `rm` of it is blocked;
//                     an edit of an ungoverned file goes through; a tool the matcher does not cover goes through (stated, not hidden).
//   HOOKS UNINSTALLED the same direct edit is APPLIED (the hook is gone, so nothing stops it), and `purix check --strict` then fails
//                     (exit 1) and names the file. This is the backstop the docs rely on when an agent skips its hook.
//
// So the pass condition is the plan's: the test fails with hooks uninstalled (the edit lands) and passes with them installed (it is blocked),
// and the check catches what landed. What it does NOT prove: that a real agent loads the config (C-20, scripts/real-agent-kit.mjs).
// Needs a POSIX shell: Linux and macOS always; on Windows only when `sh` is on PATH (Git for Windows), otherwise each agent is reported
// NOT CHECKED, never PASS.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, platform, arch } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "cli", "dist", "cli.js");
if (!existsSync(cli)) {
  console.error(`ci-bypass-flow: ${cli} not found. Run "pnpm run build" first.`);
  process.exit(2);
}
const isWin = process.platform === "win32";
const shAvailable = spawnSync("sh", ["-c", "exit 0"], { stdio: "ignore" }).status === 0;
const root = realpathSync(mkdtempSync(join(tmpdir(), "purix-ci-bypass-")));
const bin = join(root, "bin");
mkdirSync(bin, { recursive: true });
// The `purix` the hook commands call, pointed at the build under test (what `npm install -g @purix/cli` would put on PATH).
// PURIX_BYPASS_NEGATIVE_CONTROL=1: the hook's `purix` always crashes (exit 1). A fail-closed install must then block EVERYTHING,
// so the "ungoverned edit goes through" check must FAIL. Used once by hand to show these checks can fail.
const broken = process.env.PURIX_BYPASS_NEGATIVE_CONTROL === "1";
writeFileSync(join(bin, "purix"), broken ? "#!/bin/sh\nexit 1\n" : `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`);
chmodSync(join(bin, "purix"), 0o755);
writeFileSync(join(bin, "purix.cmd"), `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`);

let failures = 0;
const results = [];
function check(agent, label, cond, detail = "") {
  console.log(`${cond ? "ok  " : "FAIL"} ${agent}: ${label}`);
  results.push({ agent, label, result: cond ? "pass" : "fail" });
  if (!cond) {
    failures++;
    if (detail) console.log(String(detail).split("\n").map((l) => `     ${l}`).join("\n"));
  }
}
function notChecked(agent, why) {
  console.log(`SKIP ${agent}: NOT CHECKED (${why})`);
  results.push({ agent, label: "all", result: "not-checked", why });
}

const ORIGINAL = "export const a = 1;\n";
const EDITED = "export const a = 1;\n// edited by the simulated agent\n";

// Where each agent's installed config lives, and how to pull (matcher, command) pairs out of it.
const CONFIG = {
  "claude-code": { file: (p) => join(p, ".claude", "settings.local.json"), event: "PreToolUse", shape: "nested" },
  codex: { file: (p) => join(p, ".codex", "hooks.json"), event: "PreToolUse", shape: "nested" },
  gemini: { file: (p) => join(p, ".gemini", "settings.json"), event: "BeforeTool", shape: "nested" },
  cursor: { file: (p) => join(p, ".cursor", "hooks.json"), event: "preToolUse", shape: "flat" },
  antigravity: { file: (_p, h) => join(h, ".gemini", "config", "hooks.json"), event: "PreToolUse", shape: "named-group" },
  opencode: { file: (p) => join(p, ".opencode", "plugins", "purix-guard.ts"), shape: "plugin" },
};

/** The (matcher, command) pairs the agent would run before a tool, read from the file the installer wrote. */
function installedCommands(agent, proj, home) {
  const spec = CONFIG[agent];
  const file = spec.file(proj, home);
  if (!existsSync(file)) return [];
  if (spec.shape === "plugin") return [{ matcher: "*", command: "__opencode_plugin__" }];
  const doc = JSON.parse(readFileSync(file, "utf-8"));
  const out = [];
  if (spec.shape === "flat") {
    for (const ev of [spec.event, "beforeShellExecution"]) for (const e of doc.hooks?.[ev] ?? []) if (typeof e.command === "string") out.push({ matcher: "*", command: e.command, event: ev });
  } else {
    const list = spec.shape === "named-group" ? doc.purix?.[spec.event] ?? [] : doc.hooks?.[spec.event] ?? [];
    for (const e of list) for (const h of e.hooks ?? []) if (typeof h.command === "string") out.push({ matcher: e.matcher ?? "*", command: h.command });
  }
  return out;
}

function matcherCovers(matcher, tool) {
  if (matcher === "*" || matcher === "" || matcher === undefined) return true;
  return matcher.split("|").includes(tool);
}

/** Runs one hook command the way the agent does and says whether that agent treats the result as a block. */
function runHookCommand(agent, command, payload, cwd, home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1", PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, CLAUDE_PROJECT_DIR: "", GEMINI_PROJECT_DIR: "" };
  const r = command === "__opencode_plugin__"
    ? spawnSync("purix", ["hook", "opencode", "pre-tool-use"], { cwd, input: payload, encoding: "utf-8", env, timeout: 120000, shell: isWin })
    : spawnSync("sh", ["-c", command], { cwd, input: payload, encoding: "utf-8", env, timeout: 120000 });
  const out = r.stdout ?? "";
  let blocked;
  if (agent === "gemini" || agent === "antigravity") {
    try { blocked = JSON.parse(out).decision === "deny"; } catch { blocked = false; }
    if (r.status === 2) blocked = true; // Gemini CLI: exit 2 also blocks
  } else if (agent === "cursor") {
    // the installed entry sets failClosed: true, so Cursor treats a crash or any non-zero exit as a block as well
    try { blocked = JSON.parse(out).permission === "deny" || r.status !== 0; } catch { blocked = r.status !== 0; }
  } else if (agent === "opencode") {
    blocked = r.status !== 0; // the plugin throws on any non-zero exit
  } else {
    blocked = r.status === 2; // Claude Code, Codex: only exit 2 blocks; any other code lets the call through
  }
  return { blocked, status: r.status, out, err: r.stderr ?? "" };
}

/**
 * The simulated agent. `tool` is the agent's own tool name. Returns { ran, blocked }. A write that is not blocked is applied to disk.
 * `ran` lists the hook commands that matched; an empty list means the agent ran no hook at all.
 */
function agentAttempts(agent, proj, home, tool, payloadObj, apply) {
  const payload = JSON.stringify(payloadObj);
  const hooks = installedCommands(agent, proj, home).filter((h) => matcherCovers(h.matcher, tool));
  const verdicts = hooks.map((h) => runHookCommand(agent, h.command, payload, proj, home));
  const blocked = verdicts.some((v) => v.blocked);
  if (!blocked && apply) apply();
  return { ran: hooks.length, blocked, verdicts };
}

const WRITE = {
  "claude-code": { tool: "Edit", payload: (p, proj) => ({ tool_name: "Edit", tool_input: { file_path: p }, cwd: proj }) },
  codex: { tool: "apply_patch", payload: (p, proj) => ({ tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Update File: ${p}\n*** End Patch` }, cwd: proj }) },
  cursor: { tool: "StrReplace", payload: (p, proj) => ({ tool_name: "StrReplace", tool_input: { path: p }, workspace_roots: [proj] }) },
  gemini: { tool: "write_file", payload: (p, proj) => ({ tool_name: "write_file", tool_input: { file_path: p, content: "x" }, cwd: proj }) },
  antigravity: { tool: "write_to_file", payload: (p, proj) => ({ toolCall: { name: "write_to_file", args: { TargetFile: p } }, workspacePaths: [proj] }) },
  opencode: { tool: "edit", payload: (p, proj) => ({ tool_name: "edit", tool_input: { filePath: p }, cwd: proj }) },
};
const SHELL = {
  "claude-code": { tool: "Bash", payload: (proj) => ({ tool_name: "Bash", tool_input: { command: "rm src/a.ts" }, cwd: proj }) },
  codex: { tool: "Bash", payload: (proj) => ({ tool_name: "Bash", tool_input: { command: "rm src/a.ts" }, cwd: proj }) },
  cursor: { tool: "Shell", payload: (proj) => ({ tool_name: "Shell", tool_input: { command: "rm src/a.ts" }, cwd: proj, workspace_roots: [proj] }) },
  gemini: { tool: "run_shell_command", payload: (proj) => ({ tool_name: "run_shell_command", tool_input: { command: "rm src/a.ts" }, cwd: proj }) },
  antigravity: { tool: "run_command", payload: (proj) => ({ toolCall: { name: "run_command", args: { CommandLine: "rm src/a.ts" } }, workspacePaths: [proj] }) },
  opencode: { tool: "bash", payload: (proj) => ({ tool_name: "bash", tool_input: { command: "rm src/a.ts" }, cwd: proj }) },
};

for (const agent of Object.keys(CONFIG)) {
  if (isWin && !shAvailable && agent !== "opencode") { notChecked(agent, "no POSIX shell (sh) on PATH; the installed commands are POSIX snippets"); continue; }
  if (isWin && agent === "codex") { notChecked(agent, "on Windows Codex runs its PowerShell form (commandWindows), which this simulation does not run yet"); continue; }

  const dir = join(root, agent);
  const home = join(dir, "home");
  const proj = join(dir, "proj");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(proj, "src"), { recursive: true });
  mkdirSync(join(proj, ".git"));
  const env = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1", CLAUDE_PROJECT_DIR: "", GEMINI_PROJECT_DIR: "" };
  const purix = (...a) => { const r = spawnSync(process.execPath, [cli, ...a], { cwd: proj, encoding: "utf-8", env, timeout: 120000 }); return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }; };
  const gov = join(proj, "src", "a.ts");
  const free = join(proj, "src", "free.ts");
  writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "p", version: "1.0.0", type: "module" }));
  writeFileSync(gov, ORIGINAL);
  writeFileSync(free, "export const f = 1;\n");
  const setup = [purix("index"), purix("adopt", "src/a.ts"), purix("lock"), purix("hooks", "install", agent)];
  if (setup.some((s) => s.code !== 0)) { check(agent, "setup (index, adopt, lock, hooks install)", false, setup.map((s) => s.out).join("\n")); continue; }

  const write = WRITE[agent];
  const shell = SHELL[agent];
  const hooksFound = installedCommands(agent, proj, home);
  check(agent, "the installer wrote a hook the simulated agent can find", hooksFound.length > 0, JSON.stringify(hooksFound));

  // ---- HOOKS INSTALLED ----
  const direct = agentAttempts(agent, proj, home, write.tool, write.payload(gov, proj), () => writeFileSync(gov, EDITED));
  check(agent, "installed: a direct edit of the governed file is blocked and the file is unchanged", direct.ran > 0 && direct.blocked && readFileSync(gov, "utf-8") === ORIGINAL, JSON.stringify(direct.verdicts));
  const rm = agentAttempts(agent, proj, home, shell.tool, shell.payload(proj), () => writeFileSync(gov, EDITED));
  check(agent, "installed: a shell `rm` of the governed file is blocked", rm.ran > 0 && rm.blocked && readFileSync(gov, "utf-8") === ORIGINAL, JSON.stringify(rm.verdicts));
  const ok = agentAttempts(agent, proj, home, write.tool, write.payload(free, proj), () => writeFileSync(free, "export const f = 2;\n"));
  check(agent, "installed: an edit of an UNgoverned file goes through", ok.ran > 0 && !ok.blocked && readFileSync(free, "utf-8") === "export const f = 2;\n", JSON.stringify(ok.verdicts));
  const clean = purix("check", "--json");
  let lockOutcome;
  try { lockOutcome = JSON.parse(clean.out).sections.find((x) => x.id === "lock")?.outcome; } catch { /* reported below */ }
  check(agent, "installed: nothing governed changed, so the lock section of `purix check` passes", lockOutcome === "pass", clean.out.slice(0, 400));

  // ---- HOOKS UNINSTALLED ----
  const un = purix("hooks", "uninstall", agent);
  check(agent, "`purix hooks uninstall` succeeds", un.code === 0, un.out);
  const after = agentAttempts(agent, proj, home, write.tool, write.payload(gov, proj), () => writeFileSync(gov, EDITED));
  check(agent, "uninstalled: no hook runs, so the direct edit LANDS (this is the bypass the backstop must catch)", after.ran === 0 && readFileSync(gov, "utf-8") === EDITED, JSON.stringify({ ran: after.ran }));
  const strict = purix("check", "--strict");
  check(agent, "uninstalled: `purix check --strict` fails (exit 1) and names the edited file", strict.code === 1 && /a\.ts/.test(strict.out), `exit ${strict.code}\n${strict.out.slice(0, 600)}`);
}

const record = { date: new Date().toISOString(), os: `${platform()}-${arch()}`, node: process.version, failures, results };
mkdirSync(join(dirname(cli), "..", "..", "..", ".test-logs"), { recursive: true });
const out = join(dirname(cli), "..", "..", "..", ".test-logs", "ci-bypass-flow.json");
writeFileSync(out, JSON.stringify(record, null, 2));
console.log(`\nrecord: ${out}`);
try { rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp folder */ }
if (failures > 0) {
  console.error(`\nci-bypass-flow: ${failures} check(s) failed`);
  process.exit(1);
}
const skipped = results.filter((r) => r.result === "not-checked").length;
console.log(`\nci-bypass-flow: all executed checks passed${skipped ? ` (${skipped} agent(s) NOT CHECKED on this machine)` : ""}`);
