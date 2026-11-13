// src/hooks/run.ts
//
// `purix hook <agent> <event>`: the engine behind the hook adapters. Reads the agent's payload, loads what Purix
// governs (read-only, no integrity scan, so it is fast enough to run before every edit), decides, answers.
//
// Failure policy (this is the point of the file):
//  - pre-tool-use: ANY failure to read the payload, find the project, or load the state is a DENY. An enforcement hook that
//    fails open is not enforcement. "Nothing is governed here" (no store, no lock) is not a failure; it allows.
//  - stop: any failure is an ALLOW. A bug in the backstop must never trap an agent in a loop.
// Core returns data and never prints (rule R1); the CLI prints what this returns.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataDrivenEnv } from "../platform/env.js";
import { PURIX_DIRNAME, storedPosixPath } from "../platform/layout.js";
import { resolveSharedStateDir } from "../state/git_common_dir.js";
import { LOCK_FILENAME, readLock } from "../state/governed_lock.js";
import { CODEBASE_INDEX_COMPONENT_ID } from "../manifest/adopt.js";
import { recordEvent } from "../manifest/events.js";
import { storeExists } from "../manifest/store.js";
import { runCheck } from "../entrypoints/check.js";
import { allowAnswer, denyAnswer, parseHookPayload, type HookAgent, type HookAnswer, type HookEvent, type NormalizedCall } from "./protocol.js";
import { decideHook, type GovernedContext } from "./decide.js";

/** Hook configuration files an agent must never be able to edit (project-relative). */
export const PROTECTED_PROJECT_FILES = [
  LOCK_FILENAME,
  ".claude/settings.json", ".claude/settings.local.json", // Claude Code
  ".cursor/hooks.json", // Cursor
  ".codex/hooks.json", ".codex/config.toml", // Codex
  ".gemini/settings.json", // Gemini CLI
  ".agents/hooks.json", // Antigravity (workspace)
  ".opencode/plugins/purix-guard.ts", "opencode.json", // OpenCode
  // A9-1 (research 09): files that start programs or steer the agent without going through a tool call it makes.
  ".mcp.json", // MCP servers the agent will start
  ".vscode/settings.json", // terminal profiles and task auto-run
] as const;

/** Project folders no agent tool may write into (project-relative). Steering and hooks that run code. */
export const PROTECTED_PROJECT_DIRS = [".git/hooks", ".claude/skills", ".claude/commands", ".agents/skills"] as const;
/** Files in the person's home folder that run in every shell they open. */
const HOME_SHELL_FILES = [".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".zshenv", ".profile", join(".config", "fish", "config.fish")] as const;

function cleanRel(p: string): string {
  return storedPosixPath(p).replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Nearest folder at or above `start` that holds a Purix or git marker; null when none does. */
export function findProjectRoot(start: string): string | null {
  let dir = resolve(start);
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, ".git")) || existsSync(join(dir, LOCK_FILENAME)) || existsSync(join(dir, PURIX_DIRNAME))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Where the project is. Claude Code and Gemini CLI export a project directory variable; Cursor and Antigravity send
 * workspace roots; Codex and OpenCode send only a working directory, which may be a subfolder, so walk up from it to the
 * folder holding .git, the lock or the Purix state. Falls back to the directory itself.
 */
export function resolveProjectRoot(call: NormalizedCall, fallbackCwd: string = process.cwd()): string {
  const fromEnv = dataDrivenEnv("CLAUDE_PROJECT_DIR") || dataDrivenEnv("GEMINI_PROJECT_DIR");
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  if (call.roots[0]) return resolve(call.roots[0]);
  const start = resolve(call.cwd || fallbackCwd);
  return findProjectRoot(start) ?? start;
}

interface ManifestRead {
  state: "ok" | "absent" | "damaged";
  governed: Map<string, string>;
}

/** Reads component ids and file lists only. No integrity scan (purix check does that), no writes, no migration. */
function readGovernedFromStore(root: string): ManifestRead {
  const dbPath = join(resolveSharedStateDir(root), "manifest.db");
  const governed = new Map<string, string>();
  if (!existsSync(dbPath)) return { state: "absent", governed };
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    let rows: { data: string }[] = [];
    try {
      rows = db.prepare("SELECT data FROM manifest").all() as { data: string }[];
    } catch (err) {
      // A store that never got its manifest table governs nothing yet; any other error means the state is unreadable.
      if (!(err instanceof Error && /no such table/i.test(err.message))) throw err;
    }
    for (const row of rows) {
      const entry = JSON.parse(row.data) as { component_id?: string; component_type?: string; files?: unknown };
      if (!entry.component_id || entry.component_type === "codebase_index" || entry.component_id === CODEBASE_INDEX_COMPONENT_ID) continue;
      if (Array.isArray(entry.files)) for (const f of entry.files) if (typeof f === "string" && f) governed.set(cleanRel(f), entry.component_id);
    }
    return { state: "ok", governed };
  } catch {
    return { state: "damaged", governed };
  } finally {
    try { db?.close(); } catch { /* best-effort */ }
  }
}

