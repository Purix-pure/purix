// src/observe/opencode_panel.ts
//
// Writes (and removes, and reads back) the OpenCode sidebar panel: one plugin file next to a `tui.json` entry that loads it. Same rules as
// the Claude Code status line installer (statusline_install.ts) and the hook installer:
//  - Nothing that is not ours is overwritten or removed. A file named purix-panel.tsx that Purix did not write is left alone and the
//    install says so. Other entries in the `plugin` list stay as they were, in their order.
//  - Every other setting in tui.json stays as it was. A tui.json that is not strict JSON (OpenCode also accepts comments) is refused with
//    a message, never "repaired" by replacing it.
//
// What was checked: the plugin type declarations of @opencode-ai/plugin 1.19.6, and that the panel source type-checks against them
// (opencode_panel_source.ts). That the config file is `tui.json`, lives in `~/.config/opencode/` or in a project's `.opencode/`, and has a
// `plugin` array that accepts an absolute path or a file URL, comes from a published third-party plugin reference (re-read 2026-11-25) and
// a plugin's README; OpenCode's own page for it was not found.
// NOT checked: a live OpenCode session, Windows, and whether a `file://` entry is the form your OpenCode version wants. `purix panel --status`
// shows what was written so a person can compare it with their version's documentation.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { writeFileAtomic } from "../platform/atomic_write.js";
import { safeRmSync } from "../platform/fs_retry.js";
import { PANEL_FILE_NAME, PANEL_MARKER, PANEL_SOURCE } from "./opencode_panel_source.js";

/** project: this folder's `.opencode/`. user: `~/.config/opencode/`, so every project gets it. */
export type PanelScope = "project" | "user";
export const PANEL_SCOPES: readonly PanelScope[] = ["project", "user"];

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export function panelDir(scope: PanelScope, root: string, home: string = homedir()): string {
  return scope === "project" ? join(root, ".opencode") : join(home, ".config", "opencode");
}
export const panelFilePath = (scope: PanelScope, root: string, home?: string) => join(panelDir(scope, root, home), PANEL_FILE_NAME);
export const panelConfigPath = (scope: PanelScope, root: string, home?: string) => join(panelDir(scope, root, home), "tui.json");

/** The entry written into `plugin`: an absolute file URL, so it does not depend on which folder OpenCode was started in. */
export function panelEntry(filePath: string): string {
  return pathToFileURL(filePath).href;
}

/** True when an entry in the plugin list points at a file called purix-panel.tsx (a string, or a [spec, options] pair). */
export function isOurPanelEntry(entry: unknown): boolean {
  const spec = Array.isArray(entry) ? entry[0] : entry;
  if (typeof spec !== "string") return false;
  const tail = spec.split(/[\\/]/).pop() ?? "";
  return tail === PANEL_FILE_NAME;
}

export type PanelEdit = { ok: true; text: string; changed: boolean } | { ok: false; error: string };

function parse(existing: string | null): { ok: true; doc: Json } | { ok: false; error: string } {
  if (existing === null || existing.trim() === "") return { ok: true, doc: {} };
  let doc: unknown;
  try { doc = JSON.parse(existing); } catch (err) {
    return { ok: false, error: `${"tui.json"} is not strict JSON (${err instanceof Error ? err.message : String(err)}), for example it may contain comments; nothing was changed. Add the plugin entry by hand` };
  }
  if (!isObj(doc)) return { ok: false, error: "tui.json is not a JSON object; nothing was changed" };
  return { ok: true, doc };
}

const serialize = (doc: Json) => JSON.stringify(doc, null, 2) + "\n";

/** Adds our entry to the `plugin` list. Leaves everything else exactly as it was. */
export function addPanelEntry(existing: string | null, entry: string): PanelEdit {
  const parsed = parse(existing);
  if (!parsed.ok) return parsed;
  const doc = parsed.doc;
  const current = doc["plugin"];
  if (current !== undefined && !Array.isArray(current)) return { ok: false, error: "tui.json has a `plugin` setting that is not a list; nothing was changed" };
  const list = (current ?? []) as unknown[];
  const at = list.findIndex(isOurPanelEntry);
  if (at >= 0) {
    if (list[at] === entry) return { ok: true, text: existing ?? serialize(doc), changed: false };
    const next = [...list]; next[at] = Array.isArray(list[at]) ? [entry, ...(list[at] as unknown[]).slice(1)] : entry; // ours, moved: keep any options
    doc["plugin"] = next;
    return { ok: true, text: serialize(doc), changed: true };
  }
  doc["plugin"] = [...list, entry];
  return { ok: true, text: serialize(doc), changed: true };
}

export function removePanelEntry(existing: string | null): PanelEdit {
  const parsed = parse(existing);
  if (!parsed.ok) return parsed;
  const doc = parsed.doc;
  const current = doc["plugin"];
  if (current === undefined) return { ok: true, text: existing ?? "", changed: false };
  if (!Array.isArray(current)) return { ok: false, error: "tui.json has a `plugin` setting that is not a list; nothing was changed" };
  const next = current.filter((e) => !isOurPanelEntry(e));
  if (next.length === current.length) return { ok: true, text: existing ?? "", changed: false };
  if (next.length === 0) delete doc["plugin"]; else doc["plugin"] = next;
  return { ok: true, text: serialize(doc), changed: true };
}

