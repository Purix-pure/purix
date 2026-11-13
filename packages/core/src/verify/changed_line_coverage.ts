// src/verify/changed_line_coverage.ts
//
// F06-04 (research 06 section 5), first slice: the pure parts of "did a test run the lines this change touched?". Nothing here runs a
// test, reads the disk or decides anything; it turns (old text, new text, a runner's lcov report) into a number and a list of lines.
// The producer that asks a runner for coverage, and the trust-gate step that reads the number, are NOT built yet (see the handoff).
//
// Rules the research sets, and what each function does about them:
//  - Coverage is a finder of untested code, never a target: this module returns data, and nothing here can block.
//  - Only EXECUTABLE changed lines count (lcov lists them as DA lines). A comment, a blank line or a closing brace is not "uncovered".
//  - A file the report does not mention is "not measured", never "covered" and never "uncovered": the caller must say which.

/** 1-based line numbers of `newText` that are new or edited compared with `oldText`. `oldText` undefined (a new file): every line. */
export function changedLineNumbers(oldText: string | undefined, newText: string): number[] {
  const next = splitLines(newText);
  if (oldText === undefined) return next.map((_, i) => i + 1);
  const prev = splitLines(oldText);
  // A diff of very large files is not worth its cost here: read the whole file as changed, the stricter reading (more lines to cover).
  if (prev.length * next.length > MAX_DIFF_CELLS) return next.map((_, i) => i + 1);
  const kept = longestCommonLines(prev, next);
  const out: number[] = [];
  for (let i = 0; i < next.length; i++) if (!kept.has(i)) out.push(i + 1);
  return out;
}

const MAX_DIFF_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop(); // a final newline is not a line
  return lines;
}

/** Indexes of `next` that belong to a longest common subsequence with `prev` (lines unchanged by the edit). */
function longestCommonLines(prev: string[], next: string[]): Set<number> {
  const n = prev.length;
  const m = next.length;
  // Trim the common head and tail first: most edits are small, and this keeps the table tiny.
  let head = 0;
  while (head < n && head < m && prev[head] === next[head]) head++;
  let tail = 0;
  while (tail < n - head && tail < m - head && prev[n - 1 - tail] === next[m - 1 - tail]) tail++;
  const kept = new Set<number>();
  for (let i = 0; i < head; i++) kept.add(i);
  for (let i = 0; i < tail; i++) kept.add(m - 1 - i);
  const a = prev.slice(head, n - tail);
  const b = next.slice(head, m - tail);
  if (a.length === 0 || b.length === 0) return kept;
  const w = b.length + 1;
  const table = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * w + j] = a[i] === b[j] ? table[(i + 1) * w + j + 1]! + 1 : Math.max(table[(i + 1) * w + j]!, table[i * w + j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      kept.add(head + j);
      i++;
      j++;
    } else if (table[(i + 1) * w + j]! >= table[i * w + j + 1]!) i++;
    else j++;
  }
  return kept;
}

/** file (as the report names it) -> executable line number -> times run. */
export type LineHits = Map<string, Map<number, number>>;

/** Reads an lcov report (Node's `--test-reporter=lcov`, Jest, Vitest, coverage.py's `coverage lcov` all write it). Only SF and DA lines are used. */
export function parseLcov(text: string): LineHits {
  const out: LineHits = new Map();
  let current: Map<number, number> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      const file = line.slice(3).replace(/\\/g, "/");
      current = out.get(file) ?? new Map();
      out.set(file, current);
    } else if (line.startsWith("DA:") && current) {
      const [no, hits] = line.slice(3).split(",");
      const n = Number(no);
      const h = Number(hits);
      if (Number.isInteger(n) && n > 0 && Number.isFinite(h)) current.set(n, (current.get(n) ?? 0) + h);
    } else if (line === "end_of_record") {
      current = undefined;
    }
  }
  return out;
}

/** file (as the report names it) -> lines where a branch (an `if` body, a `catch`, a fall-through after `return`) starts and no test took it. */
export type BranchMisses = Map<string, Set<number>>;