export function loadGovernedContext(root: string): GovernedContext {
  const store = readGovernedFromStore(root);
  const governed = store.governed;
  let lockUsed = false;
  const lock = readLock(root);
  if (lock.state === "ok") {
    for (const c of lock.lock.components) {
      for (const f of c.files) {
        const rel = cleanRel(f.path);
        if (!governed.has(rel)) governed.set(rel, c.component_id);
      }
    }
    lockUsed = store.state !== "ok";
  } else if (lock.state === "damaged" && store.state === "absent") {
    // A lock that cannot be read in a project with no store: we cannot say nothing is governed.
    return buildContext(root, governed, "damaged", false);
  }
  const state = store.state === "absent" && lock.state === "ok" ? "ok" : store.state;
  return buildContext(root, governed, state, lockUsed);
}

function buildContext(root: string, governed: Map<string, string>, state: GovernedContext["state"], lockUsed: boolean): GovernedContext {
  const home = homedir();
  return {
    projectRoot: root,
    governed,
    protectedFiles: new Set(PROTECTED_PROJECT_FILES),
    protectedAbsolute: [
      join(root, PURIX_DIRNAME),
      resolveSharedStateDir(root),
      join(home, ".claude", "settings.json"),
      join(home, ".claude", "settings.local.json"),
      join(home, ".cursor", "hooks.json"),
      join(home, ".codex", "hooks.json"),
      join(home, ".codex", "config.toml"),
      join(home, ".gemini", "settings.json"),
      join(home, ".gemini", "config", "hooks.json"), // Antigravity (global)
      join(home, ".config", "opencode", "plugins"),
      join(home, ".claude", "skills"),
      ...PROTECTED_PROJECT_DIRS.map((d) => join(root, d)),
      ...HOME_SHELL_FILES.map((f) => join(home, f)),
    ],
    state,
    lockUsed,
    caseInsensitive: process.platform === "win32" || process.platform === "darwin",
  };
}

/** Records that a call was stopped. Only when a store already exists (a hook never creates one). Never throws. */
function recordDenied(agent: HookAgent, call: NormalizedCall | null, rule: string, targets: string[]): void {
  try {
    if (!storeExists()) return;
    recordEvent("hook_denied", { operation: call?.tool ?? null, detail: { agent, rule, targets: targets.slice(0, 20) } });
  } catch {
    /* the denial already happened; the record is a side channel */
  }
}

/** C5: records that a write to files Purix does not govern was allowed. Only when a store already exists. Never throws. */
function recordUnadopted(agent: HookAgent, call: NormalizedCall, files: string[]): void {
  try {
    if (!storeExists()) return;
    recordEvent("unadopted_write", { operation: call.tool, detail: { agent, files: files.slice(0, 20) } });
  } catch {
    /* the write was already allowed; the record is a side channel */
  }
}

