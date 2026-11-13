// src/verify/anchor_match.ts
//
// AI-06. Finds a model-written anchor in a file and replaces it. Pure: no I/O, no clock, no environment.
//
// A model copies an anchor out of a prompt it was shown, and copying is where small differences creep in: a CRLF file shown
// as LF, a trailing space dropped, a tab turned into spaces. Failing the whole edit for those sends the run down the most
// expensive path, so the matcher tries progressively looser readings of the same text, in a fixed order:
//
//   1. exact              the anchor as written (today's behaviour, byte for byte)
//   2. eol                the same text with line endings normalised; the replacement is converted to the file's own style
//   3. trailing_space     line by line, ignoring spaces and tabs at the end of each line
//   4. indent             line by line, ignoring indentation; the replacement is re-indented by the difference
//   5. blank_lines        line by line, ignoring blank lines on both sides (indentation still counts, so Python stays safe)
//
// Each stage must match exactly once. Zero matches moves to the next stage. Two or more is a refusal, never a guess, and it
// lists where. Indentation-insensitive matching is off for Python, YAML and Makefiles, where depth carries meaning.
// When nothing matches, the error carries the nearest region so a retry can see what differs.

export type AnchorStage = "exact" | "eol" | "trailing_space" | "indent" | "blank_lines";

export type AnchorResult =
  /** `partialLine`: an exact match that starts or ends in the middle of a line, so text of that line outside the anchor stays (research 04: a truncated anchor leaves its tail). A warning, never a block. */
  | { ok: true; content: string; stage: AnchorStage; partialLine?: boolean }
  | { ok: false; reason: string; ambiguous: boolean };

const MAX_NEAREST_LINES = 12;
const MAX_LINE_CHARS = 160;
const MAX_WINDOW_LINES = 200;

/** Languages and formats where leading whitespace is syntax, so indentation may not be ignored. */
export function indentMatters(path: string): boolean {
  const base = path.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
  return /\.(py|pyi|pyw|ya?ml|mk)$/.test(base) || base === "makefile" || base === "gnumakefile";
}

interface Line {
  /** Text without its terminator. */
  text: string;
  /** Offset of the first character. */
  start: number;
  /** Offset just past the text, before the terminator. */
  end: number;
  /** Offset just past the terminator (equals `end` when the line has none). */
  next: number;
}

function splitLines(content: string): Line[] {
  const lines: Line[] = [];
  let pos = 0;
  while (pos <= content.length) {
    const nl = content.indexOf("\n", pos);
    if (nl === -1) {
      if (pos < content.length) lines.push({ text: content.slice(pos), start: pos, end: content.length, next: content.length });
      break;
    }
    const end = nl > pos && content[nl - 1] === "\r" ? nl - 1 : nl;
    lines.push({ text: content.slice(pos, end), start: pos, end, next: nl + 1 });
    pos = nl + 1;
  }
  return lines;
}

/** The file's dominant line ending. A file with no line breaks, or a tie, is treated as LF. */
export function dominantEol(content: string): "\r\n" | "\n" {
  let crlf = 0;
  let lf = 0;
  for (let i = content.indexOf("\n"); i !== -1; i = content.indexOf("\n", i + 1)) {
    if (i > 0 && content[i - 1] === "\r") crlf++;
    else lf++;
  }
  return crlf > lf ? "\r\n" : "\n";
}

const toLf = (s: string): string => s.replace(/\r\n/g, "\n");
const toStyle = (s: string, eol: "\r\n" | "\n"): string => (eol === "\r\n" ? toLf(s).replace(/\n/g, "\r\n") : toLf(s));

function lineNumbers(nums: number[]): string {
  return nums.slice(0, 3).join(", ") + (nums.length > 3 ? ", ..." : "");
}

function ambiguous(count: number, lines: number[], what: string): AnchorResult {
  return { ok: false, ambiguous: true, reason: `${what} found ${count} times (first at line ${lineNumbers(lines)}) — ambiguous, refusing to guess which one` };
}

