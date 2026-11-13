// packages/core/src/verify/failure_shape.ts
//
// AI-08 (PURIX-33): turn raw verifier output into the short, classified text a repair prompt should carry.
//
// Pure module: no file access, no model call, no environment. The caller passes the raw tool output, the paths the
// patch touched and the current contents of those files. Nothing here is wired into the repair loop yet; that is
// AI-12, which feeds `text` into the repair prompt and `errorClass` into the attempt ledger.
//
// Why shape at all. Raw `tsc -p` output lists every error in the project. A repair round that sees errors in files
// it may not edit chases them (D-AI-3), and a 200-error dump is thousands of tokens of noise. So:
//  - tsc: up to eight errors from the touched files only, two lines of code around each of the first three, and a
//    one-line count of what was left out ("N more errors in other files"), never their detail.
//  - pytest: the FAILED/ERROR lines and the `E` lines, nothing else.
//  - anything else: the first and last 2,000 characters with a cut marker.
//
// The classes are coarse on purpose. They exist so the ledger can say "same class at the same place twice" and so
// call-record analysis can count how often each kind of failure happens.

export type FailureClass = "syntax" | "name" | "type" | "test_assertion" | "test_error" | "timeout" | "other";

export interface ShapeInput {
  /** Paths the patch touched, as the verifier reports them or relative to the project root. */
  touchedPaths: string[];
  /** Current (candidate) contents, used only for the code context under the first errors. */
  files: { path: string; content: string }[];
}

/** A place in a file that a verifier named. `line` is 1-based. */
export interface FailureLocation {
  path: string;
  line: number;
}

export interface ShapedFailure {
  errorClass: FailureClass;
  /** One line naming the error that decided the class, or null when the output had no recognisable error. */
  primary: string | null;
  /** The text to put in the repair prompt. */
  text: string;
  /**
   * AI-12: where the verifier pointed, in the order it reported them, at most MAX_LOCATIONS, no repeats. Empty when the
   * output named no file and line. Paths are as the verifier printed them; match them to files with `samePath`.
   */
  locations: FailureLocation[];
}

export const MAX_LOCATIONS = 8;

/** Hard ceiling for any shaped text. A 200-error tsc dump must come out under 4,500 characters. */
export const SHAPED_TEXT_MAX_CHARS = 4400;
export const MAX_TSC_ERRORS_SHOWN = 8;
export const TSC_CONTEXT_ERRORS = 3;
const MAX_ERROR_MESSAGE_CHARS = 300;
const MAX_CONTEXT_LINE_CHARS = 160;
const PASSTHROUGH_MAX_CHARS = 4000;
const HEAD_TAIL_CHARS = 2000;
const MAX_PYTEST_LINES = 40;
const MAX_PYTEST_LINE_CHARS = 300;

// TS1xxx are syntax errors. These are the "something is not defined / cannot be found" errors.
const NAME_CODES = new Set(["TS2304", "TS2305", "TS2307", "TS2552"]);

