// packages/cli/src/cli/change_summary.ts
//
// AI-13 (PURIX-33): what the CLI prints after an auto-commit, where no diff was shown before the write.
// Pure: takes data, returns lines. The caller prints them. The wording for untested files stays in core (notTestedMessage).
import type { RunVerification } from "./savings_output.js";
import type { InfrastructureKind } from "@purix/core/verify/outcome";
import { couldNotCheckHeadline } from "@purix/core/verify/surface_text";

export interface ChangedFileCount {
  path: string;
  added: number;
  removed: number;
  /** false when the file was too large to diff by line (added/removed are then the new and old line totals). */
  exact: boolean;
}

/** One line per changed file: path, lines added, lines removed. */
export function formatChangeLines(files: ChangedFileCount[]): string[] {
  return files.map((f) => (f.exact ? `  ${f.path}  +${f.added} -${f.removed}` : `  ${f.path}  changed (${f.removed} → ${f.added} lines; too large to count by line)`));
}

/** What the run summary may say: "passed" only when no changed file was left untested or unchecked. */
export function runVerificationOf(v: { notTested?: string[]; notChecked?: string[] }): RunVerification {
  return (v.notTested?.length ?? 0) > 0 || (v.notChecked?.length ?? 0) > 0 ? "partial" : "passed";
}

/** One line saying what verification covered for this run. */
export function formatCoverageLine(i: { verification?: RunVerification; isolation?: string; changedCount: number; notTestedCount: number; notCheckedCount?: number }): string {
  const where = i.isolation === undefined ? "" : ` (isolation: ${i.isolation})`;
  const files = (n: number) => `${n} of ${i.changedCount} changed file${i.changedCount === 1 ? "" : "s"}`;
  const unchecked = i.notCheckedCount ?? 0;
  if (i.verification === "passed") return `  Verification passed in the sandbox${where}; every changed file was reached by a test.`;
  if (i.verification === "partial" && unchecked > 0) {
    const tail = i.notTestedCount > 0 ? ` ${files(i.notTestedCount)} had no test.` : "";
    return `  Verification passed in the sandbox${where} for the files Purix supports, but ${files(unchecked)} ${unchecked === 1 ? "was" : "were"} not checked (unsupported language; listed below).${tail}`;
  }
  if (i.verification === "partial") return `  Verification passed in the sandbox${where}, but ${i.notTestedCount} of ${i.changedCount} changed file${i.changedCount === 1 ? "" : "s"} had no test (listed below).`;
  return `  No verification result was recorded for this run.`;
}

/**
 * The lines printed when a change was stopped. A check that could not run (tool missing, timeout, unsupported language) is said in
 * those words, never as "Change not applied" for a failure of the code. `reason` already carries the hint when the stop had one.
 */
export function formatStopLines(f: { reason?: string; infrastructure?: { kind: InfrastructureKind; actionHint?: string } }): string[] {
  const reason = f.reason ?? "unknown reason";
  if (!f.infrastructure) return [``, `🛑 Change not applied. ${reason}`];
  const hint = f.infrastructure.actionHint && !reason.includes(f.infrastructure.actionHint) ? [`  ${f.infrastructure.actionHint}`] : [];
  return [``, `🛑 ${couldNotCheckHeadline(f.infrastructure.kind)} The change was not applied.`, `  ${reason}`, ...hint];
}