function lineOf(content: string, offset: number): number {
  let n = 1;
  for (let i = content.indexOf("\n"); i !== -1 && i < offset; i = content.indexOf("\n", i + 1)) n++;
  return n;
}

/**
 * True when `newText` already stands in `content` around the one place `oldText` was found at `at`. That can only be so when the
 * new text still contains the old text (an insertion or an extension), which is also the only case where a second application
 * of the same edit succeeds: "x = 1" -> "x = 1; y = 2" replayed gave "x = 1; y = 2; y = 2" (research 04, E7). The new text
 * elsewhere in the file does not count; only the same spot does.
 */
function alreadyApplied(content: string, at: number, oldText: string, newText: string): boolean {
  if (newText.length <= oldText.length) return false;
  for (let k = newText.indexOf(oldText); k !== -1; k = newText.indexOf(oldText, k + 1)) {
    const start = at - k;
    if (start >= 0 && content.startsWith(newText, start)) return true;
  }
  return false;
}

// ---- stage 1 --------------------------------------------------------------------------------------------------------------

function exact(content: string, oldText: string, newText: string): AnchorResult | null {
  const occurrences = oldText.length === 0 ? 0 : content.split(oldText).length - 1;
  if (occurrences === 0) return null;
  if (occurrences > 1) {
    const at: number[] = [];
    for (let i = content.indexOf(oldText); i !== -1 && at.length < 3; i = content.indexOf(oldText, i + oldText.length)) at.push(lineOf(content, i));
    return ambiguous(occurrences, at, "anchor text");
  }
  const at = content.indexOf(oldText);
  if (alreadyApplied(content, at, oldText, newText)) {
    return {
      ok: false,
      ambiguous: false,
      reason: `the replacement is already in place at line ${lineOf(content, at)} (the file already holds the new text around this anchor), so applying it again would duplicate it`,
    };
  }
  // Function form: a string second argument would treat $&, $$ and $1 in newText as patterns.
  const end = at + oldText.length;
  // F04-04: the anchor stopped short of the end of its line and the replacement already ends with the , or ; that follows it, so the join
  // would double it (a truncated anchor with a replacement written for the whole line). Never what an edit means; refused, not guessed.
  const next = content[end];
  if ((next === "," || next === ";") && newText.endsWith(next) && !oldText.endsWith(next)) {
    return {
      ok: false,
      ambiguous: false,
      reason: `the replacement already ends with the "${next}" that follows the anchor at line ${lineOf(content, at)}, so applying it would write "${next}${next}". The anchor stops short of the end of its line: anchor the whole line, or leave the "${next}" off the replacement`,
    };
  }
  // C3: "inside a line" means NON-WHITESPACE text of the line stays outside the anchor. An anchor that leaves only the line's
  // indentation or trailing blanks behind is the ordinary way to edit a statement and says nothing worth a note.
  // H4: a UTF-8 byte-order mark in front of line 1 is not text of that line.
  const bomOffset = content.charCodeAt(0) === 0xfeff ? 1 : 0;
  const lineStart = Math.max(content.lastIndexOf("\n", at - 1) + 1, bomOffset);
  const startsMidLine = at > bomOffset && content[at - 1] !== "\n" && /[^ \t]/.test(content.slice(lineStart, at));
  const lineEndNl = content.indexOf("\n", end);
  const restOfLine = content.slice(end, lineEndNl === -1 ? content.length : lineEndNl);
  const endsMidLine = end < content.length && content[end] !== "\n" && content[end] !== "\r" && !oldText.endsWith("\n") && /[^ \t\r]/.test(restOfLine);
  // H4 / research 04: a replacement written with bare "\n" must not put LF into a CRLF region. The region's style is the anchor's own
  // when it spans a line break, otherwise the file's dominant style. An anchor that is LF-only keeps LF (a mixed file stays as it was).
  const crlfRegion = oldText.includes("\r\n") || (!oldText.includes("\n") && dominantEol(content) === "\r\n");
  const replacement = crlfRegion ? toStyle(newText, "\r\n") : newText;
  return {
    ok: true,
    content: content.replace(oldText, () => replacement),
    stage: "exact",
    ...(startsMidLine || endsMidLine ? { partialLine: true } : {}),
  };
}

