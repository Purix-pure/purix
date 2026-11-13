// packages/core/src/eval/mutations.ts
//
// AI-10 (PURIX-33): deterministic bug injection for the L1 apply-rate eval.
//
// A case is made from a real file: one site is changed (the "mutated" file), and the expected answer is the original
// file. The instruction is a plain description of the fix in words, never the verbatim text to search for, so a model
// has to locate the line the way it would for a real request. Same seed and same inputs give the same cases.
//
// Six operators: operator swap, boolean flip, off-by-one, dropped optional chain, one-site rename, constant change.
//
// Pure: callers pass file contents in; nothing here reads a file or the environment.

export type MutationOperator = "operator_swap" | "boolean_flip" | "off_by_one" | "optional_chain_drop" | "rename_one_site" | "constant_change";
export const MUTATION_OPERATORS: MutationOperator[] = ["operator_swap", "boolean_flip", "off_by_one", "optional_chain_drop", "rename_one_site", "constant_change"];

export interface EvalCase {
  id: string;
  operator: MutationOperator;
  path: string;
  /** The file with the bug in it. This is what the model is shown. */
  mutated: string;
  /** The expected result: the file before the bug was injected. */
  original: string;
  instruction: string;
  eol: "lf" | "crlf";
  lines: number;
  /** 1-based line that was changed. */
  line: number;
}

export interface SourceFile {
  path: string;
  content: string;
}

export interface GenerateOptions {
  count: number;
  seed: number;
  /** Share of cases (0-1) whose file is converted to CRLF, to measure what line-ending handling rescues. */
  crlfShare?: number;
  operators?: MutationOperator[];
}

// ---------------------------------------------------------------------------------------------------------------------

/** mulberry32: small, fast, and identical on every platform. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------

interface Site {
  operator: MutationOperator;
  line: number; // 0-based
  /** The bug-carrying line. */
  mutatedLine: string;
  /** What the instruction says. */
  instruction: (path: string, line1: number) => string;
}

const OP_NAMES: Record<string, string> = {
  "<": "strictly less than (<)",
  "<=": "less than or equal (<=)",
  ">": "strictly greater than (>)",
  ">=": "greater than or equal (>=)",
  "===": "strict equality (===)",
  "!==": "strict inequality (!==)",
  "&&": "logical AND (&&)",
  "||": "logical OR (||)",
};
const SWAP: Record<string, string> = { "<": "<=", "<=": "<", ">": ">=", ">=": ">", "===": "!==", "!==": "===", "&&": "||", "||": "&&" };

function inString(line: string, index: number): boolean {
  let single = false;
  let double = false;
  let tick = false;
  for (let i = 0; i < index; i++) {
    const c = line[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "'" && !double && !tick) single = !single;
    else if (c === '"' && !single && !tick) double = !double;
    else if (c === "`" && !single && !double) tick = !tick;
  }
  return single || double || tick;
}

function skippable(line: string): boolean {
  const t = line.trim();
  return t === "" || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("#") || /^(import|export\s+\*|export\s+\{[^}]*\}\s+from)\b/.test(t);
}

const isJsLike = (path: string) => /\.(?:[cm]?[jt]sx?)$/.test(path);

