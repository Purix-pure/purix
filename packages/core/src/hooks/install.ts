// src/hooks/install.ts
//
// Writes (and removes, and reads back) the hook entry for each supported agent. ONE table (AGENT_SPECS) says where each
// agent's config lives and what shape it takes; the engine it calls (`purix hook <agent> <event>`) is the same for all of
// them (PURIX-23 section 2.3). Adding an agent is a table row plus, at most, a new payload field name in protocol.ts.
//
// Rules that hold for every agent:
//  - Never overwrite what is already there. Other tools' hooks and every unrelated setting stay exactly as they were.
//  - Our entries are recognised by their command text ("purix hook "), removed and re-added on every install, so running it
//    twice leaves one copy.
//  - A config file that is not valid JSON, or whose hooks are not the expected shape, is refused with a message. It is never
//    "repaired" by replacing it. A plugin file we did not write is never overwritten either.
//  - Agents that fail open when a hook is missing or crashes (Claude Code, Codex, Gemini CLI) get a command that turns any exit
//    code other than the engine's own into a block. Cursor has `failClosed`; the OpenCode plugin throws on spawn failure.
//
// What was verified (and what was not): shapes follow Anthropic's hooks reference (Claude Code), Cursor's docs as quoted by
// third parties, OpenAI's Codex hooks page, Google's Gemini CLI hooks reference, and for Antigravity three third-party
// sources that agree on the file format (named groups, nested matcher entries). None has been loaded by a real client here.
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../platform/atomic_write.js";
import { ANSWER_STYLE, HOOK_AGENTS, type HookAgent } from "./protocol.js";

/** local: personal and uncommitted. shared: committed project file. user: the person's home config. project: the project's own file. */
export type HookScope = "local" | "shared" | "user" | "project";

const OURS = "purix hook ";
/** Name of the hook group Antigravity files use, and the first line of a plugin file we own. */
const GROUP_NAME = "purix";
const PLUGIN_MARKER = "// purix-managed: written by `purix hooks install opencode`; `purix hooks uninstall opencode` removes it. Edits are overwritten.";

/**
 * Claude Code runs a PreToolUse hook for the tools this names. A9-1 adds PowerShell (the Windows shell tool, which the old matcher never
 * sent to the hook) and every MCP tool, so a file-writing MCP server is screened by input shape (protocol.ts). Not run against a live
 * client: the matcher is a regular expression per Anthropic's hooks reference.
 */
export const CLAUDE_PRE_MATCHER = "Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|mcp__.*";
/**
 * Seconds a Claude Code PreToolUse hook may run before it is stopped. PROVISIONAL: my choice, not a measurement. Claude's default is
 * 600 and Cursor reports suggest a SHORT limit can backfire, so this is long enough for a cold start on a big store and short enough
 * that a hung hook does not stall the agent for ten minutes. With `onFailure: "block"` a timeout blocks the call instead of passing it.
 */
export const CLAUDE_HOOK_TIMEOUT_SECONDS = 30;
const CLAUDE_STOP_TIMEOUT_SECONDS = 60;
const CODEX_PRE_MATCHER = "Bash|apply_patch|Edit|Write";
const GEMINI_PRE_MATCHER = "write_file|replace|run_shell_command";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

type ConfigKind = "nested" | "flat" | "named-group" | "plugin-file";

interface AgentSpec {
  label: string;
  kind: ConfigKind;
  /** Scope used when none is asked for. */
  defaultScope: HookScope;
  /** Project-relative folder or file whose presence means the agent is used in this project. */
  detect: readonly string[];
  /** Config path per scope, relative to the project root, or to the home folder for "user". */
  paths: Partial<Record<HookScope, readonly string[]>>;
  /** True when the agent has a one-time trust or review step before a project hook runs. */
  needsTrust?: string;
  /** Known weakness to print after install. */
  note?: string;
}

