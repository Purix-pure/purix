// packages/core/src/entrypoints/briefing.ts
//
// P7: the project briefing, built in one place. What an agent or a person should be shown about the project before a request becomes a
// change: the conventions the repository has recorded, the ids of the components that exist, and the existing components the request
// resembles. `purix create` and `purix_create` use the first two (entrypoints/create_plan.ts); `purix change` and `purix_change` use the
// third to say "change X instead?" before a duplicate component is proposed. Modify's neighbour files are loaded separately because they
// need a target component (recovery/classify_and_compile.ts).
//
// Everything here is local and deterministic: no model call, nothing sent anywhere. The briefing only SUGGESTS; a person or an agent decides.
import type { ManifestEntry } from "../manifest/schema.js";
import { listManifest, storeExists } from "../manifest/store.js";
import { readGlobalMemory, formatMemoryLines, readComponentNotes } from "../manifest/memory.js";
import { CODEBASE_INDEX_COMPONENT_ID } from "../manifest/adopt.js";
import { findSimilarComponents, type SimilarComponent } from "../manifest/similar.js";

/** Most existing ids shown to a planner. A larger project shows the first ones by id, which is stable between calls. */
export const MAX_KNOWN_COMPONENT_IDS = 60;
/** Most recorded conventions shown. */
export const MAX_CONVENTION_LINES = 8;

export interface Briefing {
  /** Repo-wide conventions, formatted as prompt lines. Empty when nothing is recorded. */
  conventions: string[];
  /** Ids of existing components (codebase-index record excluded), at most MAX_KNOWN_COMPONENT_IDS. */
  knownComponentIds: string[];
  /** Existing components the intent resembles, best first. Empty when none does. */
  similar: SimilarComponent[];
}

function realComponents(): ManifestEntry[] {
  if (!storeExists()) return [];
  return listManifest().filter((e) => e.component_id !== CODEBASE_INDEX_COMPONENT_ID && e.component_type !== "codebase_index");
}

export function briefingConventions(): string[] {
  return storeExists() ? formatMemoryLines(readGlobalMemory(MAX_CONVENTION_LINES)) : [];
}

export function briefingComponentIds(): string[] {
  return realComponents().map((e) => e.component_id).sort().slice(0, MAX_KNOWN_COMPONENT_IDS);
}

export function briefingSimilar(intent: string, manifest?: ManifestEntry[]): SimilarComponent[] {
  const components = manifest ?? realComponents();
  if (components.length === 0) return [];
  return findSimilarComponents(intent, components, 3, storeExists() ? readComponentNotes() : {});
}

export function buildBriefing(intent: string): Briefing {
  return { conventions: briefingConventions(), knownComponentIds: briefingComponentIds(), similar: briefingSimilar(intent) };
}
