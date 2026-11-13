// packages/core/src/tools/resolver.ts
//
// ADR-060 D5: need -> ordered candidates, each with reasons. A pure function: no I/O, no clock, no
// network, no randomness. The same inputs always give the same order.
//
// Ranking inputs, in this order, and nothing else:
//   1. the project already declares the tool
//   2. Purix already installed it
//   3. the catalog's own static priority (lower first)
//   4. the id (alphabetical)
import type { CatalogEntry, Candidate, NeedState, PlannedNeed, PlanResult, ProjectSignals, ToolNeed } from "./types.js";

export interface ResolveInput {
  need: ToolNeed;
  signals: ProjectSignals;
  installedIds: ReadonlySet<string>;
  catalog: readonly CatalogEntry[];
}

export function resolveNeed(input: ResolveInput): Candidate[] {
  const { need, signals, installedIds, catalog } = input;
  const matching = catalog.filter((e) => e.capabilities.includes(need.capability) && e.languages.includes(need.language));
  const candidates: Candidate[] = matching.map((entry) => {
    const usedByProject = signals.declaredIds.has(entry.id);
    const installedByPurix = installedIds.has(entry.id);
    const reasons: string[] = [`provides ${need.capability} for ${need.language}`];
    if (usedByProject) reasons.push("the project already declares it");
    if (installedByPurix) reasons.push("already installed by Purix");
    reasons.push(`catalog priority ${entry.priority}`);
    return { entry, reasons, usedByProject, installedByPurix };
  });
  candidates.sort(
    (a, b) =>
      Number(b.usedByProject) - Number(a.usedByProject) ||
      Number(b.installedByPurix) - Number(a.installedByPurix) ||
      a.entry.priority - b.entry.priority ||
      a.entry.id.localeCompare(b.entry.id)
  );
  return candidates;
}

export function planNeeds(needs: readonly ToolNeed[], signals: ProjectSignals, installedIds: ReadonlySet<string>, catalog: readonly CatalogEntry[]): PlanResult {
  const planned: PlannedNeed[] = needs.map((need) => {
    const candidates = resolveNeed({ need, signals, installedIds, catalog });
    const chosen = candidates[0] ?? null;
    let state: NeedState;
    let note: string | undefined;
    if (!chosen) {
      state = "no-candidate";
      note =
        need.capability === "dep-audit" && need.language === "typescript"
          ? "served by your package manager's own audit; nothing to install"
          : `no tool in the shipped catalog provides ${need.capability} for ${need.language}`;
    } else if (chosen.installedByPurix) {
      state = "installed";
    } else if (signals.projectBinaryIds.has(chosen.entry.id)) {
      state = "project-provided";
      note = "the project has its own copy; Purix will not install another";
    } else {
      state = "missing";
    }
    return { need, state, chosen, candidates, note };
  });
  return { needs: planned };
}