export const AGENT_SPECS: Readonly<Record<HookAgent, AgentSpec>> = {
  "claude-code": {
    label: "Claude Code", kind: "nested", defaultScope: "local", detect: [".claude"],
    paths: { local: [".claude", "settings.local.json"], shared: [".claude", "settings.json"] },
  },
  cursor: {
    label: "Cursor", kind: "flat", defaultScope: "local", detect: [".cursor"],
    paths: { local: [".cursor", "hooks.json"] },
    note: "Cursor hooks are reported not to fire in some Windows and CLI setups. Treat Cursor as partial until you have seen a block.",
  },
  codex: {
    label: "Codex", kind: "nested", defaultScope: "local", detect: [".codex", "AGENTS.md"],
    paths: { local: [".codex", "hooks.json"] },
    needsTrust: "Open `/hooks` in Codex and trust the Purix hook once. Until then Codex skips it silently.",
  },
  gemini: {
    label: "Gemini CLI", kind: "nested", defaultScope: "local", detect: [".gemini", "GEMINI.md"],
    paths: { local: [".gemini", "settings.json"] },
    needsTrust: "Gemini CLI fingerprints project hooks and may ask you to review this one.",
  },
  antigravity: {
    label: "Antigravity", kind: "named-group", defaultScope: "user", detect: [".agents"],
    paths: { user: [".gemini", "config", "hooks.json"], project: [".agents", "hooks.json"] },
    note: "Written from third-party sources; it has not been run with a real agy. The Antigravity CLI is reported to ignore the project file (--project), so the default is the global file; hooks are reported to be skipped in always-approve mode.",
  },
  opencode: {
    label: "OpenCode", kind: "plugin-file", defaultScope: "local", detect: [".opencode", "opencode.json"],
    paths: { local: [".opencode", "plugins", "purix-guard.ts"] },
    note: "Subagent tool calls are reported to bypass OpenCode plugin hooks; `purix check` and your CI catch those afterwards.",
  },
};

export function agentLabel(agent: HookAgent): string {
  return AGENT_SPECS[agent].label;
}

export function agentNeedsTrust(agent: HookAgent): string | undefined {
  return AGENT_SPECS[agent].needsTrust;
}

export function agentNote(agent: HookAgent): string | undefined {
  return AGENT_SPECS[agent].note;
}

export function defaultScopeFor(agent: HookAgent): HookScope {
  return AGENT_SPECS[agent].defaultScope;
}

/** Scopes an agent supports, in the order `purix hooks status` reads them. */
export function scopesFor(agent: HookAgent): HookScope[] {
  return Object.keys(AGENT_SPECS[agent].paths) as HookScope[];
}

/** Agents whose folder or marker file already exists in this project. */
export function detectHookAgents(root: string): HookAgent[] {
  return HOOK_AGENTS.filter((a) => AGENT_SPECS[a].detect.some((d) => existsSync(join(root, d))));
}

export function hookConfigPath(agent: HookAgent, scope: HookScope, root: string, home: string = homedir()): string {
  const parts = AGENT_SPECS[agent].paths[scope];
  if (!parts) throw new Error(`${agentLabel(agent)} has no "${scope}" hook location`);
  return join(scope === "user" ? home : root, ...parts);
}

// ---------- commands ----------

/** Exit codes from the engine are 0 (no objection) and 2 (block). Anything else means the hook did not run, which must block. */
function guardedCommand(agent: HookAgent): string {
  const run = `purix hook ${agent} pre-tool-use`;
  if (ANSWER_STYLE[agent] === "decision-json") {
    // These agents read a JSON decision on exit 0, so a hook that did not run is answered with a JSON deny.
    return `${run}; c=$?; if [ "$c" -ne 0 ]; then echo '{"decision":"deny","reason":"Purix hook did not run (exit '"$c"'). Blocking to be safe."}'; fi; exit 0`;
  }
  return `${run}; c=$?; if [ "$c" -ne 0 ] && [ "$c" -ne 2 ]; then echo "Purix hook did not run (exit $c: is purix installed and on PATH?). Blocking to be safe." >&2; exit 2; fi; exit $c`;
}

/** Codex lets a command differ on Windows, which removes the need for a POSIX shell there. Not run on Windows yet. */
function codexWindowsCommand(): string {
  return (
    'powershell -NoProfile -Command "purix hook codex pre-tool-use; $c = $LASTEXITCODE; ' +
    "if ($c -ne 0 -and $c -ne 2) { [Console]::Error.WriteLine('Purix hook did not run (exit ' + $c + '). Blocking to be safe.'); exit 2 }; exit $c\""
  );
}

function stopCommand(agent: HookAgent): string {
  return `purix hook ${agent} stop`;
}

function preEntry(agent: HookAgent): Json {
  const command = guardedCommand(agent);
  switch (agent) {
    // onFailure: "block" (Claude Code 2.1.295 or later, per its hooks reference): a hook that times out or cannot start blocks the call.
    // Without it, a timeout or any exit code other than 2 lets the call through. An older client may ignore the field; the shell
    // wrapper in `command` still turns a missing purix or a crash into a block, but not a hang.
    case "claude-code": return { matcher: CLAUDE_PRE_MATCHER, hooks: [{ type: "command", command, timeout: CLAUDE_HOOK_TIMEOUT_SECONDS, onFailure: "block" }] };
    case "codex": return { matcher: CODEX_PRE_MATCHER, hooks: [{ type: "command", command, commandWindows: codexWindowsCommand(), timeout: 10, statusMessage: "Purix: checking this edit" }] };
    case "gemini": return { matcher: GEMINI_PRE_MATCHER, hooks: [{ name: GROUP_NAME, type: "command", command, timeout: 10000 }] };
    case "antigravity": return { matcher: "*", hooks: [{ type: "command", command, timeout: 10 }] };
    default: throw new Error(`no nested hook entry for ${agent}`);
  }
}

