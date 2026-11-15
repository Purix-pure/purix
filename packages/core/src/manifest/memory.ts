// src/manifest/memory.ts
import { existsSync, appendFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { scrubFreeText } from "../security/secrets.js";
import { PURIX_DIRNAME } from "../platform/layout.js";
import { readManifest } from "./store.js";
import { recordEvent } from "./events.js";
import { sanitizeRepairText } from "../llm/input_scan.js";

const MEMORY_LOG_PATH = join(PURIX_DIRNAME, "memory", "log.jsonl");

/** Sentinel component_id for repo-wide conventions/decisions not tied to one component. */
export const GLOBAL_SCOPE = "*";

export interface MemoryEntry {
  timestamp: string;
  component_id: string;
  kind: string;
  summary: string;
  detail?: string;
}

/**
 * Append-only. Written by the escalation path (Section 5a promotions)
 * AND now by a human directly via "purix remember" — Section 13 says
 * "past design decisions," and not every decision comes out of an
 * escalation.
 */
export function recordMemory(entry: Omit<MemoryEntry, "timestamp">): { scrubbedCount: number } {
  // The log sits in the working tree (Team-tier shared memory is built on it,
  // ADR-036) and its notes are placed into LLM prompts, so a secret typed into
  // a note would be committed and later sent to a provider. Scrub before the
  // write, with the same secret definition ADR-003 uses for LLM-bound text
  // (beta test report 2026-09-30, problem 2).
  const summary = scrubFreeText(entry.summary);
  const detail = entry.detail === undefined ? undefined : scrubFreeText(entry.detail);
  mkdirSync(dirname(MEMORY_LOG_PATH), { recursive: true });
  const full: MemoryEntry = {
    ...entry,
    summary: summary.text,
    ...(detail ? { detail: detail.text } : {}),
    timestamp: new Date().toISOString(),
  };
  appendFileSync(MEMORY_LOG_PATH, JSON.stringify(full) + "\n", "utf-8");
  return { scrubbedCount: summary.scrubbedCount + (detail?.scrubbedCount ?? 0) };
}

function readAllEntries(): MemoryEntry[] {
  if (!existsSync(MEMORY_LOG_PATH)) return [];
  const lines = readFileSync(MEMORY_LOG_PATH, "utf-8").split("\n").filter(Boolean);
  return lines
    .map((l) => {
      try {
        return JSON.parse(l) as MemoryEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is MemoryEntry => e !== null);
}

export function readMemoryFor(componentId: string, limit = 5): MemoryEntry[] {
  return readAllEntries()
    .filter((e) => e.component_id === componentId)
    .slice(-limit);
}

/**
 * The actual Section 13 contract: "read, not written, by Node 1's Intent
 * Refinement and Node 3a's Tool Matchmaker." Component-scoped decisions
 * merged with repo-wide conventions, capped — same "small, bounded per
 * call" discipline as every other LLM call in this system, so a growing
 * log never turns into an uncapped prompt.
 */
export function readRelevantMemory(componentId: string, limit = 8): MemoryEntry[] {
  return readAllEntries()
    .filter((e) => e.component_id === componentId || e.component_id === GLOBAL_SCOPE)
    .slice(-limit);
}

export function readGlobalMemory(limit = 8): MemoryEntry[] {
  return readAllEntries()
    .filter((e) => e.component_id === GLOBAL_SCOPE)
    .slice(-limit);
}

/**
 * What has been recorded about each component, one text per component id (its last few notes joined). Repo-wide notes are left out.
 * Used only for local word matching (manifest/similar.ts), never placed in a prompt.
 */
export function readComponentNotes(perComponent = 5): Record<string, string> {
  const byId = new Map<string, string[]>();
  for (const e of readAllEntries()) {
    if (e.component_id === GLOBAL_SCOPE) continue;
    const list = byId.get(e.component_id) ?? [];
    list.push(e.summary);
    byId.set(e.component_id, list.slice(-perComponent));
  }
  return Object.fromEntries([...byId].map(([id, lines]) => [id, lines.join(" ")]));
}

/** Flattens entries into short lines for direct prompt injection. */
export function formatMemoryLines(entries: MemoryEntry[]): string[] {
  return entries.map((e) => `[${e.kind}] ${e.summary}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// rememberNote: the one door for saving a note, used by `purix remember` (a person) and `purix_remember` (an agent).
//
// A person at a terminal and an agent over MCP must not get different memory. What differs is trust. A note an agent writes
// is placed into later prompts, and a repository's memory log is committed to the working tree, so an agent's note is held to
// a tighter rule than a person's: it must be short, one line, and free of instruction-like text and hidden characters. It is
// saved under its own kind, "agent-note", so a reader of a prompt or of the log can tell who wrote it.
// ---------------------------------------------------------------------------------------------------------------------

/** Longest note an agent may save. Conventions and decisions are one sentence or two; a longer text belongs in project docs. */
export const AGENT_NOTE_MAX_CHARS = 500;
/** The kind an agent's note is saved under. A person's note keeps the kind "decision". */
export const AGENT_NOTE_KIND = "agent-note";

export type RememberRefusal = "empty" | "unknown_component" | "too_long" | "instruction_like";

export type RememberResult =
  | { ok: true; scope: string; scrubbedCount: number; duplicate: boolean }
  | { ok: false; reason: RememberRefusal; message: string };

export function rememberNote(input: { note: string; componentId?: string; source: "person" | "agent"; agentId?: string }): RememberResult {
  const agent = input.source === "agent";
  // An agent's note is one line: newlines and runs of spaces collapse. A person's note is kept as typed.
  const note = agent ? input.note.replace(/\s+/g, " ").trim() : input.note.trim();
  if (note === "") return { ok: false, reason: "empty", message: "The note is empty — nothing was recorded." };

  if (input.componentId !== undefined && !readManifest(input.componentId)) {
    return { ok: false, reason: "unknown_component", message: `No manifest entry for "${input.componentId}". Run "purix status" to see what's tracked.` };
  }

  if (agent) {
    if (note.length > AGENT_NOTE_MAX_CHARS) {
      return { ok: false, reason: "too_long", message: `The note is ${note.length} characters; the limit is ${AGENT_NOTE_MAX_CHARS}. Shorten it to the one convention or decision it records. Nothing was recorded.` };
    }
    const scan = sanitizeRepairText(note);
    if (scan.hits.length > 0 || scan.strippedHidden > 0) {
      recordEvent("input_neutralized", {
        component_id: input.componentId ?? GLOBAL_SCOPE,
        operation: "remember",
        detail: { stage: "memory_write", source: "memory", hit_count: scan.hits.length, hidden_characters_removed: scan.strippedHidden, agent_id: input.agentId ?? null },
      });
      return { ok: false, reason: "instruction_like", message: "The note contains text that reads as an instruction to a model, or hidden characters. Notes record conventions and decisions as plain statements. Nothing was recorded." };
    }
  }

  const scope = input.componentId ?? GLOBAL_SCOPE;
  const kind = agent ? AGENT_NOTE_KIND : "decision";
  // Saying the same thing twice would crowd the capped prompt window with one line. Report it as saved: the convention is on record.
  const existing = scope === GLOBAL_SCOPE ? readGlobalMemory(1000) : readMemoryFor(scope, 1000);
  const duplicate = existing.some((e) => e.kind === kind && e.summary === note);
  let scrubbedCount = 0;
  if (!duplicate) scrubbedCount = recordMemory({ component_id: scope, kind, summary: note }).scrubbedCount;

  recordEvent("memory_recorded", {
    component_id: scope,
    operation: "remember",
    detail: { scope, source: input.source, agent_id: input.agentId ?? null, chars: note.length, duplicate },
  });
  return { ok: true, scope, scrubbedCount, duplicate };
}
