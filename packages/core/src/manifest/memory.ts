// src/manifest/memory.ts
import { existsSync, appendFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { scrubFreeText } from "../security/secrets.js";
import { PURIX_DIRNAME } from "../platform/layout.js";

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

/** Flattens entries into short lines for direct prompt injection. */
export function formatMemoryLines(entries: MemoryEntry[]): string[] {
  return entries.map((e) => `[${e.kind}] ${e.summary}`);
}