// ---- stage 2 --------------------------------------------------------------------------------------------------------------

function eolNormalised(content: string, oldText: string, newText: string): AnchorResult | null {
  const normOld = toLf(oldText);
  if (normOld.length === 0) return null;
  // Normalised content, with for each normalised character the original span it came from.
  const from: number[] = [];
  const to: number[] = [];
  let norm = "";
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\r" && content[i + 1] === "\n") continue; // the "\n" that follows carries the pair
    norm += content[i];
    from.push(content[i] === "\n" && i > 0 && content[i - 1] === "\r" ? i - 1 : i);
    to.push(i + 1);
  }
  const hits: number[] = [];
  for (let i = norm.indexOf(normOld); i !== -1; i = norm.indexOf(normOld, i + normOld.length)) hits.push(i);
  if (hits.length === 0) return null;
  if (hits.length > 1) return ambiguous(hits.length, hits.slice(0, 3).map((h) => lineOf(content, from[h]!)), "anchor text (ignoring line endings)");
  const s = from[hits[0]!]!;
  const e = to[hits[0]! + normOld.length - 1]!;
  const eol = dominantEol(content);
  return { ok: true, content: content.slice(0, s) + toStyle(newText, eol) + content.slice(e), stage: "eol" };
}

// ---- stages 3 and 4 -------------------------------------------------------------------------------------------------------

function lineWise(
  content: string, oldText: string, newText: string, stage: "trailing_space" | "indent",
): AnchorResult | null {
  const key = stage === "trailing_space" ? (l: string) => l.replace(/[ \t]+$/, "") : (l: string) => l.trim();
  const oldLf = toLf(oldText);
  const endsWithNewline = oldLf.endsWith("\n");
  const oldLines = (endsWithNewline ? oldLf.slice(0, -1) : oldLf).split("\n");
  if (oldLines.every((l) => l.trim() === "")) return null; // an anchor of nothing but blank lines identifies nothing
  const fileLines = splitLines(content);
  const wanted = oldLines.map(key);
  const hits: number[] = [];
  for (let i = 0; i + wanted.length <= fileLines.length; i++) {
    let all = true;
    for (let j = 0; j < wanted.length; j++) {
      if (key(fileLines[i + j]!.text) !== wanted[j]) { all = false; break; }
    }
    if (all) hits.push(i);
  }
  if (hits.length === 0) return null;
  const what = stage === "trailing_space" ? "anchor text (ignoring trailing whitespace)" : "anchor text (ignoring indentation)";
  if (hits.length > 1) return ambiguous(hits.length, hits.slice(0, 3).map((h) => h + 1), what);

  const first = fileLines[hits[0]!]!;
  const last = fileLines[hits[0]! + wanted.length - 1]!;
  const spanEnd = endsWithNewline ? last.next : last.end;
  const eol = dominantEol(content);
  let replacement = toStyle(newText, eol);
  if (stage === "indent") {
    const leading = (l: string) => /^[ \t]*/.exec(l)![0];
    const firstReal = oldLines.find((l) => l.trim() !== "")!;
    const oldIndent = leading(firstReal);
    const fileIndent = leading(fileLines[hits[0]! + oldLines.indexOf(firstReal)]!.text);
    replacement = replacement
      .split(eol)
      .map((l) => (l.trim() !== "" && l.startsWith(oldIndent) ? fileIndent + l.slice(oldIndent.length) : l))
      .join(eol);
  }
  return { ok: true, content: content.slice(0, first.start) + replacement + content.slice(spanEnd), stage };
}

// ---- stage 5 --------------------------------------------------------------------------------------------------------------

