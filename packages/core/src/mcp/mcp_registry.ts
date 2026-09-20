// src/mcp/mcp_registry.ts
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface McpServerRecord {
  name: string;
  url: string;
  added_at: string;
}

interface RegistryState {
  servers: McpServerRecord[];
}

// BUG FIX (GAPS-REPORT-2 §7): every other project-local state file in
// this codebase (config.ts, auth.ts's own module-relative equivalent
// aside — see its own note) resolves its path against an explicit
// baseDir, not an implicit, hardcoded-relative ".purix/..." string
// resolved against whatever process.cwd() happens to be at call time.
// A hardcoded relative path here meant this module could never be
// pointed at a specific project directory (tests couldn't isolate it
// from the real repo's own .purix/, and a caller running from a
// subdirectory of the project — or a differently-rooted context like an
// MCP server session — would silently read/write the wrong file, or
// worse, create a stray .purix/mcp_servers.json wherever it happened to
// be invoked from). Every function below now takes an optional baseDir,
// defaulting to process.cwd() to preserve today's exact behavior for
// existing callers that don't pass one.
function registryPath(baseDir: string): string {
  return join(baseDir, ".purix", "mcp_servers.json");
}

function load(baseDir: string): RegistryState {
  const p = registryPath(baseDir);
  if (!existsSync(p)) return { servers: [] };
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return { servers: [] };
  }
}

function save(baseDir: string, state: RegistryState): void {
  const p = registryPath(baseDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * Section 18's "MCP Gateway" needs somewhere to remember which servers
 * Purix is allowed to talk to. Just a name -> URL registry, same small
 * .purix/*.json pattern as budget.ts/auth.ts. No credentials live here —
 * if a server needs auth, that's the transport's problem (OAuth flow,
 * bearer header), not this file's.
 */
export function addServer(name: string, url: string, baseDir: string = process.cwd()): void {
  const state = load(baseDir);
  const idx = state.servers.findIndex((s) => s.name === name);
  const record: McpServerRecord = { name, url, added_at: new Date().toISOString() };
  if (idx >= 0) state.servers[idx] = record;
  else state.servers.push(record);
  save(baseDir, state);
}

export function removeServer(name: string, baseDir: string = process.cwd()): boolean {
  const state = load(baseDir);
  const before = state.servers.length;
  state.servers = state.servers.filter((s) => s.name !== name);
  save(baseDir, state);
  return state.servers.length < before;
}

export function getServer(name: string, baseDir: string = process.cwd()): McpServerRecord | null {
  return load(baseDir).servers.find((s) => s.name === name) ?? null;
}

export function listServers(baseDir: string = process.cwd()): McpServerRecord[] {
  return load(baseDir).servers;
}