/** Windows paths differ by drive-letter case and are not case-sensitive; elsewhere an exact match is required. */
export function samePath(a: string, b: string, win: boolean = process.platform === "win32"): boolean {
  return win ? a.toLowerCase() === b.toLowerCase() : a === b;
}

const readIfExists = (path: string): string | null => (existsSync(path) ? readFileSync(path, "utf-8") : null);
const isOurFile = (text: string): boolean => text.includes(PANEL_MARKER);

export type PanelInstall =
  | { ok: true; filePath: string; configPath: string; fileChanged: boolean; configChanged: boolean }
  | { ok: false; error: string; filePath: string; configPath: string };

/** Writes the plugin file and the config entry. Checks both before writing either, so a refusal changes nothing. */
export function installPanel(scope: PanelScope, root: string, home: string = homedir()): PanelInstall {
  const filePath = panelFilePath(scope, root, home);
  const configPath = panelConfigPath(scope, root, home);
  const existingFile = readIfExists(filePath);
  if (existingFile !== null && !isOurFile(existingFile)) return { ok: false, filePath, configPath, error: `${filePath} already exists and was not written by Purix; it was left as it is` };
  const edit = addPanelEntry(readIfExists(configPath), panelEntry(filePath));
  if (!edit.ok) return { ok: false, filePath, configPath, error: edit.error };
  const fileChanged = existingFile !== PANEL_SOURCE;
  if (fileChanged) writeFileAtomic(filePath, PANEL_SOURCE);
  if (edit.changed) writeFileAtomic(configPath, edit.text);
  return { ok: true, filePath, configPath, fileChanged, configChanged: edit.changed };
}

export type PanelUninstall = { ok: true; fileRemoved: boolean; configChanged: boolean; filePath: string; configPath: string } | { ok: false; error: string; filePath: string; configPath: string };

export function uninstallPanel(scope: PanelScope, root: string, home: string = homedir()): PanelUninstall {
  const filePath = panelFilePath(scope, root, home);
  const configPath = panelConfigPath(scope, root, home);
  const existingConfig = readIfExists(configPath);
  const edit = existingConfig === null ? ({ ok: true, text: "", changed: false } as PanelEdit) : removePanelEntry(existingConfig);
  if (!edit.ok) return { ok: false, filePath, configPath, error: edit.error };
  const existingFile = readIfExists(filePath);
  const ours = existingFile !== null && isOurFile(existingFile);
  if (edit.changed) writeFileAtomic(configPath, edit.text);
  if (ours) safeRmSync(filePath);
  return { ok: true, filePath, configPath, fileRemoved: ours, configChanged: edit.changed };
}

export type PanelState =
  | { state: "not-installed" }
  | { state: "installed"; entry: string; fileCurrent: boolean }
  | { state: "partial"; problem: string }
  | { state: "other-file"; filePath: string }
  | { state: "unreadable"; error: string };

export function readPanelState(scope: PanelScope, root: string, home: string = homedir()): { filePath: string; configPath: string; state: PanelState } {
  const filePath = panelFilePath(scope, root, home);
  const configPath = panelConfigPath(scope, root, home);
  try {
    const file = readIfExists(filePath);
    const config = readIfExists(configPath);
    if (file !== null && !isOurFile(file)) return { filePath, configPath, state: { state: "other-file", filePath } };
    const parsed = parse(config);
    if (!parsed.ok) return { filePath, configPath, state: { state: "unreadable", error: parsed.error } };
    const list = Array.isArray(parsed.doc["plugin"]) ? (parsed.doc["plugin"] as unknown[]) : [];
    const found = list.find(isOurPanelEntry);
    const entry = Array.isArray(found) ? String(found[0]) : (found as string | undefined);
    if (entry === undefined && file === null) return { filePath, configPath, state: { state: "not-installed" } };
    if (entry === undefined) return { filePath, configPath, state: { state: "partial", problem: "the plugin file is there but tui.json does not load it" } };
    if (file === null) return { filePath, configPath, state: { state: "partial", problem: "tui.json loads a plugin file that is missing" } };
    // A moved project would leave an entry pointing at the old place: say so.
    let pointsHere = true;
    try { pointsHere = entry.startsWith("file:") ? samePath(fileURLToPath(entry), filePath) : true; } catch { pointsHere = false; }
    if (!pointsHere) return { filePath, configPath, state: { state: "partial", problem: "tui.json loads a purix-panel.tsx from a different place" } };
    return { filePath, configPath, state: { state: "installed", entry, fileCurrent: file === PANEL_SOURCE } };
  } catch {
    return { filePath, configPath, state: { state: "unreadable", error: "the files could not be read" } };
  }
}