// ---------- JSON editing (nested, flat, named-group) ----------

export type EditResult = { ok: true; text: string; changed: boolean } | { ok: false; error: string };

function parseExisting(existing: string | null): { ok: true; doc: Json } | { ok: false; error: string } {
  if (existing === null || existing.trim() === "") return { ok: true, doc: {} };
  let doc: unknown;
  try {
    doc = JSON.parse(existing);
  } catch (err) {
    return { ok: false, error: `the file is not valid JSON (${err instanceof Error ? err.message : String(err)}); nothing was changed` };
  }
  if (!isObj(doc)) return { ok: false, error: "the file is not a JSON object; nothing was changed" };
  if (doc["hooks"] !== undefined && !isObj(doc["hooks"])) return { ok: false, error: '"hooks" in the file is not an object; nothing was changed' };
  return { ok: true, doc };
}

function isOurs(entry: unknown): boolean {
  if (!isObj(entry)) return false;
  for (const k of ["command", "commandWindows"]) if (typeof entry[k] === "string" && entry[k].includes(OURS)) return true;
  const inner = entry["hooks"];
  return Array.isArray(inner) && inner.some((h) => isObj(h) && ["command", "commandWindows"].some((k) => typeof h[k] === "string" && h[k].includes(OURS)));
}

function withoutOurs(list: unknown): unknown[] {
  return Array.isArray(list) ? list.filter((e) => !isOurs(e)) : [];
}

function serialize(doc: Json): string {
  return JSON.stringify(doc, null, 2) + "\n";
}

function cleanedHooks(hooksObj: unknown): Json {
  const hooks: Json = isObj(hooksObj) ? { ...hooksObj } : {};
  for (const k of Object.keys(hooks)) {
    const kept = withoutOurs(hooks[k]);
    if (kept.length === 0) delete hooks[k];
    else hooks[k] = kept;
  }
  return hooks;
}

/** Event names (and where they live) per agent, for building and for "is it installed". */
function eventNames(agent: HookAgent): string[] {
  switch (agent) {
    case "claude-code": return ["PreToolUse", "Stop"];
    case "codex": return ["PreToolUse", "Stop"];
    case "cursor": return ["preToolUse", "beforeShellExecution"];
    case "gemini": return ["BeforeTool"];
    case "antigravity": return ["PreToolUse"];
    default: return [];
  }
}

export function addHookConfig(agent: HookAgent, existing: string | null): EditResult {
  const spec = AGENT_SPECS[agent];
  if (spec.kind === "plugin-file") return { ok: false, error: `${spec.label} uses a plugin file, not a JSON config` };
  const parsed = parseExisting(existing);
  if (!parsed.ok) return parsed;
  const doc = { ...parsed.doc };

  if (spec.kind === "named-group") {
    // Antigravity: top-level keys are named hook groups. Replace only our group; leave the user's groups alone.
    if (doc[GROUP_NAME] !== undefined && !isObj(doc[GROUP_NAME])) return { ok: false, error: `"${GROUP_NAME}" in the file is not an object; nothing was changed` };
    doc[GROUP_NAME] = { enabled: true, PreToolUse: [preEntry(agent)] };
    const text = serialize(doc);
    return { ok: true, text, changed: text !== (existing ?? "") };
  }

  const prior = isObj(parsed.doc["hooks"]) ? parsed.doc["hooks"] : {};
  const hooks = cleanedHooks(prior);

  if (agent === "claude-code" || agent === "codex") {
    hooks["PreToolUse"] = [...withoutOurs(prior["PreToolUse"]), preEntry(agent)];
    // The Stop entry gets a timeout but never onFailure: a backstop that fails must let the agent finish, not trap it in a loop.
    const stopHook: Json = { type: "command", command: stopCommand(agent) };
    if (agent === "claude-code") stopHook["timeout"] = CLAUDE_STOP_TIMEOUT_SECONDS;
    hooks["Stop"] = [...withoutOurs(prior["Stop"]), { hooks: [stopHook] }];
  } else if (agent === "gemini") {
    hooks["BeforeTool"] = [...withoutOurs(prior["BeforeTool"]), preEntry(agent)];
  } else if (agent === "cursor") {
    if (doc["version"] === undefined) doc["version"] = 1;
    const entry = { command: "purix hook cursor pre-tool-use", timeout: 10, failClosed: true };
    hooks["preToolUse"] = [...withoutOurs(prior["preToolUse"]), entry];
    hooks["beforeShellExecution"] = [...withoutOurs(prior["beforeShellExecution"]), entry];
  }
  doc["hooks"] = hooks;
  const text = serialize(doc);
  return { ok: true, text, changed: text !== (existing ?? "") };
}

