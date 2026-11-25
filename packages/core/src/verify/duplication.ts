// packages/core/src/verify/duplication.ts
//
// An optional check for repeated code: after a change, how many lines of the files it touched sit inside a block of six or more
// consecutive lines that also appears somewhere else in the project, and how many did before the change. Off unless
// PURIX_DUPLICATION_CHECK is set. It runs on this machine, with no tool to install and no network.
//
// Why it exists: a study of 153 million lines found duplicated code rising as AI use rose, a correlation and not a cause. A developer
// can see the number for their own change. Rules it keeps:
//  - It is a finder, never a target and never a gate. Nothing here can block a change; repeated code is sometimes right.
//  - The number is lines in blocks that repeat, compared before and after for the same files. It is not "quality".
//  - A project too large to read in full is read in part, and the result says so (`cut`), so a low figure from a cut read is not shown as clean.
//  - Only file names go into the comparison; no file text is stored anywhere. The recorded figure holds counts only.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, relative, sep } from "node:path";
import { purixEnv } from "../platform/env.js";

/** Consecutive normalised lines that must repeat for a block to count. Six keeps out imports, braces and one-line idioms. */
export const DUP_WINDOW = 6;
const MAX_FILES = 600;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage", "venv", "__pycache__", "target"]);
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"]);

export function duplicationEnabled(): boolean {
  const v = (purixEnv("PURIX_DUPLICATION_CHECK") ?? "").trim().toLowerCase();
  return v === "1" || v === "on" || v === "true" || v === "yes";
}

export interface DuplicationSummary {
  /** Lines of the changed files inside a repeating block, before and after the change. */
  before: number;
  after: number;
  /** Lines of the changed files after the change that were looked at (normalised: comments, blanks and bare braces left out). */
  linesChecked: number;
  /** Other project files the changed files were compared with. */
  filesCompared: number;
  /** True when the project had more files or bytes than this check reads, so some were not compared. */
  cut: boolean;
}

const BARE = /^[\s{}()[\];,]*$/;

/** The lines that carry code: trimmed, inner spaces collapsed, with blanks, comment-only lines and bare punctuation dropped. */
export function normalizeLines(text: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (inBlock) { const end = line.indexOf("*/"); if (end === -1) continue; line = line.slice(end + 2).trim(); inBlock = false; }
    if (line.startsWith("/*")) { if (!line.includes("*/")) { inBlock = true; continue; } line = line.slice(line.indexOf("*/") + 2).trim(); }
    if (line === "" || line.startsWith("//") || line.startsWith("#") || line.startsWith("* ") || line === "*" || BARE.test(line)) continue;
    out.push(line.replace(/\s+/g, " "));
  }
  return out;
}

function windows(lines: string[]): string[] {
  const w: string[] = [];
  for (let i = 0; i + DUP_WINDOW <= lines.length; i++) w.push(lines.slice(i, i + DUP_WINDOW).join("\n"));
  return w;
}

/** How many of `target`'s lines sit in a window that also appears in `others`, or at another place in `target` itself. */
export function duplicatedLines(target: string[], others: Set<string>): number {
  const ws = windows(target);
  const own = new Map<string, number>();
  for (const w of ws) own.set(w, (own.get(w) ?? 0) + 1);
  const covered = new Set<number>();
  ws.forEach((w, i) => {
    if (others.has(w) || (own.get(w) ?? 0) > 1) for (let k = 0; k < DUP_WINDOW; k++) covered.add(i + k);
  });
  return covered.size;
}

export interface ChangedFileText { path: string; before: string | undefined; after: string }

/**
 * Pure: the changed files' text before and after, and the text of the other files, in; the figures out. `others` must not contain the
 * changed files themselves, or every line would repeat against its own old copy.
 */
export function measureDuplication(changed: ChangedFileText[], others: string[], cut = false): DuplicationSummary {
  const set = new Set<string>();
  for (const text of others) for (const w of windows(normalizeLines(text))) set.add(w);
  let before = 0, after = 0, checked = 0;
  for (const f of changed) {
    const a = normalizeLines(f.after);
    checked += a.length;
    after += duplicatedLines(a, set);
    if (f.before !== undefined) before += duplicatedLines(normalizeLines(f.before), set);
  }
  return { before, after, linesChecked: checked, filesCompared: others.length, cut };
}

/** Reads the project's other code files, bounded. `exclude` holds project-relative paths with forward slashes. */
export function readCorpus(root: string, exclude: Set<string>): { texts: string[]; cut: boolean } {
  const texts: string[] = [];
  let bytes = 0, cut = false;
  const walk = (dir: string): void => {
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const name of names) {
      if (cut) return;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { if (!name.startsWith(".") && !SKIP_DIRS.has(name)) walk(full); continue; }
      if (!CODE_EXT.has(extname(name)) || st.size > MAX_FILE_BYTES) continue;
      const rel = relative(root, full).split(sep).join("/");
      if (exclude.has(rel)) continue;
      if (texts.length >= MAX_FILES || bytes + st.size > MAX_TOTAL_BYTES) { cut = true; return; }
      try { texts.push(readFileSync(full, "utf-8")); bytes += st.size; } catch { /* unreadable: left out */ }
    }
  };
  walk(root);
  return { texts, cut };
}

/** The check for one verification: the files this change writes, against the rest of the project on disk. Never throws; null when nothing was measurable. */
export function measureChangeDuplication(changes: { path: string; new_content: string }[], targetDir: string): DuplicationSummary | null {
  try {
    const code = changes.filter((c) => CODE_EXT.has(extname(c.path)) && !/(^|\/)(test|tests|__tests__)\//.test(c.path) && !/\.(test|spec)\.[a-z]+$/.test(c.path));
    if (code.length === 0) return null;
    const changed: ChangedFileText[] = code.map((c) => {
      let before: string | undefined;
      try { before = readFileSync(join(targetDir, c.path), "utf-8"); } catch { before = undefined; }
      return { path: c.path, before, after: c.new_content };
    });
    const { texts, cut } = readCorpus(targetDir, new Set(code.map((c) => c.path.split(sep).join("/"))));
    return measureDuplication(changed, texts, cut);
  } catch {
    return null;
  }
}

/** One plain sentence for a person, or null when the figure says nothing. */
export function duplicationNote(d: DuplicationSummary | undefined): string | null {
  if (!d || d.linesChecked === 0) return null;
  const delta = d.after - d.before;
  const move = delta > 0 ? `${delta} more than before the change` : delta < 0 ? `${-delta} fewer than before the change` : "the same as before the change";
  return `${d.after} of ${d.linesChecked} code lines in the changed files sit in a block of ${DUP_WINDOW}+ lines that repeats elsewhere in the project (${move})${d.cut ? "; the project was too large to read in full, so this is a lower bound" : ""}. A finder of repeated code, not a verdict.`;
}
