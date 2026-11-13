// src/manifest/not_tested.ts
//
// "Which components last passed verification with files nothing tested?" for `purix status`.
// Read from the verification_pass events (their `not_tested` detail), so nothing new is stored and no
// manifest format changes. A component with no such event shows nothing: unknown is not "tested", but
// printing a guess would be worse than printing nothing.
import { listEvents } from "./events.js";
import { latestPartialLine } from "../verify/partial_line_record.js";
import { detailSaysSearchCut, detailSearchCutFiles } from "../verify/discovery_cut.js";

/** componentId -> files the component's MOST RECENT passing verification left untested (only non-empty). */
export function latestNotTestedByComponent(): Map<string, string[]> {
  const latest = new Map<string, string[]>();
  // listEvents is ordered oldest to newest, so a later pass overwrites an earlier one.
  for (const e of listEvents({ kind: "verification_pass" })) {
    if (!e.component_id) continue;
    const raw = e.detail?.not_tested;
    const files = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
    if (files.length > 0) latest.set(e.component_id, files);
    else latest.delete(e.component_id);
  }
  return latest;
}

/** F06-05: components whose MOST RECENT passing verification had its search for tests cut off at the file limit (and left files untested). */
export function latestSearchCutByComponent(): Set<string> {
  const cut = new Set<string>();
  for (const e of listEvents({ kind: "verification_pass" })) {
    if (!e.component_id) continue;
    const raw = e.detail?.not_tested;
    const hasGap = Array.isArray(raw) && raw.some((x) => typeof x === "string");
    if (hasGap && detailSaysSearchCut(e.detail)) cut.add(e.component_id);
    else cut.delete(e.component_id);
  }
  return cut;
}

/** C3: for each component in latestSearchCutByComponent, the files the cut covered; undefined when the record has no list (then it covered all of its untested files). */
export function latestSearchCutFilesByComponent(): Map<string, string[] | undefined> {
  const cut = new Map<string, string[] | undefined>();
  for (const e of listEvents({ kind: "verification_pass" })) {
    if (!e.component_id) continue;
    const raw = e.detail?.not_tested;
    const hasGap = Array.isArray(raw) && raw.some((x) => typeof x === "string");
    if (hasGap && detailSaysSearchCut(e.detail)) cut.set(e.component_id, detailSearchCutFiles(e.detail));
    else cut.delete(e.component_id);
  }
  return cut;
}

/** F04-04: componentId -> files whose latest passing verification followed an edit that kept the rest of a line (for `purix status`). */
export function latestPartialLineByComponent(): Map<string, string[]> {
  return latestPartialLine(listEvents().filter((e) => e.kind === "verification_pass" || e.kind === "anchor_match").map((e) => ({ kind: e.kind, component_id: e.component_id ?? null, detail: e.detail ?? {} })));
}
