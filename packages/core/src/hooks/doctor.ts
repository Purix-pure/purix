// src/hooks/doctor.ts
//
// `purix hooks doctor` (A9-1, research 09 task "prove it with a canary"). Core returns data; the CLI prints it (rule R1).
//
// WHAT IT PROVES, AND WHAT IT DOES NOT. For each agent whose hook is installed, it
//   1. reads the config back and checks the settings that decide whether a timeout or a failure to start lets a call through;
//   2. runs the INSTALLED command string, as written in the agent's config, with a SIMULATED payload: a write to Purix's own state
//      folder, which the engine blocks in any project. It reports whether a block came back in that agent's answer style;
//   3. runs the same command with `purix` removed from PATH, to show the shell wrapper turns "could not start" into a block;
//   4. says what is left to a live agent: ask it to write the canary file and run the doctor again.
// Steps 2 and 3 exercise Purix's command and the shell, not the agent. A real agent loading the config and honouring the answer is
// NOT shown by anything here (docs/HOOKS.md, "What is not verified"), and the report says so in its own words. Only step 4's result,
// seen on a live agent, closes that, which is the real-machine pass (A10e).
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../platform/atomic_write.js";
import { safeRmSync } from "../platform/fs_retry.js";
import { PURIX_DIRNAME } from "../platform/layout.js";
import { spawnSync } from "../platform/spawn_sync.js";
import { agentLabel, extractPreToolEntry, hookStrengthFindings, readHookInstallState, scopesFor } from "./install.js";
import { ANSWER_STYLE, HOOK_AGENTS, type HookAgent } from "./protocol.js";

/** The file the canary asks an agent to write. Inside Purix's state folder, which no agent tool may write in any project. */
export const CANARY_RELATIVE_PATH = `${PURIX_DIRNAME}/hook-canary.txt`;

export type DoctorOutcome = "pass" | "fail" | "not-run";
export type DoctorCheckId = "config" | "strength" | "canary-block" | "canary-fail-closed" | "live-agent";

export interface DoctorCheck {
  id: DoctorCheckId;
  outcome: DoctorOutcome;
  message: string;
}

export interface DoctorAgentReport {
  agent: HookAgent;
  label: string;
  /** Config files where Purix's entry was found. */
  paths: string[];
  checks: DoctorCheck[];
  /** A line to paste into a terminal to run the same canary by hand (for Windows, where the doctor does not run it). */
  manual: { posix: string; powershell: string };
}

export interface DoctorReport {
  agents: DoctorAgentReport[];
  /** True only when at least one hook is installed and every installed agent shows a block from the canary and no check failed. */
  ok: boolean;
  notes: string[];
}

export type CanaryMode = "normal" | "no-purix";
export interface CanaryRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Set when the command ended abnormally (timeout, not found, output limit). */
  stopped?: string;
}
/** Runs a hook command string with a payload on stdin. "no-purix" runs it with `purix` unreachable. Injected in tests. */
export type CanaryRunner = (command: string, payload: string, mode: CanaryMode, opts: { cwd: string }) => CanaryRun;

export interface DoctorOptions {
  root: string;
  home?: string;
  /** Limit the check to these agents. Default: every agent with a hook installed. */
  agents?: HookAgent[];
  platform?: NodeJS.Platform;
  run?: CanaryRunner;
}

