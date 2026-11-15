// packages/core/src/entrypoints/create_plan.ts
//
// P4: planning a new component, in one place for `purix create` and `purix_create`.
// Before this the planner saw neither the project's recorded conventions nor which components already exist, so it guessed
// `depends_on`; linkComponents then dropped every id it could not find, and the dependency graph stayed empty. Now the planner is
// shown the real ids and the conventions, an invented id gets one corrective retry, and an id still not real is dropped here, with the
// ones dropped returned so the caller can say so.
import type { TopologyPlan, ManifestEntry } from "../manifest/schema.js";
import { classifyGreenfield } from "../llm/classify.js";
import { recordMemory } from "../manifest/memory.js";
import { briefingComponentIds, briefingConventions, MAX_KNOWN_COMPONENT_IDS } from "./briefing.js";

export { MAX_KNOWN_COMPONENT_IDS };
const MEMORY_SUMMARY_MAX = 300;

export interface PlannedComponent {
  plan: TopologyPlan;
  /** Ids the planner named in depends_on that do not exist, after the one retry. Removed from plan.depends_on. */
  droppedDependsOn: string[];
  /** Whether the corrective retry was used (a second model call). */
  retried: boolean;
}

export const existingComponentIds = briefingComponentIds;

export async function planNewComponent(name: string, intent: string | undefined, opts: { language?: string } = {}): Promise<PlannedComponent> {
  const known = existingComponentIds();
  const conventions = briefingConventions();
  const base = {
    ...(opts.language !== undefined ? { language: opts.language } : {}),
    ...(conventions.length ? { conventions } : {}),
    ...(known.length ? { knownComponents: known } : {}),
  };

  let plan = await classifyGreenfield(name, intent, base);
  const unknownIn = (p: TopologyPlan) => p.depends_on.filter((id) => id !== p.component_id && !known.includes(id));
  let retried = false;

  // With nothing to depend on, any id is invented and there is nothing to correct it against: drop without paying for a retry.
  if (known.length > 0 && unknownIn(plan).length > 0) {
    retried = true;
    const bad = unknownIn(plan);
    plan = await classifyGreenfield(name, intent, {
      ...base,
      dependsOnNotice: `Your previous plan listed depends_on ids that do not exist: ${bad.join(", ")}. Answer again; depends_on may contain only ids from the list of existing component ids, or be [].`,
    });
  }
  const droppedDependsOn = [...new Set(unknownIn(plan))];
  if (droppedDependsOn.length > 0) plan = { ...plan, depends_on: plan.depends_on.filter((id) => !droppedDependsOn.includes(id)) };
  return { plan, droppedDependsOn, retried };
}

/**
 * After a create lands: one memory line saying what the component is for and what it depends on, so the next create or modify is shown it.
 * Written from the person's own request and the verified plan, never from model prose. Secrets are scrubbed by recordMemory.
 */
export function recordCreateMemory(entry: Pick<ManifestEntry, "component_id" | "depends_on" | "files">, intent: string | undefined): void {
  const purpose = (intent ?? "").replace(/\s+/g, " ").trim().slice(0, MEMORY_SUMMARY_MAX);
  const deps = entry.depends_on.length ? `; depends on ${entry.depends_on.join(", ")}` : "";
  const summary = `${purpose || "created"} (files: ${entry.files.join(", ")}${deps})`.slice(0, MEMORY_SUMMARY_MAX + 120);
  recordMemory({ component_id: entry.component_id, kind: "create", summary });
}
