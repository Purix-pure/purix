// packages/core/src/eval/diffxyz.ts
//
// AI-10 (PURIX-33): adapter for Diff-XYZ style records (Python and JavaScript subset), turning them into eval cases.
//
// NOT VERIFIED against the real dataset. The plan says to check the license first, and this build had no network
// access to do that or to read the dataset's actual field names. So the adapter:
//  - refuses to load anything until the caller states, with `licenseConfirmed: true`, that the license was checked;
//  - reads a small, documented JSONL shape (below) that a person maps the real dataset onto, rather than guessing the
//    dataset's own column names.
//
// One JSON object per line: { "id"?: string, "language": "python" | "javascript" | "js" | "py", "path"?: string,
//   "old_code": string, "new_code": string, "instruction": string }
// The model is shown `old_code` and asked for `instruction`; the expected result is `new_code`.
import type { EvalCase } from "./mutations.js";

export interface DiffXyzOptions {
  /** Must be true. The caller confirms the dataset's license allows this use. */
  licenseConfirmed: boolean;
  maxCases?: number;
}

const EXT: Record<string, string> = { python: "py", py: "py", javascript: "js", js: "js" };

export function loadDiffXyzCases(jsonl: string, opts: DiffXyzOptions): { cases: EvalCase[]; skipped: number } {
  if (opts.licenseConfirmed !== true) {
    throw new Error("Diff-XYZ cases are not loaded until the dataset's license has been checked. Pass licenseConfirmed: true once it has.");
  }
  const cases: EvalCase[] = [];
  let skipped = 0;
  const lines = jsonl.split(/\r?\n/).filter((l) => l.trim() !== "");
  for (let i = 0; i < lines.length; i++) {
    if (opts.maxCases !== undefined && cases.length >= opts.maxCases) break;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(lines[i]!) as Record<string, unknown>;
    } catch {
      skipped++;
      continue;
    }
    const ext = typeof rec.language === "string" ? EXT[rec.language.toLowerCase()] : undefined;
    const { old_code: oldCode, new_code: newCode, instruction } = rec;
    if (!ext || typeof oldCode !== "string" || typeof newCode !== "string" || typeof instruction !== "string" || instruction.trim() === "" || oldCode === newCode) {
      skipped++;
      continue;
    }
    const id = typeof rec.id === "string" && rec.id !== "" ? rec.id : String(i + 1);
    const oldLines = oldCode.split(/\r?\n/);
    const newLines = newCode.split(/\r?\n/);
    let first = 0;
    while (first < Math.min(oldLines.length, newLines.length) && oldLines[first] === newLines[first]) first++;
    cases.push({
      id: `diffxyz-${id}`,
      operator: "operator_swap", // not meaningful for external cases; reports group by arm and tier, not operator
      path: typeof rec.path === "string" && rec.path !== "" ? rec.path : `case_${id}.${ext}`,
      mutated: oldCode,
      original: newCode,
      instruction: instruction.trim(),
      eol: oldCode.includes("\r\n") ? "crlf" : "lf",
      lines: oldLines.length,
      line: first + 1,
    });
  }
  return { cases, skipped };
}
