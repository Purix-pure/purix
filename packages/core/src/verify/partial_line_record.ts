// src/verify/partial_line_record.ts
//
// F04-04: an exact anchor that starts or ends inside a line keeps the rest of that line (verify/anchor_match.ts sets `partialLine`;
// compile.ts collects the paths). The compile step writes an `anchor_match` event with outcome "partial_line"; this module turns those
// events into "which components' latest pass followed such an edit", so `purix check`, the evidence report and `purix status` can say it.
// Pure: no I/O. It is a review note, never a failure and never a block (research 04, section 1.1).
import type { CompileResult } from "./compile.js";

export interface StreamEvent {
  kind: string;
  component_id: string | null;
  detail: Record<string, unknown>;
}

/**
 * Walks events oldest first. A partial-line edit is held for its component until that component's next passing verification, which
 * takes it; a pass with nothing held clears the earlier flag. A partial-line edit that never reached a pass is not reported.
 */
export function latestPartialLine(stream: readonly StreamEvent[]): Map<string, string[]> {
  const held = new Map<string, string[]>();
  const latest = new Map<string, string[]>();
  for (const e of stream) {
    if (!e.component_id) continue;
    if (e.kind === "anchor_match" && e.detail?.["outcome"] === "partial_line") {
      const raw = e.detail["paths"];
      if (!Array.isArray(raw)) continue;
      const paths = raw.filter((x): x is string => typeof x === "string");
      if (paths.length === 0) continue;
      const cur = held.get(e.component_id) ?? [];
      for (const p of paths) if (!cur.includes(p)) cur.push(p);
      held.set(e.component_id, cur);
    } else if (e.kind === "verification_pass") {
      const h = held.get(e.component_id);
      if (h) latest.set(e.component_id, h);
      else latest.delete(e.component_id);
      held.delete(e.component_id);
    }
  }
  return latest;
}

/**
 * What a front door passes on: the partial-line paths of a deterministic compile, plus those reported by repair or escalation during the
 * run. A refused compile has nothing applied.
 */
export function partialLinePathsFor(compiled: CompileResult, fromEscalation: boolean, fromRun?: readonly string[]): string[] | undefined {
  // C3: `fromRun` carries what repair or escalation reported during the run. An escalation-authored result has no compile flag of its
  // own (the escalation started from the original files), but its own anchors can still have left part of a line.
  const out: string[] = [];
  if (!fromEscalation && compiled.ok) for (const p of compiled.partialLinePaths ?? []) if (!out.includes(p)) out.push(p);
  for (const p of fromRun ?? []) if (!out.includes(p)) out.push(p);
  return out.length > 0 ? out : undefined;
}

/** A short marker for list views (`purix status`). */
export function partialLineBadge(paths: readonly string[]): string {
  return `edited inside a line: ${new Set(paths).size} file(s), rest of that line kept`;
}