/** Blank lines inside the anchor that the file lacks (or the reverse). Compares the non-blank lines only, one after another. */
function blankLines(content: string, oldText: string, newText: string): AnchorResult | null {
  const key = (l: string) => l.replace(/[ \t]+$/, "");
  const oldLf = toLf(oldText);
  const endsWithNewline = oldLf.endsWith("\n");
  const wanted = (endsWithNewline ? oldLf.slice(0, -1) : oldLf).split("\n").map(key).filter((l) => l.trim() !== "");
  if (wanted.length < 2) return null; // one real line has no blank line "inside" it; the earlier stages cover it
  const fileLines = splitLines(content);
  const real: number[] = [];
  fileLines.forEach((l, i) => { if (l.text.trim() !== "") real.push(i); });
  const hits: number[] = [];
  for (let i = 0; i + wanted.length <= real.length; i++) {
    let all = true;
    for (let j = 0; j < wanted.length; j++) {
      if (key(fileLines[real[i + j]!]!.text) !== wanted[j]) { all = false; break; }
    }
    if (all) hits.push(i);
  }
  if (hits.length === 0) return null;
  if (hits.length > 1) return ambiguous(hits.length, hits.slice(0, 3).map((h) => real[h]! + 1), "anchor text (ignoring blank lines)");
  const first = fileLines[real[hits[0]!]!]!;
  const last = fileLines[real[hits[0]! + wanted.length - 1]!]!;
  const spanEnd = endsWithNewline ? last.next : last.end;
  return { ok: true, content: content.slice(0, first.start) + toStyle(newText, dominantEol(content)) + content.slice(spanEnd), stage: "blank_lines" };
}

// ---- nearest region -------------------------------------------------------------------------------------------------------

/** The best window of the file against the anchor, by count of equal trimmed lines. Null when nothing is even close. */
export function nearestRegion(content: string, oldText: string): string | null {
  const oldLines = toLf(oldText).replace(/\n$/, "").split("\n").map((l) => l.trim()).slice(0, MAX_WINDOW_LINES);
  const real = oldLines.filter((l) => l !== "").length;
  if (real === 0) return null;
  const fileLines = splitLines(content);
  if (fileLines.length === 0) return null;
  const trimmed = fileLines.map((l) => l.text.trim());
  const k = Math.min(oldLines.length, fileLines.length);
  let best = -1;
  let bestAt = 0;
  for (let i = 0; i + k <= fileLines.length; i++) {
    let score = 0;
    for (let j = 0; j < k; j++) if (oldLines[j] !== "" && trimmed[i + j] === oldLines[j]) score++;
    if (score > best) { best = score; bestAt = i; }
  }
  if (best <= 0) return null;
  const from = Math.max(0, bestAt - 1);
  const to = Math.min(fileLines.length, bestAt + k + 1);
  const shown = fileLines.slice(from, Math.min(to, from + MAX_NEAREST_LINES));
  const body = shown.map((l, idx) => `${String(from + idx + 1).padStart(4)}| ${l.text.length > MAX_LINE_CHARS ? l.text.slice(0, MAX_LINE_CHARS) + "…" : l.text}`).join("\n");
  const more = to - from > shown.length ? `\n      ... (${to - from - shown.length} more line(s))` : "";
  return `Nearest region, lines ${bestAt + 1}-${bestAt + k} (${best} of ${real} anchor line(s) match after trimming):\n${body}${more}`;
}

// ---- entry point ----------------------------------------------------------------------------------------------------------

/**
 * Replaces the one place `oldText` occurs in `content`. `path` decides whether indentation may be ignored.
 * On success, `stage` says which reading matched (anything other than "exact" is a rescue worth counting).
 */
export function matchAnchor(content: string, oldText: string, newText: string, path: string): AnchorResult {
  const stages: Array<() => AnchorResult | null> = [
    () => exact(content, oldText, newText),
    () => eolNormalised(content, oldText, newText),
    () => lineWise(content, oldText, newText, "trailing_space"),
  ];
  if (!indentMatters(path)) stages.push(() => lineWise(content, oldText, newText, "indent"));
  stages.push(() => blankLines(content, oldText, newText));
  for (const run of stages) {
    const r = run();
    if (r) return r;
  }
  const near = nearestRegion(content, oldText);
  return { ok: false, ambiguous: false, reason: `anchor text not found in file${near ? `.\n${near}` : " (no similar region found)"}` };
}