/**
 * Reads the BRDA records of an lcov report: `BRDA:line,block,branch,taken`. A branch with taken 0 on a line means a test ran the line but not
 * all of what starts there. Node's line records alone miss this (a `return` after an `if (x) return` reads as run), so the producer reads both.
 * `-` (never reached) counts as 0.
 */
export function parseLcovBranchMisses(text: string): BranchMisses {
  const out: BranchMisses = new Map();
  let current: Set<number> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      const file = line.slice(3).replace(/\\/g, "/");
      current = out.get(file) ?? new Set();
      out.set(file, current);
    } else if (line.startsWith("BRDA:") && current) {
      const [no, , , taken] = line.slice(5).split(",");
      const n = Number(no);
      if (Number.isInteger(n) && n > 0 && (taken === "-" || Number(taken) === 0)) current.add(n);
    } else if (line === "end_of_record") {
      current = undefined;
    }
  }
  return out;
}

/**
 * Lines of a TypeScript file that hold only types (an `interface` or `type` declaration, including the lines inside it). The compiler removes
 * them, so no test can run them, and a report that lists them as unrun would make a change that only adds a type look untested. Plain text
 * scan, not a parse: it follows brace and paren depth and ends a `type` at its `;` or, with no `;`, at the first line that is not a continuation.
 */
export function typeOnlyLines(text: string): Set<number> {
  const lines = splitLines(text);
  const out = new Set<number>();
  let i = 0;
  while (i < lines.length) {
    const t = lines[i]!;
    const startsInterface = /^\s*(?:export\s+)?(?:declare\s+)?interface\s+[A-Za-z_$]/.test(t);
    const startsType = /^\s*(?:export\s+)?(?:declare\s+)?type\s+[A-Za-z_$][\w$]*\s*(?:<[^=]*>)?\s*=/.test(t);
    if (!startsInterface && !startsType) {
      i++;
      continue;
    }
    let depth = 0;
    let j = i;
    for (; j < lines.length; j++) {
      const code = lines[j]!.replace(/\/\/.*$/, "");
      for (const ch of code) {
        if (ch === "{" || ch === "(" || ch === "[") depth++;
        else if (ch === "}" || ch === ")" || ch === "]") depth--;
      }
      const ended = startsInterface ? depth <= 0 && /[}]/.test(code) : depth <= 0 && (/;\s*$/.test(code) || !/[|&=,<(]\s*$/.test(code.trimEnd()) && !/^\s*[|&]/.test(lines[j + 1] ?? ""));
      if (ended) break;
    }
    for (let k = i; k <= Math.min(j, lines.length - 1); k++) out.add(k + 1);
    i = j + 1;
  }
  return out;
}

export interface FileLineCoverage {
  /** False when the report has no entry for this file: nothing can be said about it. */
  measured: boolean;
  /** Changed lines that are executable (the report lists them). */
  executable: number[];
  /** Executable changed lines no test ran. */
  uncovered: number[];
  /** Changed lines a test ran but where a branch that starts on the line was never taken (an `if` body, a `catch`). Counted as not covered. Empty when the report held no branch records. */
  partial?: number[];
}

export interface ChangedLineCoverage {
  perFile: Record<string, FileLineCoverage>;
  /** Executable changed lines in measured files. */
  total: number;
  covered: number;
  /** covered / total, or undefined when nothing executable was measured (never 1 by default). */
  ratio: number | undefined;
  /** Changed files the report did not mention. */
  notMeasured: string[];
}

/**
 * `changed`: file -> changed line numbers (changedLineNumbers). `hits`: the parsed report. A file is matched by its path as given, or by
 * the report path that ends with it (a report may hold absolute paths).
 */
