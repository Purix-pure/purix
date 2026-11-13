// src/entrypoints/ingest_deletions.ts
// Plan 0.4: an ingested diff may delete files. This is the one place that decides whether it may, so the CLI and the MCP server
// cannot disagree. A deletion is a change like any other (verified, hash re-checked before the write, journaled, recoverable), with
// two extra rules: it always needs a person's confirmation, and it never removes a test file.
import type { IngestedFileChange } from "./ingest.js";
import type { TrustGateDecision } from "../gates/trustgate.js";

export type DeletionPlan = { ok: true; deletedPaths: string[] } | { ok: false; reason: string };

export interface DeletionPlanInput {
  ingested: IngestedFileChange[];
  /** The component's tracked files (manifest entry.files). */
  tracked: string[];
  /** What the component's files hold on disk now (the verified original). */
  originalFiles: { path: string }[];
  /** The language provider's test-file recogniser. */
  isTestFile: (path: string) => boolean;
}

export function planDeletions(input: DeletionPlanInput): DeletionPlan {
  const deletedPaths = [...new Set(input.ingested.filter((f) => f.status === "deleted").map((f) => f.path))];
  if (deletedPaths.length === 0) return { ok: true, deletedPaths };

  const tracked = new Set(input.tracked);
  const onDisk = new Set(input.originalFiles.map((f) => f.path));
  const foreign = deletedPaths.filter((p) => !tracked.has(p) || !onDisk.has(p));
  if (foreign.length > 0) {
    return {
      ok: false,
      reason: `this diff deletes file(s) this component does not track: ${foreign.join(", ")}. Link the right component first; Purix does not guess which component owns a file it removes.`,
    };
  }

  const tests = deletedPaths.filter((p) => input.isTestFile(p));
  if (tests.length > 0) {
    return {
      ok: false,
      reason: `this diff deletes test file(s) (${tests.join(", ")}). Removing a test is a way to make a failing check pass, so a diff cannot do it. Delete the file yourself and run "purix check", or keep it.`,
    };
  }

  const gone = new Set(deletedPaths);
  const added = input.ingested.filter((f) => f.status === "added").length;
  const remaining = input.originalFiles.filter((f) => !gone.has(f.path)).length + added;
  if (remaining === 0) {
    return { ok: false, reason: `this diff would leave the component with no files. To remove a whole component run "purix delete".` };
  }
  return { ok: true, deletedPaths };
}

/** A change that deletes files is never auto-committed, whatever the classifier's confidence was. It never softens an abort. */
export function holdDeletionForHuman(decision: TrustGateDecision, deletedPaths: string[]): TrustGateDecision {
  if (deletedPaths.length === 0 || decision.action !== "auto_commit") return decision;
  return { action: "human_confirm", reason: `deletes ${deletedPaths.join(", ")}: a deletion always requires confirmation, regardless of confidence` };
}
