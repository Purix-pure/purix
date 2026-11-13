// scripts/ci-hook-flow.mjs
//
// The hook scenario end to end on a project made by the REAL CLI (index, adopt), not a test fixture, run on every OS in ci.yml
// and before publish. For each supported agent it feeds that agent's payload to `purix hook <agent> pre-tool-use` and checks
// the answer in that agent's own style:
//   - an edit to the governed file is blocked,
//   - an edit to an ungoverned file is allowed,
//   - the agent's own hook config cannot be edited,
//   - an unreadable payload is blocked (fails closed).
// It also installs the hook for each agent with `purix hooks install` and checks the config file appears. Nothing here proves an
// agent LOADS the hook; that needs the real client (docs/HOOKS.md, "What is not verified"). Uses only the built CLI, a temp
// directory and a temp HOME. Writes readiness-hooks.json (a record: date, OS, node, per-agent results) next to the temp project
// and prints its path.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir, platform, arch } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "cli", "dist", "cli.js");
if (!existsSync(cli)) {
  console.error(`ci-hook-flow: ${cli} not found. Run "pnpm run build" first.`);
  process.exit(2);
}
const root = realpathSync(mkdtempSync(join(tmpdir(), "purix-ci-hook-")));
const home = join(root, "home");
const proj = join(root, "proj");
mkdirSync(home, { recursive: true });
mkdirSync(join(proj, "src"), { recursive: true });
mkdirSync(join(proj, ".git"));
let failures = 0;
const results = [];

const env = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1", CLAUDE_PROJECT_DIR: "", GEMINI_PROJECT_DIR: "" };
function purix(args, input) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: proj, input, encoding: "utf-8", env, timeout: 120000 });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}
function check(agent, label, cond, detail = "") {
  console.log(`${cond ? "ok  " : "FAIL"} ${agent}: ${label}`);
  results.push({ agent, label, ok: Boolean(cond) });
  if (!cond) {
    failures++;
    if (detail) console.log(detail.split("\n").map((l) => `     ${l}`).join("\n"));
  }
}
const blocked = (r) => {
  if (r.code === 2) return true;
  try {
    return JSON.parse(r.out).decision === "deny";
  } catch {
    return false;
  }
};

// Payloads in each agent's shape for "write this file".
const gov = join(proj, "src", "a.ts");
const free = join(proj, "src", "free.ts");
const payloads = {
  "claude-code": (p) => ({ tool_name: "Edit", tool_input: { file_path: p }, cwd: proj }),
  codex: (p) => ({ tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Update File: ${p}\n*** End Patch` }, cwd: proj }),
  cursor: (p) => ({ tool_name: "StrReplace", tool_input: { path: p }, workspace_roots: [proj] }),
  gemini: (p) => ({ tool_name: "write_file", tool_input: { file_path: p, content: "x" }, cwd: proj }),
  antigravity: (p) => ({ toolCall: { name: "write_to_file", args: { TargetFile: p } }, workspacePaths: [proj] }),
  opencode: (p) => ({ tool_name: "edit", tool_input: { filePath: p }, cwd: proj }),
};
const ownConfig = { "claude-code": ".claude/settings.local.json", codex: ".codex/hooks.json", cursor: ".cursor/hooks.json", gemini: ".gemini/settings.json", antigravity: ".agents/hooks.json", opencode: ".opencode/plugins/purix-guard.ts" };
const installedAt = { "claude-code": join(proj, ".claude", "settings.local.json"), codex: join(proj, ".codex", "hooks.json"), cursor: join(proj, ".cursor", "hooks.json"), gemini: join(proj, ".gemini", "settings.json"), opencode: join(proj, ".opencode", "plugins", "purix-guard.ts") };

try {
  writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "p", version: "1.0.0", type: "module" }));
  writeFileSync(gov, "export const a = 1;\n");
  writeFileSync(free, "export const f = 1;\n");
  const index = purix(["index"]);
  const adopt = purix(["adopt", "src/a.ts"]);
  if (index.code !== 0 || adopt.code !== 0) {
    console.log(`FAIL setup: index exit ${index.code}, adopt exit ${adopt.code}\n${index.err}${adopt.err}${adopt.out}`);
    process.exit(1);
  }

  for (const [agent, shape] of Object.entries(payloads)) {
    const write = (p) => purix(["hook", agent, "pre-tool-use"], JSON.stringify(shape(p)));
    check(agent, "an edit to the governed file is blocked", blocked(write(gov)), JSON.stringify(write(gov)));
    const ok = write(free);
    check(agent, "an edit to an ungoverned file is allowed", ok.code === 0 && !blocked(ok), JSON.stringify(ok));
    check(agent, "its own hook config cannot be edited", blocked(write(join(proj, ownConfig[agent]))));
    check(agent, "an unreadable payload is blocked", blocked(purix(["hook", agent, "pre-tool-use"], "garbage")));
    const shell = purix(["hook", agent, "pre-tool-use"], JSON.stringify(agent === "antigravity" ? { toolCall: { name: "run_command", args: { CommandLine: "rm src/a.ts" } }, workspacePaths: [proj] } : { tool_name: agent === "gemini" ? "run_shell_command" : agent === "opencode" ? "bash" : "Bash", tool_input: { command: "rm src/a.ts" }, cwd: proj, workspace_roots: [proj] }));
    check(agent, "a shell rm of the governed file is blocked", blocked(shell));
  }

  // The installer, for the agents whose file lives in the project (Antigravity's default is the global file in the temp HOME).
  for (const [agent, path] of Object.entries(installedAt)) {
    const r = purix(["hooks", "install", agent]);
    check(agent, "`purix hooks install` writes its config", r.code === 0 && existsSync(path), r.out + r.err);
  }
  const agy = purix(["hooks", "install", "antigravity"]);
  check("antigravity", "`purix hooks install` writes the global file under the temp HOME", agy.code === 0 && existsSync(join(home, ".gemini", "config", "hooks.json")), agy.out + agy.err);
} finally {
  const record = { date: new Date().toISOString(), os: `${platform()}-${arch()}`, node: process.version, failures, results };
  const out = join(root, "readiness-hooks.json");
  writeFileSync(out, JSON.stringify(record, null, 2));
  console.log(`\nrecord: ${out}`);
}
if (failures > 0) {
  console.error(`\nci-hook-flow: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nci-hook-flow: all checks passed");