function unadoptedNote(files: string[]): string {
  const shown = files.slice(0, 5).join(", ");
  const more = files.length > 5 ? ` and ${files.length - 5} more` : "";
  return `Purix: ${shown}${more} ${files.length === 1 ? "is" : "are"} not governed by Purix, so this write was allowed but not checked. \`purix check\` lists it until it is adopted (\`purix adopt\`).`;
}

function failClosed(agent: HookAgent, why: string): HookAnswer {
  return denyAnswer(agent, `the Purix hook could not complete its check (${why}), so it is blocking this to be safe. Run \`purix check\` and tell the person.`);
}

function runStop(agent: HookAgent, call: NormalizedCall, root: string): HookAnswer {
  // Claude Code sets stop_hook_active when it is already continuing because of a Stop hook. Answering again would loop.
  if (call.stopHookActive) return allowAnswer(agent);
  try {
    const report = runCheck({ baseDir: root, strict: false });
    const bad = report.sections.filter((s) => (s.id === "drift" || s.id === "lock") && (s.outcome === "fail" || s.outcome === "error"));
    if (bad.length === 0) return allowAnswer(agent);
    const lines = bad.flatMap((s) => s.items.filter((i) => i.outcome === "fail" || i.outcome === "error").map((i) => `${i.subject}: ${i.message}`)).slice(0, 10);
    recordDenied(agent, call, "drift-at-stop", lines.map((l) => l.split(":")[0] ?? l));
    return {
      exitCode: 2,
      stdout: "",
      stderr:
        "Purix found governed files that changed outside Purix during this session:\n" +
        lines.map((l) => `  - ${l}`).join("\n") +
        "\nDo not accept or hide this yourself. Tell the person which files changed and that `purix check` shows the details; they can revert the edit or accept it with Purix.",
    };
  } catch (err) {
    return stopCheckErrorAnswer(agent, err);
  }
}

/**
 * The Stop check threw. The answer stays "allow": a block here cannot be told apart from drift by the agent, would hold a finished
 * session open, and every edit was already guarded earlier at PreToolUse (which fails closed). What changes is that it is no longer
 * silent: stderr says the check did not finish and what to run. No stack or path goes to the agent. (Handoff item 2, 2026-11-07.)
 */
export function stopCheckErrorAnswer(agent: HookAgent, _err: unknown): HookAnswer {
  const base = allowAnswer(agent);
  return { ...base, stderr: "Purix's end-of-session check did not finish, so changes made outside Purix this session were not looked for. Run `purix check` to see the current state." };
}

export function runHook(agent: HookAgent, event: HookEvent, rawPayload: string, fallbackCwd: string = process.cwd()): HookAnswer {
  const parsed = parseHookPayload(agent, event, rawPayload);
  if (!parsed.ok) return event === "stop" ? allowAnswer(agent) : failClosed(agent, parsed.reason);
  const call = parsed.call;

  const root = resolveProjectRoot(call, fallbackCwd);
  try {
    // The Purix store, the lock and recordEvent all resolve from the current directory, so work from the project root.
    process.chdir(root);
  } catch (err) {
    return event === "stop" ? allowAnswer(agent) : failClosed(agent, `the project folder ${root} cannot be entered: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (event === "stop") return runStop(agent, call, root);

  try {
    // Quick exit: not a write and not a shell command, nothing to look at, so skip loading any state.
    if (call.toolClass === "other") return allowAnswer(agent);
    const ctx = loadGovernedContext(root);
    const cwd = call.cwd ? resolve(root, call.cwd) : root;
    const decision = decideHook(call, ctx, cwd);
    if (decision.action === "allow") {
      const named = decision.unadopted;
      if (named === undefined || named.length === 0) return allowAnswer(agent);
      recordUnadopted(agent, call, named);
      // Still "no objection" (exit 0, stdout unchanged, so nothing here can act as a grant); stderr only says what was not governed.
      return { ...allowAnswer(agent), stderr: unadoptedNote(named) };
    }
    recordDenied(agent, call, decision.rule, decision.targets);
    return denyAnswer(agent, decision.reason);
  } catch (err) {
    return failClosed(agent, err instanceof Error ? err.message : String(err));
  }
}