export function removeHookConfig(existing: string | null): EditResult {
  if (existing === null) return { ok: true, text: "", changed: false };
  const parsed = parseExisting(existing);
  if (!parsed.ok) return parsed;
  const doc = { ...parsed.doc };
  // Antigravity's named group: remove it only if it is ours.
  const group = doc[GROUP_NAME];
  if (isObj(group) && isOurs({ hooks: Array.isArray(group["PreToolUse"]) ? (group["PreToolUse"] as unknown[]).flatMap((e) => (isObj(e) && Array.isArray(e["hooks"]) ? (e["hooks"] as unknown[]) : [])) : [] })) delete doc[GROUP_NAME];
  if (doc["hooks"] !== undefined) {
    const hooks = cleanedHooks(doc["hooks"]);
    if (Object.keys(hooks).length === 0) delete doc["hooks"];
    else doc["hooks"] = hooks;
  }
  const changed = JSON.stringify(JSON.parse(existing)) !== JSON.stringify(doc);
  return { ok: true, text: changed ? serialize(doc) : existing, changed };
}

// ---------- reading an installed entry back (hooks status / doctor) ----------

export interface InstalledPreEntry {
  command: string;
  commandWindows?: string;
  timeout?: number;
  onFailure?: string;
  failClosed?: boolean;
  matcher?: string;
}

/** The pre-tool entry Purix wrote into an agent's JSON config, as it stands now; null when there is none or the file cannot be read. */
export function extractPreToolEntry(agent: HookAgent, existing: string | null): InstalledPreEntry | null {
  const spec = AGENT_SPECS[agent];
  if (existing === null || spec.kind === "plugin-file") return null;
  const parsed = parseExisting(existing);
  if (!parsed.ok) return null;
  const doc = parsed.doc;
  const hooks = isObj(doc["hooks"]) ? doc["hooks"] : {};
  const pick = (list: unknown): { outer: Json; inner: Json } | null => {
    if (!Array.isArray(list)) return null;
    for (const e of list) {
      if (!isObj(e) || !isOurs(e)) continue;
      if (Array.isArray(e["hooks"])) {
        const inner = (e["hooks"] as unknown[]).find((h): h is Json => isObj(h) && ["command", "commandWindows"].some((k) => typeof h[k] === "string" && h[k].includes(OURS)));
        if (inner) return { outer: e, inner };
      } else return { outer: e, inner: e };
    }
    return null;
  };
  const g = doc[GROUP_NAME];
  const found =
    spec.kind === "named-group" ? (isObj(g) ? pick(g["PreToolUse"]) : null) : agent === "gemini" ? pick(hooks["BeforeTool"]) : agent === "cursor" ? pick(hooks["preToolUse"]) : pick(hooks["PreToolUse"]);
  if (!found || typeof found.inner["command"] !== "string") return null;
  const out: InstalledPreEntry = { command: found.inner["command"] };
  if (typeof found.inner["commandWindows"] === "string") out.commandWindows = found.inner["commandWindows"];
  if (typeof found.inner["timeout"] === "number") out.timeout = found.inner["timeout"];
  if (typeof found.inner["onFailure"] === "string") out.onFailure = found.inner["onFailure"];
  if (typeof found.inner["failClosed"] === "boolean") out.failClosed = found.inner["failClosed"];
  if (typeof found.outer["matcher"] === "string") out.matcher = found.outer["matcher"];
  return out;
}

/**
 * Settings an installed entry should have and does not: what lets a timeout or a failure to start pass a call through. Empty for a
 * fresh install of every agent. An older install is repaired by running `purix hooks install <agent>` again (one copy is kept).
 */