/** The payload an agent would send for a write to the canary file, in that agent's own shape (the shapes protocol.ts reads). */
export function canaryPayload(agent: HookAgent, root: string): string {
  const file = join(root, CANARY_RELATIVE_PATH);
  switch (agent) {
    case "claude-code": return JSON.stringify({ tool_name: "Write", tool_input: { file_path: file, content: "canary" }, cwd: root });
    case "codex": return JSON.stringify({ tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Add File: ${file}\n+canary\n*** End Patch` }, cwd: root });
    case "gemini": return JSON.stringify({ tool_name: "write_file", tool_input: { file_path: file, content: "canary" }, cwd: root });
    case "cursor": return JSON.stringify({ tool_name: "Write", tool_input: { path: file }, workspace_roots: [root] });
    case "antigravity": return JSON.stringify({ toolCall: { name: "write_to_file", args: { TargetFile: file } }, workspacePaths: [root] });
    case "opencode": return JSON.stringify({ tool_name: "write", tool_input: { filePath: file, content: "canary" }, cwd: root });
  }
}

/** True when the answer is a block in the way this agent reads one. An allow, silence and a crash are not a block. */
export function blockSeen(agent: HookAgent, answer: { exitCode: number | null; stdout: string; stderr: string }): boolean {
  const style = ANSWER_STYLE[agent];
  if (style === "exit2" || style === "cursor") return answer.exitCode === 2;
  if (answer.exitCode !== 0) return false;
  try {
    const parsed = JSON.parse(answer.stdout.trim()) as { decision?: unknown };
    return parsed.decision === "deny";
  } catch {
    return false;
  }
}

function posixQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

const defaultRunner: CanaryRunner = (command, payload, mode, opts) => {
  const dir = mkdtempSync(join(tmpdir(), "purix-doctor-"));
  try {
    const file = join(dir, "payload.json");
    writeFileAtomic(file, payload);
    const empty = join(dir, "empty-path");
    // /bin/sh by absolute path, so the shell itself is found even when PATH holds nothing.
    const r = spawnSync(["/bin/sh", "-c", `${command} < ${posixQuote(file)}`], {
      cwd: opts.cwd,
      env: mode === "no-purix" ? { PATH: empty } : undefined,
      deadlineMs: 30_000,
    });
    return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString(), ...(r.stopped ? { stopped: r.stopped } : {}) };
  } finally {
    safeRmSync(dir);
  }
};

/** Agents whose installed command wraps the engine so that "could not start" becomes a block (install.ts guardedCommand). */
const WRAPPED = new Set<HookAgent>(["claude-code", "codex", "gemini", "antigravity"]);

function engineCommand(agent: HookAgent): string {
  return `purix hook ${agent} pre-tool-use`;
}

function readText(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : null;
  } catch {
    return null;
  }
}

function describeRun(r: CanaryRun): string {
  if (r.stopped) return `the command could not be run (${r.stopped}${r.stderr ? `: ${r.stderr.trim().slice(0, 200)}` : ""})`;
  return `exit ${r.exitCode}${r.stdout.trim() ? `, stdout ${r.stdout.trim().slice(0, 160)}` : ""}${r.stderr.trim() ? `, stderr ${r.stderr.trim().slice(0, 160)}` : ""}`;
}

export function runHookDoctor(opts: DoctorOptions): DoctorReport {
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? defaultRunner;
  const candidates = opts.agents ?? HOOK_AGENTS;
  const agents: DoctorAgentReport[] = [];

  for (const agent of candidates) {
    const states = scopesFor(agent).map((scope) => ({ scope, ...readHookInstallState(agent, scope, opts.root, home) }));
    const present = states.filter((s) => s.state !== "not-installed");
    if (present.length === 0) continue;
    const label = agentLabel(agent);
    const checks: DoctorCheck[] = [];
    const installed = states.filter((s) => s.state === "installed");
    const bad = present.filter((s) => s.state !== "installed");

    // 1. config
    if (installed.length > 0 && bad.length === 0) checks.push({ id: "config", outcome: "pass", message: `the hook entry is in ${installed.map((s) => s.path).join(", ")}` });
    else checks.push({ id: "config", outcome: "fail", message: `${bad.map((s) => `${s.state} in ${s.path}`).join("; ")}. Run \`purix hooks install ${agent}\` to repair.` });

    // 2. strength of the installed entry (what a timeout or a failure to start does)
    const first = installed[0] ?? present[0]!;
    const text = readText(first.path);
    if (agent === "opencode") {
      checks.push({ id: "strength", outcome: "pass", message: "the plugin throws, which blocks the tool, when the command fails or takes longer than 10 seconds" });
    } else {
      const findings = hookStrengthFindings(agent, text);
      checks.push(findings.length === 0 ? { id: "strength", outcome: "pass", message: "the entry fails closed where the agent allows it (explicit timeout, and onFailure or failClosed where it exists)" } : { id: "strength", outcome: "fail", message: findings.join("; ") });
    }

    const entry = agent === "opencode" ? { command: engineCommand(agent) } : extractPreToolEntry(agent, text);
    const payload = canaryPayload(agent, opts.root);
    const manual = {
      posix: `printf '%s' ${posixQuote(payload)} | ${entry?.command ?? engineCommand(agent)}; echo "exit=$?"`,
      powershell: `${psQuote(payload)} | ${engineCommand(agent)}; "exit=$LASTEXITCODE"`,
    };

    // 3 and 4. the installed command, with a simulated payload
    if (platform === "win32") {
      const msg = "not run on Windows: the installed commands are POSIX shell snippets (Codex also has a PowerShell form) and the doctor does not exercise either yet. Run the PowerShell line below and read the exit code (2 means a block).";
      checks.push({ id: "canary-block", outcome: "not-run", message: msg });
      checks.push({ id: "canary-fail-closed", outcome: "not-run", message: msg });
    } else if (entry === null) {
      checks.push({ id: "canary-block", outcome: "fail", message: "the hook command could not be read back from the config, so it was not run" });
      checks.push({ id: "canary-fail-closed", outcome: "not-run", message: "no command to run" });
    } else {
      const r1 = run(entry.command, payload, "normal", { cwd: opts.root });
      if (r1.stopped || r1.exitCode === null) checks.push({ id: "canary-block", outcome: "fail", message: `the installed command ${describeRun(r1)}. Is purix installed and on PATH?` });
      else if (blockSeen(agent, r1)) checks.push({ id: "canary-block", outcome: "pass", message: `the installed command blocked a simulated write to Purix's state folder (${describeRun(r1)}). This used a simulated payload, not a live agent.` });
      else checks.push({ id: "canary-block", outcome: "fail", message: `the installed command ALLOWED a simulated write to Purix's state folder (${describeRun(r1)}). It would not stop that write.` });

      if (!WRAPPED.has(agent)) {
        checks.push({ id: "canary-fail-closed", outcome: "not-run", message: agent === "cursor" ? "Cursor handles a hook that fails to run itself (failClosed); that needs a live Cursor to see" : "the plugin throws when the command fails; that needs a live OpenCode to see" });
      } else {
        const r2 = run(entry.command, payload, "no-purix", { cwd: opts.root });
        if (r2.stopped && r2.stopped !== "not_found") checks.push({ id: "canary-fail-closed", outcome: "fail", message: `the command ${describeRun(r2)}` });
        else if (r2.exitCode !== null && blockSeen(agent, r2)) checks.push({ id: "canary-fail-closed", outcome: "pass", message: "with purix removed from PATH the installed command still returned a block (simulated; a hang is not covered by this check, which is what the timeout and onFailure settings are for)" });
        else checks.push({ id: "canary-fail-closed", outcome: "fail", message: `with purix removed from PATH the installed command did NOT return a block (${describeRun(r2)}). A missing purix would let calls through.` });
      }
    }

    // 5. live agent
    const canaryFile = join(opts.root, CANARY_RELATIVE_PATH);
    if (existsSync(canaryFile)) {
      checks.push({ id: "live-agent", outcome: "fail", message: `${CANARY_RELATIVE_PATH} exists: some tool wrote into Purix's state folder past the hook. Delete it, restart ${label}, and check the hook is loaded.` });
    } else {
      checks.push({ id: "live-agent", outcome: "not-run", message: `needs a live ${label}. Ask it to create the file ${CANARY_RELATIVE_PATH}. If the hook is loaded, the write is blocked and the file does not appear; run this command again afterwards.` });
    }

    agents.push({ agent, label, paths: installed.map((s) => s.path), checks, manual });
  }

  const notes: string[] = [];
  if (agents.length === 0) notes.push("No hook is installed in this folder or your home folder. Run `purix hooks install`.");
  else notes.push("These checks run the installed hook command with a simulated payload. They do not show that a live agent loads the hook or honours the block. The last check for each agent is that live step.");
  const ok = agents.length > 0 && agents.every((a) => a.checks.every((c) => c.outcome !== "fail") && a.checks.find((c) => c.id === "canary-block")?.outcome === "pass");
  return { agents, ok, notes };
}

