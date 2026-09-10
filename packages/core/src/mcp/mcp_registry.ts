// src/mcp/mcp_registry.ts
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const REGISTRY_PATH = ".purix/mcp_servers.json";

export interface McpServerRecord {
  name: string;
  url: string;
  added_at: string;
}

interface RegistryState {
  servers: McpServerRecord[];
}

function load(): RegistryState {
  if (!existsSync(REGISTRY_PATH)) return { servers: [] };
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
  } catch {
    return { servers: [] };
  }
}

function save(state: RegistryState): void {
  mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * Section 18's "MCP Gateway" needs somewhere to remember which servers
 * Purix is allowed to talk to. Just a name -> URL registry, same small
 * .purix/*.json pattern as budget.ts/auth.ts. No credentials live here —
 * if a server needs auth, that's the transport's problem (OAuth flow,
 * bearer header), not this file's.
 */
export function addServer(name: string, url: string): void {
  const state = load();
  const idx = state.servers.findIndex((s) => s.name === name);
  const record: McpServerRecord = { name, url, added_at: new Date().toISOString() };
  if (idx >= 0) state.servers[idx] = record;
  else state.servers.push(record);
  save(state);
}

export function removeServer(name: string): boolean {
  const state = load();
  const before = state.servers.length;
  state.servers = state.servers.filter((s) => s.name !== name);
  save(state);
  return state.servers.length < before;
}

export function getServer(name: string): McpServerRecord | null {
  return load().servers.find((s) => s.name === name) ?? null;
}

export function listServers(): McpServerRecord[] {
  return load().servers;
}