export function hookStrengthFindings(agent: HookAgent, existing: string | null): string[] {
  const e = extractPreToolEntry(agent, existing);
  if (e === null) return [];
  const fix = `run \`purix hooks install ${agent}\` to upgrade it`;
  const out: string[] = [];
  if (agent === "claude-code") {
    if (e.onFailure !== "block") out.push(`no onFailure:"block": on Claude Code a hook that times out or cannot start lets the call through (${fix}; needs Claude Code 2.1.295 or later)`);
    if (typeof e.timeout !== "number") out.push(`no explicit timeout (the default is 600 seconds) (${fix})`);
  } else if (agent === "cursor") {
    if (e.failClosed !== true) out.push(`no failClosed: a hook that fails to run lets the call through on Cursor (${fix})`);
  } else if (typeof e.timeout !== "number") {
    out.push(`no explicit timeout (${fix})`);
  }
  return out;
}

export type HookInstallState = "installed" | "partial" | "not-installed" | "unreadable";

export function hookInstallState(agent: HookAgent, existing: string | null): HookInstallState {
  const spec = AGENT_SPECS[agent];
  if (existing === null) return "not-installed";
  if (spec.kind === "plugin-file") return existing.startsWith(PLUGIN_MARKER) ? "installed" : "unreadable";
  const parsed = parseExisting(existing);
  if (!parsed.ok) return "unreadable";
  if (spec.kind === "named-group") {
    const g = parsed.doc[GROUP_NAME];
    return isObj(g) && Array.isArray(g["PreToolUse"]) && (g["PreToolUse"] as unknown[]).some(isOurs) ? "installed" : "not-installed";
  }
  const hooks = isObj(parsed.doc["hooks"]) ? parsed.doc["hooks"] : {};
  const need = eventNames(agent);
  const have = need.filter((k) => Array.isArray(hooks[k]) && (hooks[k] as unknown[]).some(isOurs));
  return have.length === need.length ? "installed" : have.length === 0 ? "not-installed" : "partial";
}

// ---------- OpenCode plugin ----------

/**
 * The whole OpenCode plugin. It decides nothing: it hands the call to the same engine every other agent uses and throws
 * (which blocks the tool in OpenCode and shows the message to the model) when the engine blocks or cannot run.
 */
export function openCodePluginSource(): string {
  return `${PLUGIN_MARKER}
import { spawnSync } from "node:child_process";

export const PurixGuard = async ({ directory }: { directory?: string }) => ({
  "tool.execute.before": async (input: { tool: string }, output: { args?: unknown }) => {
    const payload = JSON.stringify({ tool_name: input.tool, tool_input: output.args ?? {}, cwd: directory ?? process.cwd() });
    const r = spawnSync("purix", ["hook", "opencode", "pre-tool-use"], {
      input: payload,
      encoding: "utf-8",
      timeout: 10000,
      shell: process.platform === "win32", // lets Windows find purix.cmd
    });
    if (r.error || r.status !== 0) {
      throw new Error((r.stderr || "").trim() || "Purix hook did not run (is purix installed and on PATH?). Blocking to be safe.");
    }
  },
});
`;
}

// ---------- files ----------

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

export function installHooks(agent: HookAgent, scope: HookScope, root: string, home: string = homedir()): { path: string; result: EditResult } {
  const path = hookConfigPath(agent, scope, root, home);
  const existing = readIfExists(path);
  if (AGENT_SPECS[agent].kind === "plugin-file") {
    if (existing !== null && !existing.startsWith(PLUGIN_MARKER)) {
      return { path, result: { ok: false, error: "a file with this name exists and was not written by Purix; nothing was changed" } };
    }
    const text = openCodePluginSource();
    const changed = existing !== text;
    if (changed) writeFileAtomic(path, text);
    return { path, result: { ok: true, text, changed } };
  }
  const result = addHookConfig(agent, existing);
  if (result.ok && result.changed) writeFileAtomic(path, result.text);
  return { path, result };
}

export function uninstallHooks(agent: HookAgent, scope: HookScope, root: string, home: string = homedir()): { path: string; result: EditResult } {
  const path = hookConfigPath(agent, scope, root, home);
  const existing = readIfExists(path);
  if (AGENT_SPECS[agent].kind === "plugin-file") {
    if (existing === null) return { path, result: { ok: true, text: "", changed: false } };
    if (!existing.startsWith(PLUGIN_MARKER)) return { path, result: { ok: false, error: "this file was not written by Purix; nothing was changed" } };
    unlinkSync(path);
    return { path, result: { ok: true, text: "", changed: true } };
  }
  const result = removeHookConfig(existing);
  if (result.ok && result.changed) writeFileAtomic(path, result.text);
  return { path, result };
}

export function readHookInstallState(agent: HookAgent, scope: HookScope, root: string, home: string = homedir()): { path: string; state: HookInstallState } {
  const path = hookConfigPath(agent, scope, root, home);
  try {
    return { path, state: hookInstallState(agent, readIfExists(path)) };
  } catch {
    return { path, state: "unreadable" };
  }
}