export function changedLineCoverage(changed: Record<string, number[]>, hits: LineHits, branchMisses?: BranchMisses, ignore?: Record<string, Set<number>>): ChangedLineCoverage {
  const perFile: Record<string, FileLineCoverage> = {};
  const notMeasured: string[] = [];
  let total = 0;
  let covered = 0;
  for (const [file, lines] of Object.entries(changed)) {
    const norm = file.replace(/\\/g, "/");
    const entry = hits.get(norm) ?? [...hits.entries()].find(([k]) => k.endsWith("/" + norm))?.[1];
    if (!entry) {
      perFile[file] = { measured: false, executable: [], uncovered: [] };
      notMeasured.push(file);
      continue;
    }
    const skip = ignore?.[file];
    const executable = lines.filter((n) => entry.has(n) && !skip?.has(n));
    const uncovered = executable.filter((n) => (entry.get(n) ?? 0) === 0);
    const misses = branchMisses?.get(norm) ?? [...(branchMisses?.entries() ?? [])].find(([k]) => k.endsWith("/" + norm))?.[1];
    const partial = misses ? executable.filter((n) => (entry.get(n) ?? 0) > 0 && misses.has(n)) : [];
    perFile[file] = { measured: true, executable, uncovered, ...(partial.length > 0 ? { partial } : {}) };
    total += executable.length;
    covered += executable.length - uncovered.length - partial.length;
  }
  return { perFile, total, covered, ratio: total === 0 ? undefined : covered / total, notMeasured };
}

/** What a verification result carries about coverage. Information only: nothing blocks on it. */
export interface ChangedCoverageSummary {
  /** Executable changed lines in measured files, and how many of them a passing run fully ran. */
  covered: number;
  total: number;
  /** covered / total; absent when nothing executable was measured (never 1 by default). */
  ratio?: number;
  /** file -> changed lines no test ran. Only files with entries. */
  uncovered: Record<string, number[]>;
  /** file -> changed lines a test ran but where a branch starting there was never taken. Only files with entries. */
  partial?: Record<string, number[]>;
  /** Changed files the report did not mention, or that no run measured. */
  notMeasured: string[];
  /** Set when no figure could be made for some file and why (a framework with no producer yet). */
  whyNotMeasured?: string;
}

/** Folds the per-run results of one verification (one per language group) into one summary. */
export function summarizeCoverage(parts: { coverage?: ChangedLineCoverage; notMeasured?: string; files: string[] }[]): ChangedCoverageSummary | undefined {
  if (parts.length === 0) return undefined;
  let covered = 0;
  let total = 0;
  const uncovered: Record<string, number[]> = {};
  const partial: Record<string, number[]> = {};
  const notMeasured: string[] = [];
  const why: string[] = [];
  for (const part of parts) {
    if (!part.coverage) {
      notMeasured.push(...part.files);
      if (part.notMeasured) why.push(part.notMeasured);
      continue;
    }
    covered += part.coverage.covered;
    total += part.coverage.total;
    notMeasured.push(...part.coverage.notMeasured);
    for (const [file, f] of Object.entries(part.coverage.perFile)) {
      if (f.uncovered.length > 0) uncovered[file] = f.uncovered;
      if (f.partial && f.partial.length > 0) partial[file] = f.partial;
    }
  }
  return {
    covered,
    total,
    ...(total > 0 ? { ratio: covered / total } : {}),
    uncovered,
    ...(Object.keys(partial).length > 0 ? { partial } : {}),
    notMeasured: [...new Set(notMeasured)],
    ...(why.length > 0 ? { whyNotMeasured: [...new Set(why)].join("; ") } : {}),
  };
}

/** One line for a person: which changed lines no test ran. Undefined when there is nothing to say. Information only; the caller prints it. */
export function uncoveredLinesNote(c: ChangedCoverageSummary | undefined): string | undefined {
  if (!c) return undefined;
  const parts: string[] = [];
  for (const [file, lines] of Object.entries(c.uncovered).slice(0, 5)) parts.push(`${file}:${lines.slice(0, 8).join(",")}${lines.length > 8 ? ",…" : ""}`);
  const partial = Object.keys(c.partial ?? {});
  if (parts.length === 0 && partial.length === 0) return undefined;
  const more = partial.length > 0 ? ` A branch on a line of ${partial.slice(0, 3).join(", ")} was run only one way.` : "";
  return `Changed lines no test ran${parts.length > 0 ? `: ${parts.join("; ")}` : ""}.${more} Information only, nothing is blocked.`;
}