const ANSI = /\u001b\[[0-9;]*m/g;
const TSC_PLAIN = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const TSC_PRETTY = /^(.+?):(\d+):(\d+) - error (TS\d+): (.*)$/;
const TSC_NO_FILE = /^error (TS\d+): (.*)$/;

interface TscError {
  path: string;
  line: number;
  col: number;
  code: string;
  message: string;
}

function normalizePath(p: string): string {
  let out = p.replace(/\\/g, "/").trim();
  while (out.startsWith("./")) out = out.slice(2);
  return out;
}

/** True when two paths name the same file, allowing one side to carry extra leading directories. */
export function samePath(a: string, b: string): boolean {
  const x = normalizePath(a);
  const y = normalizePath(b);
  if (x === "" || y === "") return false;
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Joins body lines and trailer lines under SHAPED_TEXT_MAX_CHARS. Body lines are dropped from the end (whole lines,
 * never mid-line) until the trailer fits, so a closing note such as "N more errors in other files" is never the part
 * that gets cut.
 */
function assemble(body: string[], trailer: string[]): string {
  const tail = trailer.join("\n");
  const budget = SHAPED_TEXT_MAX_CHARS - (tail === "" ? 0 : tail.length + 1);
  const kept: string[] = [];
  let used = 0;
  for (const line of body) {
    const next = used + line.length + (kept.length > 0 ? 1 : 0);
    if (next > budget) break;
    kept.push(line);
    used = next;
  }
  const dropped = body.length - kept.length;
  const lines = [...kept, ...(dropped > 0 ? [`[... ${dropped} more line${dropped === 1 ? "" : "s"} cut ...]`] : []), ...trailer];
  return cut(lines.join("\n"), SHAPED_TEXT_MAX_CHARS);
}

function parseTsc(raw: string): TscError[] {
  const lines = raw.replace(ANSI, "").split(/\r?\n/);
  const errors: TscError[] = [];
  let current: TscError | null = null;
  for (const line of lines) {
    const plain = TSC_PLAIN.exec(line) ?? TSC_PRETTY.exec(line);
    if (plain) {
      current = { path: normalizePath(plain[1]!), line: Number(plain[2]), col: Number(plain[3]), code: plain[4]!, message: plain[5]!.trim() };
      errors.push(current);
      continue;
    }
    const bare = TSC_NO_FILE.exec(line);
    if (bare) {
      current = { path: "", line: 0, col: 0, code: bare[1]!, message: bare[2]!.trim() };
      errors.push(current);
      continue;
    }
    // tsc continues a message on indented lines ("  Type 'x' is not assignable to type 'y'.").
    if (current && /^\s+\S/.test(line)) {
      current.message = `${current.message} ${line.trim()}`;
      continue;
    }
    current = null;
  }
  return errors;
}

function classOfTscCode(code: string): FailureClass {
  if (/^TS1\d{3}$/.test(code)) return "syntax";
  if (NAME_CODES.has(code)) return "name";
  if (/^TS2\d{3}$/.test(code)) return "type";
  return "other";
}

function formatTscError(e: TscError): string {
  const where = e.path === "" ? "" : `${e.path}(${e.line},${e.col}): `;
  return `${where}error ${e.code}: ${cut(e.message, MAX_ERROR_MESSAGE_CHARS)}`;
}

function codeContext(e: TscError, files: ShapeInput["files"]): string[] {
  if (e.path === "" || e.line < 1) return [];
  const file = files.find((f) => samePath(f.path, e.path));
  if (!file) return [];
  const lines = file.content.split(/\r?\n/);
  const out: string[] = [];
  for (const n of [e.line - 1, e.line]) {
    if (n < 1 || n > lines.length) continue;
    out.push(`  ${String(n).padStart(4)} | ${cut(lines[n - 1]!, MAX_CONTEXT_LINE_CHARS)}`);
  }
  return out;
}

function addLocations(into: FailureLocation[], more: FailureLocation[]): FailureLocation[] {
  for (const l of more) {
    if (into.length >= MAX_LOCATIONS) break;
    if (!into.some((x) => x.path === l.path && x.line === l.line)) into.push(l);
  }
  return into;
}

// "src/a.py:42: AssertionError", "at f (src/a.ts:10:5)", "src/a.js:3". Only source-looking extensions, so a URL or a version is not read as a place.
const FILE_LINE = /([A-Za-z0-9_@./\\-]+\.(?:tsx?|jsx?|mjs|cjs|py)):(\d+)(?::\d+)?/g;

/** Locations named anywhere in plain output (pytest tracebacks, node stack traces). */
function scanLocations(raw: string): FailureLocation[] {
  const found: FailureLocation[] = [];
  for (const m of raw.replace(ANSI, "").matchAll(FILE_LINE)) {
    const line = Number(m[2]);
    if (line < 1) continue;
    const path = normalizePath(m[1]!);
    // Dependencies and the runtime are not files the repair may edit.
    if (/(^|\/)(node_modules|site-packages)\//.test(path) || path.startsWith("node:")) continue;
    addLocations(found, [{ path, line }]);
    if (found.length >= MAX_LOCATIONS) break;
  }
  return found;
}

function shapeTsc(errors: TscError[], input: ShapeInput): ShapedFailure {
  const touched = errors.filter((e) => input.touchedPaths.some((t) => samePath(t, e.path)));
  const others = errors.length - touched.length;
  const shown = touched.slice(0, MAX_TSC_ERRORS_SHOWN);
  // The class comes from the first error in a touched file, else the first error at all.
  const deciding = touched[0] ?? errors[0]!;

  const body: string[] = [];
  shown.forEach((e, i) => {
    body.push(formatTscError(e));
    if (i < TSC_CONTEXT_ERRORS) body.push(...codeContext(e, input.files));
  });
  const trailer: string[] = [];
  if (touched.length > shown.length) trailer.push(`${touched.length - shown.length} more errors in the files you edited.`);
  if (touched.length === 0) trailer.push("No errors were reported in the files you edited.");
  if (others > 0) trailer.push(`${others} more error${others === 1 ? "" : "s"} in other files (not shown; do not edit other files to fix them).`);

  const locations = addLocations([], shown.filter((e) => e.path !== "" && e.line >= 1).map((e) => ({ path: e.path, line: e.line })));
  return { errorClass: classOfTscCode(deciding.code), primary: formatTscError(deciding), text: assemble(body, trailer), locations };
}

function classifyText(raw: string, pytest: boolean): FailureClass {
  if (/timed out|timeout|ETIMEDOUT|TimeoutError/i.test(raw)) return "timeout";
  if (/\b(SyntaxError|IndentationError|TabError)\b/.test(raw)) return "syntax";
  if (/\b(NameError|ImportError|ModuleNotFoundError|ReferenceError)\b|Cannot find module/.test(raw)) return "name";
  if (/\bAssertionError\b|^E\s+assert\b|^\s*assert\b/m.test(raw)) return "test_assertion";
  return pytest ? "test_error" : "other";
}

function shapePytest(raw: string): ShapedFailure | null {
  const locations = scanLocations(raw);
  const lines = raw.replace(ANSI, "").split(/\r?\n/);
  const kept: string[] = [];
  let first: string | null = null;
  for (const line of lines) {
    if (/^(FAILED|ERROR) /.test(line) || /^E(\s|$)/.test(line)) {
      const trimmed = cut(line.trimEnd(), MAX_PYTEST_LINE_CHARS);
      kept.push(trimmed);
      if (first === null) first = trimmed;
    }
  }
  if (kept.length === 0) return null;
  return { errorClass: classifyText(kept.join("\n"), true), primary: first, text: assemble(kept.slice(0, MAX_PYTEST_LINES), kept.length > MAX_PYTEST_LINES ? [`[... ${kept.length - MAX_PYTEST_LINES} lines past the first ${MAX_PYTEST_LINES} not shown ...]`] : []), locations };
}

function shapeGeneric(raw: string): ShapedFailure {
  const text = raw.replace(ANSI, "").trim();
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? null;
  const errorClass = text === "" ? "other" : classifyText(text, false);
  const locations = scanLocations(text);
  if (text.length <= PASSTHROUGH_MAX_CHARS) {
    return { errorClass, primary: firstLine === null ? null : cut(firstLine.trim(), MAX_ERROR_MESSAGE_CHARS), text, locations };
  }
  const head = text.slice(0, HEAD_TAIL_CHARS);
  const tail = text.slice(text.length - HEAD_TAIL_CHARS);
  const omitted = text.length - head.length - tail.length;
  return {
    errorClass,
    primary: firstLine === null ? null : cut(firstLine.trim(), MAX_ERROR_MESSAGE_CHARS),
    text: `${head}\n[... ${omitted} characters cut ...]\n${tail}`,
    locations,
  };
}

/** Shapes one failed verification's raw output. Never throws; unrecognised output falls back to head and tail. */
export function shapeFailure(raw: string, input: ShapeInput): ShapedFailure {
  const text = typeof raw === "string" ? raw : "";
  const tsc = parseTsc(text);
  if (tsc.length > 0) return shapeTsc(tsc, input);
  const py = shapePytest(text);
  if (py) return py;
  return shapeGeneric(text);
}
