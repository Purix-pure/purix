// packages/core/src/observe/registry.ts
//
// The list of projects Purix has worked in on this machine. Per-project state lives in each project's git folder and nothing
// tied them together, so a "all my projects" screen had nothing to read. This is that list: a small file in the user folder
// (`projects.json`), updated whenever a Purix command or the MCP server runs in a project.
//
// What an entry holds: the project folder, where its state database is, a name (the folder's name), the first and last time Purix
// ran there, and the agent ids seen. No file names, no prompts, no counts. The numbers stay in each project's own database, which
// the dashboard opens read-only.
//
// Failure rule: this is a side channel. A read-only home folder or a damaged file means "not recorded this time". It never throws
// into the command that called it, and it never blocks one.
import { existsSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { readJsonFile, quarantineCorruptFile, writeJsonAtomic } from "../platform/atomic_write.js";
import { findProjectRoot } from "../platform/project_root.js";
import { userDir } from "../platform/user_dir.js";
import { resolveSharedStateDir } from "../state/git_common_dir.js";

export const REGISTRY_FILE = "projects.json";
/** A project already listed is rewritten at most this often, so a command run in a loop does not rewrite the file every time. */
export const TOUCH_INTERVAL_MS = 60_000;
const MAX_AGENTS = 12;
const MAX_PROJECTS = 500;

export interface ProjectEntry {
  /** The project folder (its Purix or git root). */
  path: string;
  /** The folder that holds this project's state database (manifest.db). */
  stateDir: string;
  /** The folder's name, for display. */
  name: string;
  firstSeen: string;
  lastSeen: string;
  /** Agent ids seen in this project (PURIX_MCP_AGENT_ID values and "cli"). */
  agents: string[];
}

export interface RegistryFile {
  schema: 1;
  projects: ProjectEntry[];
}

export function registryPath(dir: string = userDir()): string {
  return join(dir, REGISTRY_FILE);
}

function canonical(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

function isEntry(x: unknown): x is ProjectEntry {
  if (!x || typeof x !== "object") return false;
  const e = x as Record<string, unknown>;
  return typeof e["path"] === "string" && typeof e["stateDir"] === "string" && typeof e["name"] === "string" &&
    typeof e["firstSeen"] === "string" && typeof e["lastSeen"] === "string" && Array.isArray(e["agents"]);
}

/** Reads the list. A missing, damaged or future-version file reads as empty (a damaged one is kept as `.corrupt`). Never throws. */
export function readRegistry(dir: string = userDir()): RegistryFile {
  const path = registryPath(dir);
  const read = readJsonFile<RegistryFile>(path);
  if (read.kind === "missing") return { schema: 1, projects: [] };
  if (read.kind === "corrupt") {
    quarantineCorruptFile(path);
    return { schema: 1, projects: [] };
  }
  const v = read.value;
  if (!v || typeof v !== "object" || v.schema !== 1 || !Array.isArray(v.projects)) return { schema: 1, projects: [] };
  return { schema: 1, projects: v.projects.filter(isEntry).map((p) => ({ ...p, agents: p.agents.filter((a): a is string => typeof a === "string") })) };
}

export interface TouchOptions {
  /** The folder the command ran in. Default: the current folder. */
  cwd?: string;
  /** Who ran it: an agent id or "cli". */
  agent?: string;
  now?: Date;
  /** The user folder. Default: userDir(). */
  dir?: string;
}

/**
 * Records that Purix ran in this project. Returns true when the file was written. Does nothing outside a project (no Purix or git
 * marker above the folder), so running Purix in a scratch folder never lists it, and does nothing when the project is listed
 * already and was seen less than TOUCH_INTERVAL_MS ago with the same agent.
 */
export function touchProject(opts: TouchOptions = {}): boolean {
  try {
    const cwd = resolve(opts.cwd ?? process.cwd());
    const found = findProjectRoot(cwd);
    if (!found) return false;
    const root = canonical(found.root);
    const dir = opts.dir ?? userDir();
    const now = opts.now ?? new Date();
    const reg = readRegistry(dir);
    const agent = (opts.agent ?? "cli").slice(0, 64);
    const existing = reg.projects.find((p) => canonical(p.path) === root);
    if (existing) {
      const fresh = now.getTime() - Date.parse(existing.lastSeen) < TOUCH_INTERVAL_MS;
      if (fresh && existing.agents.includes(agent)) return false;
      existing.lastSeen = now.toISOString();
      if (!existing.agents.includes(agent) && existing.agents.length < MAX_AGENTS) existing.agents.push(agent);
      existing.stateDir = resolveSharedStateDir(root);
    } else {
      if (reg.projects.length >= MAX_PROJECTS) {
        reg.projects.sort((a, b) => a.lastSeen.localeCompare(b.lastSeen));
        reg.projects.shift();
      }
      reg.projects.push({ path: root, stateDir: resolveSharedStateDir(root), name: basename(root) || root, firstSeen: now.toISOString(), lastSeen: now.toISOString(), agents: [agent] });
    }
    writeJsonAtomic(registryPath(dir), reg);
    return true;
  } catch {
    return false; // a side channel
  }
}

/** Projects whose folder still exists, newest activity first. Does not rewrite the file. */
export function listProjects(dir: string = userDir()): ProjectEntry[] {
  return readRegistry(dir).projects
    .filter((p) => existsSync(p.path))
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

/** Removes entries whose folder is gone. Returns how many went. Never throws. */
export function pruneRegistry(dir: string = userDir()): number {
  try {
    const reg = readRegistry(dir);
    const kept = reg.projects.filter((p) => existsSync(p.path));
    const removed = reg.projects.length - kept.length;
    if (removed > 0) writeJsonAtomic(registryPath(dir), { schema: 1, projects: kept });
    return removed;
  } catch {
    return 0;
  }
}
