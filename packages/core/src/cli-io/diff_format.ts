// packages/core/src/cli-io/diff_format.ts
//
// IDEA-078 / handoff finding #5 ("I found no code path that renders the
// proposed patch as a diff before 'Apply this change?'"): confirmGated()
// checkpoints for "modify" and "diff ingest" previously asked a human to
// approve real file writes with no rendering of what would actually
// change — just a component ID and a TrustGate reason string. Decision 1
// (resolved 2026-09-24, unconditional — no suppress flag): every path
// that reaches a human_confirm checkpoint is already a path TrustGate
// judged to need real human attention (contract-changing, low-confidence,
// a DOF hit, or escalation-authored); a flag to hide the diff on those
// paths would only reintroduce the exact gap this fix exists to close.
//
// No diffing library is a dependency of this project, so this is a small,
// dependency-free line diff. Shape (2026-09-24 rewrite, after the first
// version failed typecheck under noUncheckedIndexedAccess and dumped the
// whole trailing unchanged run):
//   1. Trim the common line prefix and suffix first — for the typical
//      "one small edit in a big file" case this leaves a tiny middle.
//   2. Run a classic LCS over only the differing middle, in one flat
//      Uint32Array, refusing to build it past MAX_DIFF_CELLS.
//   3. Render with CONTEXT_LINES of context around each change; long
//      unchanged runs collapse. Leading/trailing runs show only the side
//      that touches a change.

export interface FileDiffInput {
  path: string;
  before: string | null; // null = file did not exist before (pure addition)
  after: string | null; // null = file was deleted
}

type DiffKind = "same" | "add" | "remove";
interface DiffRow {
  kind: DiffKind;
  line: string;
}

/** Cap on the LCS table size (cells) for the differing middle section. */
export const MAX_DIFF_CELLS = 4_000_000;
/** Cap on lines printed for a pure add/delete of a very large file. */
export const MAX_PREVIEW_LINES = 4000;
const CONTEXT_LINES = 3;

function splitLines(content: string): string[] {
  // Split on \n (tolerating \r\n) and drop the single empty element a
  // trailing newline produces, so line counts match an editor's.
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * LCS line diff over already-trimmed inputs. Returns null when the table
 * would exceed MAX_DIFF_CELLS (caller falls back to a summary message).
 */
function lcsRows(oldLines: readonly string[], newLines: readonly string[]): DiffRow[] | null {
  const n = oldLines.length;
  const m = newLines.length;
  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) return null;
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  const at = (i: number, j: number): number => dp[i * width + j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        oldLines[i] === newLines[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const o = oldLines[i] as string;
    const w = newLines[j] as string;
    if (o === w) {
      rows.push({ kind: "same", line: o });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      rows.push({ kind: "remove", line: o });
      i++;
    } else {
      rows.push({ kind: "add", line: w });
      j++;
    }
  }
  for (; i < n; i++) rows.push({ kind: "remove", line: oldLines[i] as string });
  for (; j < m; j++) rows.push({ kind: "add", line: newLines[j] as string });
  return rows;
}

function diffRows(oldLines: string[], newLines: string[]): DiffRow[] | null {
  let start = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (start < minLen && oldLines[start] === newLines[start]) start++;
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld--;
    endNew--;
  }
  const middle = lcsRows(oldLines.slice(start, endOld), newLines.slice(start, endNew));
  if (middle === null) return null;
  const head: DiffRow[] = oldLines.slice(0, start).map((line) => ({ kind: "same", line }));
  const tail: DiffRow[] = oldLines.slice(endOld).map((line) => ({ kind: "same", line }));
  return [...head, ...middle, ...tail];
}

function unchangedNote(count: number): string {
  return `  ... (${count} unchanged line${count === 1 ? "" : "s"}) ...`;
}

/** Renders rows with CONTEXT_LINES around changes; long unchanged runs collapse. */
function renderWithContext(rows: readonly DiffRow[]): string[] {
  const out: string[] = [];
  let run: string[] = [];
  let seenChange = false;
  const flush = (atEnd: boolean): void => {
    if (run.length === 0) return;
    const show = (lines: string[]): void => {
      for (const l of lines) out.push(`  ${l}`);
    };
    if (!seenChange) {
      // Leading run: only the lines touching the first change.
      if (run.length > CONTEXT_LINES) out.push(unchangedNote(run.length - CONTEXT_LINES));
      show(run.slice(-CONTEXT_LINES));
    } else if (atEnd) {
      // Trailing run: only the lines touching the last change.
      show(run.slice(0, CONTEXT_LINES));
      if (run.length > CONTEXT_LINES) out.push(unchangedNote(run.length - CONTEXT_LINES));
    } else if (run.length <= CONTEXT_LINES * 2) {
      show(run);
    } else {
      show(run.slice(0, CONTEXT_LINES));
      out.push(unchangedNote(run.length - CONTEXT_LINES * 2));
      show(run.slice(-CONTEXT_LINES));
    }
    run = [];
  };
  for (const row of rows) {
    if (row.kind === "same") {
      run.push(row.line);
      continue;
    }
    flush(false);
    seenChange = true;
    out.push(row.kind === "add" ? `+ ${row.line}` : `- ${row.line}`);
  }
  flush(true);
  return out;
}

const plural = (n: number): string => `${n} line${n === 1 ? "" : "s"}`;

function renderWholeFile(path: string, label: string, lines: string[], sign: "+" | "-"): string {
  const shown = lines.length > MAX_PREVIEW_LINES ? lines.slice(0, MAX_PREVIEW_LINES) : lines;
  const header = `  ${path} (${label}, ${plural(lines.length)})`;
  const note =
    lines.length > MAX_PREVIEW_LINES
      ? `\n  (too large to preview in full — showing first ${MAX_PREVIEW_LINES} lines)`
      : "";
  return `${header}${note}\n${shown.map((l) => `${sign} ${l}`).join("\n")}`;
}

/**
 * Renders a human-readable diff block for one file's before/after
 * content. Not a machine-parseable unified diff (no @@ hunk headers) —
 * this is for a person reading a terminal prompt, not `patch`.
 */
export function formatFileDiff(input: FileDiffInput): string {
  const { path, before, after } = input;
  if (before === null && after !== null) return renderWholeFile(path, "new file", splitLines(after), "+");
  if (after === null && before !== null) return renderWholeFile(path, "deleted", splitLines(before), "-");
  if (before === after) return `  ${path} (unchanged)`;
  const oldLines = splitLines(before ?? "");
  const newLines = splitLines(after ?? "");
  const rows = diffRows(oldLines, newLines);
  if (rows === null) {
    return `  ${path} (${oldLines.length} → ${newLines.length} lines — too large to diff in full; changed, review the file directly before approving)`;
  }
  const added = rows.filter((r) => r.kind === "add").length;
  const removed = rows.filter((r) => r.kind === "remove").length;
  if (added === 0 && removed === 0) {
    // Same lines, different bytes (e.g. only line endings or a trailing newline).
    return `  ${path} (whitespace/line-ending change only)`;
  }
  return `  ${path} (+${added} / -${removed})\n${renderWithContext(rows).join("\n")}`;
}

/**
 * Renders the full diff block for a set of changed files — this is what
 * confirmGated() checkpoints for "modify" and "diff ingest" print
 * unconditionally before asking "Apply this change...?". Files with no
 * actual content change are skipped.
 */
export function formatChangeSetDiff(files: FileDiffInput[]): string {
  const changed = files.filter((f) => f.before !== f.after);
  if (changed.length === 0) return "  (no file content changes)";
  return changed.map((f) => formatFileDiff(f)).join("\n\n");
}