function findSites(file: SourceFile, operators: MutationOperator[], rng: () => number): Site[] {
  const lines = file.content.split(/\r?\n/);
  const sites: Site[] = [];
  const want = new Set(operators);

  // Identifier use counts for rename_one_site.
  const idCounts = new Map<string, number>();
  if (want.has("rename_one_site")) {
    for (const l of lines) {
      if (skippable(l)) continue;
      for (const m of l.matchAll(/\b[a-z_][A-Za-z0-9_]{3,}\b/g)) idCounts.set(m[0], (idCounts.get(m[0]) ?? 0) + 1);
    }
  }
  const keywords = new Set(["this", "that", "true", "false", "null", "undefined", "return", "const", "else", "from", "type", "void", "async", "await", "string", "number", "boolean", "function", "export", "import", "default", "throw", "catch", "while", "break", "continue", "static", "private", "public", "readonly", "interface", "class", "extends", "implements", "typeof", "instanceof", "new", "delete", "case", "switch", "yield", "let", "var", "for", "with", "when", "then", "none", "self", "def", "elif", "print", "pass", "lambda", "global"]);

  lines.forEach((line, i) => {
    if (skippable(line)) return;

    if (want.has("operator_swap")) {
      for (const m of line.matchAll(/ (<=|>=|===|!==|&&|\|\||<|>) /g)) {
        if (inString(line, m.index)) continue;
        const from = m[1]!;
        const to = SWAP[from]!;
        const at = m.index + 1;
        sites.push({
          operator: "operator_swap",
          line: i,
          mutatedLine: line.slice(0, at) + to + line.slice(at + from.length),
          instruction: (p, n) => `On line ${n} of ${p}, the condition uses ${OP_NAMES[to]} but it should use ${OP_NAMES[from]}.`,
        });
      }
    }

    if (want.has("boolean_flip")) {
      for (const m of line.matchAll(/\b(true|false)\b/g)) {
        if (inString(line, m.index)) continue;
        const from = m[1]!;
        const to = from === "true" ? "false" : "true";
        sites.push({
          operator: "boolean_flip",
          line: i,
          mutatedLine: line.slice(0, m.index) + to + line.slice(m.index + from.length),
          instruction: (p, n) => `On line ${n} of ${p}, the value should be ${from}, not ${to}.`,
        });
      }
    }

    if (want.has("off_by_one")) {
      for (const m of line.matchAll(/(?<![\w.$])(\d{1,3})(?![\w.])/g)) {
        if (inString(line, m.index)) continue;
        const from = Number(m[1]);
        const to = from > 1 && rng() < 0.5 ? from - 1 : from + 1;
        sites.push({
          operator: "off_by_one",
          line: i,
          mutatedLine: line.slice(0, m.index) + String(to) + line.slice(m.index + m[1]!.length),
          instruction: (p, n) => `On line ${n} of ${p}, the number ${to} is off by one; it should be ${from}.`,
        });
      }
    }

    if (want.has("optional_chain_drop") && isJsLike(file.path)) {
      for (const m of line.matchAll(/\?\.(?![[(])/g)) {
        if (inString(line, m.index)) continue;
        sites.push({
          operator: "optional_chain_drop",
          line: i,
          mutatedLine: line.slice(0, m.index) + "." + line.slice(m.index + 2),
          instruction: (p, n) => `On line ${n} of ${p}, the property access must use optional chaining (?.) so it does not throw when the value is missing.`,
        });
      }
    }

    if (want.has("constant_change")) {
      const m = /^(\s*(?:export\s+)?const\s+[A-Za-z_]\w*(?:\s*:\s*number)?\s*=\s*)(\d+)(\s*;?\s*)$/.exec(line);
      if (m) {
        const from = Number(m[2]);
        const to = from >= 10 ? from * 2 : from + 10;
        sites.push({
          operator: "constant_change",
          line: i,
          mutatedLine: `${m[1]}${to}${m[3]}`,
          instruction: (p, n) => `In ${p}, the constant defined on line ${n} should be ${from}, not ${to}.`,
        });
      }
    }

    if (want.has("rename_one_site")) {
      for (const m of line.matchAll(/\b[a-z_][A-Za-z0-9_]{3,}\b/g)) {
        const name = m[0];
        if (keywords.has(name) || (idCounts.get(name) ?? 0) < 3 || inString(line, m.index)) continue;
        // Skip the declaration itself so the typo is at a use site.
        if (new RegExp(`\\b(?:const|let|var|function|class)\\s+${name}\\b`).test(line)) continue;
        const wrong = `${name}s`;
        sites.push({
          operator: "rename_one_site",
          line: i,
          mutatedLine: line.slice(0, m.index) + wrong + line.slice(m.index + name.length),
          instruction: (p, n) => `On line ${n} of ${p}, "${wrong}" is a typo for "${name}".`,
        });
      }
    }
  });
  return sites;
}

// ---------------------------------------------------------------------------------------------------------------------

/** Makes up to `count` cases, spread round-robin over the operators and over the files. */
export function generateCases(files: SourceFile[], opts: GenerateOptions): EvalCase[] {
  const operators = opts.operators ?? MUTATION_OPERATORS;
  const crlfShare = opts.crlfShare ?? 0;
  const rng = makeRng(opts.seed);

  // Pool of candidate sites per operator, shuffled with the seed. Files are visited in path order, so the pool does
  // not depend on the order the caller listed them.
  const pools = new Map<MutationOperator, { file: SourceFile; site: Site }[]>();
  for (const op of operators) pools.set(op, []);
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const fileRng = makeRng(opts.seed ^ fnv(file.path));
    for (const site of findSites(file, operators, fileRng)) pools.get(site.operator)!.push({ file, site });
  }
  for (const op of operators) pools.set(op, shuffle(pools.get(op)!, rng));

  const cases: EvalCase[] = [];
  const used = new Set<string>();
  const perFile = new Map<string, number>();
  const maxPerFile = Math.max(2, Math.ceil(opts.count / Math.max(1, files.length)) + 1);
  let progressed = true;
  while (cases.length < opts.count && progressed) {
    progressed = false;
    for (const op of operators) {
      if (cases.length >= opts.count) break;
      const pool = pools.get(op)!;
      while (pool.length > 0) {
        const { file, site } = pool.shift()!;
        const key = `${file.path}:${site.line}`;
        if (used.has(key) || (perFile.get(file.path) ?? 0) >= maxPerFile) continue;
        used.add(key);
        perFile.set(file.path, (perFile.get(file.path) ?? 0) + 1);

        const lines = file.content.split(/\r?\n/);
        const mutatedLines = [...lines];
        mutatedLines[site.line] = site.mutatedLine;
        const useCrlf = rng() < crlfShare;
        const eolText = useCrlf ? "\r\n" : "\n";
        const toEol = (ls: string[]) => ls.join(eolText);
        const original = toEol(lines);
        const mutated = toEol(mutatedLines);
        if (mutated === original) continue;
        cases.push({
          id: `${op}-${fnv(file.path).toString(16)}-${site.line + 1}`,
          operator: op,
          path: file.path,
          original,
          mutated,
          instruction: site.instruction(file.path, site.line + 1),
          eol: useCrlf ? "crlf" : "lf",
          lines: lines.length,
          line: site.line + 1,
        });
        progressed = true;
        break;
      }
    }
  }
  return cases;
}
