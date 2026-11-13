// packages/core/src/eval/line_ops.ts
//
// AI-10 (PURIX-33): shared line-edit machinery for the two edit-format PROTOTYPES (A2 `line_edit`, A3 hash-labelled
// lines). These live inside the eval harness only. Product code does not import them; they exist so the eval can
// measure whether a new edit vocabulary beats today's anchor-text edits before anyone builds it into the product.
//
// Pure: strings in, strings out. Nothing here reads a file or the environment.

export interface ResolvedOp {
  kind: "replace" | "insert_after" | "delete" | "token";
  /** 1-based first line the operation targets. */
  start: number;
  /** 1-based last line (replace/delete). Equal to start for the others. */
  end: number;
  newLines?: string[];
  oldToken?: string;
  newToken?: string;
}

export type LineOpResult = { ok: true; content: string } | { ok: false; reason: string };

/** Hard cap from the plan: no single edit may touch more than this many lines. */
export const MAX_EDIT_LINES = 60;

export interface SplitFile {
  lines: string[];
  eol: "\n" | "\r\n";
  trailingNewline: boolean;
}

/** Splits into lines without their endings, remembering the dominant ending so it can be restored. */
export function splitFile(content: string): SplitFile {
  const crlf = (content.match(/\r\n/g) ?? []).length;
  const lf = (content.match(/\n/g) ?? []).length - crlf;
  const eol: "\n" | "\r\n" = crlf > lf ? "\r\n" : "\n";
  const trailingNewline = content.endsWith("\n");
  const lines = content.split(/\r?\n/);
  if (trailingNewline) lines.pop();
  return { lines, eol, trailingNewline };
}

export function joinFile(f: SplitFile): string {
  return f.lines.join(f.eol) + (f.trailingNewline ? f.eol : "");
}

/** Applies resolved operations bottom-up. Overlapping or out-of-range operations fail the whole edit. */
export function applyResolvedOps(content: string, ops: ResolvedOp[]): LineOpResult {
  const file = splitFile(content);
  const n = file.lines.length;
  for (const op of ops) {
    if (!Number.isInteger(op.start) || !Number.isInteger(op.end) || op.start < 1 || op.end < op.start || op.end > n) {
      return { ok: false, reason: `line range ${op.start}-${op.end} is outside the file (1-${n})` };
    }
    if (op.end - op.start + 1 > MAX_EDIT_LINES) return { ok: false, reason: `edit touches more than ${MAX_EDIT_LINES} lines` };
    if ((op.newLines?.length ?? 0) > MAX_EDIT_LINES) return { ok: false, reason: `edit writes more than ${MAX_EDIT_LINES} lines` };
  }
  const sorted = [...ops].sort((a, b) => b.start - a.start || b.end - a.end);
  // Conservative: every operation occupies lines start..end (an insert occupies its anchor line), and two operations
  // may not share a line. An insert after line 5 together with a replace of line 5 is refused rather than guessed.
  for (let i = 0; i + 1 < sorted.length; i++) {
    const upper = sorted[i]!;
    const lower = sorted[i + 1]!;
    if (lower.end >= upper.start) return { ok: false, reason: `edits overlap at line ${upper.start}` };
  }
  for (const op of sorted) {
    if (op.kind === "replace") file.lines.splice(op.start - 1, op.end - op.start + 1, ...(op.newLines ?? []));
    else if (op.kind === "delete") file.lines.splice(op.start - 1, op.end - op.start + 1);
    else if (op.kind === "insert_after") file.lines.splice(op.start, 0, ...(op.newLines ?? []));
    else {
      const line = file.lines[op.start - 1]!;
      const from = op.oldToken ?? "";
      const first = from === "" ? -1 : line.indexOf(from);
      if (first === -1) return { ok: false, reason: `token "${from}" is not on line ${op.start}` };
      if (line.indexOf(from, first + 1) !== -1) return { ok: false, reason: `token "${from}" appears more than once on line ${op.start}` };
      file.lines[op.start - 1] = line.slice(0, first) + (op.newToken ?? "") + line.slice(first + from.length);
    }
  }
  return { ok: true, content: joinFile(file) };
}

/** `  12 | code` gutter used by the A2 prototype to label the lines the model may address. */
export function numberedView(content: string): string {
  const { lines } = splitFile(content);
  const width = String(lines.length).length;
  return lines.map((l, i) => `${String(i + 1).padStart(width, " ")} | ${l}`).join("\n");
}
