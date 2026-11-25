// src/observe/statusline_install.ts
//
// Writes (and removes, and reads back) the `statusLine` entry that makes Claude Code run `purix statusline`. Same rules as the hook
// installer (hooks/install.ts), and for the same reasons:
//  - Nothing already there is overwritten. A status line that is not ours (a person's own script, another tool's) is left exactly as
//    it is and the install says so; it is never replaced, because a status line is something people build by hand.
//  - Every other setting in the file stays as it was, in its order.
//  - A file that is not valid JSON, or is not an object, is refused with a message; it is never "repaired" by replacing it.
//    Claude Code's settings files are strict JSON (a comment or trailing comma is an error there too), so JSON.parse is the right reader.
//
// What was checked against Anthropic's documentation (code.claude.com, "Customize your status line" and "Settings files and precedence",
// read 2026-11-24): the setting is `statusLine: { type: "command", command, padding?, refreshInterval? }`; it may live in the user file
// (~/.claude/settings.json) or a project file; the project-local file (.claude/settings.local.json) applies over the shared project file;
// the command runs in a shell; the status line stays blank until the folder is trusted; output is shown only if the command exits 0 and
// prints something. NOT checked: a live Claude Code run, and Windows. The docs do not say outright that `statusLine` is honoured in
// the local file (they name "user settings or project settings"), so `purix statusline --install` says where it wrote and `--user` exists.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../platform/atomic_write.js";

/** local: this project, personal, not committed. shared: the committed project file. user: every project on this machine. */
export type StatuslineScope = "local" | "shared" | "user";

export const STATUSLINE_SCOPES: readonly StatuslineScope[] = ["local", "shared", "user"];
export type StatuslineRangeArg = "today" | "7d" | "all";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export type StatuslineEdit = { ok: true; text: string; changed: boolean } | { ok: false; error: string };

export function statuslineConfigPath(scope: StatuslineScope, root: string, home: string = homedir()): string {
  switch (scope) {
    case "local": return join(root, ".claude", "settings.local.json");
    case "shared": return join(root, ".claude", "settings.json");
    case "user": return join(home, ".claude", "settings.json");
  }
}

/** The command written into the setting. `today` is the command's default, so it is left off. */
export function statuslineCommand(range: StatuslineRangeArg = "today"): string {
  return range === "today" ? "purix statusline" : `purix statusline --range ${range}`;
}

/** True when a command runs `purix statusline` (alone or with options), and not some other program that mentions it. */
export function isOurStatuslineCommand(command: unknown): boolean {
  return typeof command === "string" && /^\s*purix(?:\.cmd)?\s+statusline(?:\s|$)/.test(command);
}

export type StatuslineState =
  | { state: "not-installed" }
  | { state: "installed"; command: string }
  | { state: "other"; command: string }
  | { state: "unreadable"; error: string };

function parse(existing: string | null): { ok: true; doc: Json } | { ok: false; error: string } {
  if (existing === null || existing.trim() === "") return { ok: true, doc: {} };
  let doc: unknown;
  try {
    doc = JSON.parse(existing);
  } catch (err) {
    return { ok: false, error: `the file is not valid JSON (${err instanceof Error ? err.message : String(err)}); nothing was changed` };
  }
  if (!isObj(doc)) return { ok: false, error: "the file is not a JSON object; nothing was changed" };
  return { ok: true, doc };
}

export function statuslineState(existing: string | null): StatuslineState {
  const parsed = parse(existing);
  if (!parsed.ok) return { state: "unreadable", error: parsed.error };
  const sl = parsed.doc["statusLine"];
  if (sl === undefined) return { state: "not-installed" };
  const command = isObj(sl) && typeof sl["command"] === "string" ? sl["command"] : JSON.stringify(sl);
  return isObj(sl) && isOurStatuslineCommand(sl["command"]) ? { state: "installed", command } : { state: "other", command };
}

const serialize = (doc: Json) => JSON.stringify(doc, null, 2) + "\n";

/** Adds our status line. Refuses (changes nothing) when a status line that is not ours is already there. */
export function addStatusline(existing: string | null, range: StatuslineRangeArg = "today"): StatuslineEdit {
  const parsed = parse(existing);
  if (!parsed.ok) return parsed;
  const doc = parsed.doc;
  const current = doc["statusLine"];
  const command = statuslineCommand(range);
  if (current !== undefined) {
    if (!(isObj(current) && isOurStatuslineCommand(current["command"]))) {
      const what = isObj(current) && typeof current["command"] === "string" ? `"${current["command"]}"` : "one that is not a command";
      return { ok: false, error: `a status line is already set (${what}) and was not written by Purix; it was left as it is. Remove it first, or run the command from your own script` };
    }
    if (current["type"] === "command" && current["command"] === command) return { ok: true, text: existing ?? serialize(doc), changed: false };
    doc["statusLine"] = { ...current, type: "command", command }; // ours: update in place, keep padding and the like
    return { ok: true, text: serialize(doc), changed: true };
  }
  doc["statusLine"] = { type: "command", command };
  return { ok: true, text: serialize(doc), changed: true };
}

/** Removes our status line, and only ours. */
export function removeStatusline(existing: string | null): StatuslineEdit {
  const parsed = parse(existing);
  if (!parsed.ok) return parsed;
  const doc = parsed.doc;
  const current = doc["statusLine"];
  if (current === undefined) return { ok: true, text: existing ?? "", changed: false };
  if (!(isObj(current) && isOurStatuslineCommand(current["command"]))) return { ok: false, error: "the status line in this file was not written by Purix; it was left as it is" };
  delete doc["statusLine"];
  return { ok: true, text: serialize(doc), changed: true };
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

export function installStatusline(scope: StatuslineScope, root: string, range: StatuslineRangeArg = "today", home: string = homedir()): { path: string; created: boolean; result: StatuslineEdit } {
  const path = statuslineConfigPath(scope, root, home);
  const existing = readIfExists(path);
  const result = addStatusline(existing, range);
  if (result.ok && result.changed) writeFileAtomic(path, result.text);
  return { path, created: existing === null && result.ok && result.changed, result };
}

export function uninstallStatusline(scope: StatuslineScope, root: string, home: string = homedir()): { path: string; result: StatuslineEdit } {
  const path = statuslineConfigPath(scope, root, home);
  const existing = readIfExists(path);
  if (existing === null) return { path, result: { ok: true, text: "", changed: false } };
  const result = removeStatusline(existing);
  if (result.ok && result.changed) writeFileAtomic(path, result.text);
  return { path, result };
}

export function readStatuslineState(scope: StatuslineScope, root: string, home: string = homedir()): { path: string; state: StatuslineState } {
  const path = statuslineConfigPath(scope, root, home);
  try {
    return { path, state: statuslineState(readIfExists(path)) };
  } catch {
    return { path, state: { state: "unreadable", error: "the file could not be read" } };
  }
}
