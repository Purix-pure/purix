// src/verify/anchor_events.ts
//
// AI-06's measurement: how often does the anchor cascade save an edit, and which stage does it? One event per compile that
// either needed a looser stage or missed outright. An exact match with nothing to report writes nothing.
import { recordEvent } from "../manifest/events.js";
import type { CompileResult } from "./compile.js";

export function recordAnchorOutcome(componentId: string, result: CompileResult): void {
  if (result.ok) {
    if (result.anchorRescues && result.anchorRescues.length > 0) {
      recordEvent("anchor_match", { component_id: componentId, detail: { outcome: "rescued", stages: result.anchorRescues.map((r) => r.stage) } });
    }
    // Research 04: an exact match that began or ended mid-line leaves the rest of that line in place. Counted so it can be seen.
    if (result.partialLinePaths && result.partialLinePaths.length > 0) {
      recordEvent("anchor_match", { component_id: componentId, detail: { outcome: "partial_line", paths: result.partialLinePaths } });
    }
    return;
  }
  if (/anchor text not found/.test(result.reason)) {
    recordEvent("anchor_match", { component_id: componentId, detail: { outcome: "missed" } });
  }
}
