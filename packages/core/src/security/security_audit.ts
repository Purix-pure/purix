// src/security/security_audit.ts

export interface SecurityFinding {
  path: string;
  line: number;
  category: "rate_limiting" | "input_validation" | "dangerous_eval";
  message: string;
}

const ROUTE_HANDLER_RE = /\.(get|post|put|patch|delete)\s*\(\s*['"`]/;
const RATE_LIMIT_HINT_RE = /rate.?limit|rateLimiter|express-rate-limit/i;
const VALIDATION_HINT_RE = /\.parse\(|\.safeParse\(|zod|joi\.|yup\./i;
const BODY_ACCESS_RE = /req\.(body|query|params)/;
// A call of the global eval, or `new Function(`. A method that happens to be called eval (`redis.eval(`, `model.eval()`, `db.eval(`) is not the
// global one, so a dot before the name only counts when it is the global object. Text in a comment or a string is not a call, so each line is
// reduced to its code first (see codeOnly).
const EVAL_RE = /(?<![\w$.])eval\s*\(|\b(?:window|globalThis|self|global)\.eval\s*\(|(?<![\w$.])new\s+Function\s*\(/;

/**
 * Reduces one line to its code: string and template literal contents and comments become blanks, so a rule cannot match text that is only text.
 * `inBlock` carries an open slash-star comment from one line to the next. Single-line only for strings, as the rest of this scanner is:
 * a multi-line template literal or a triple-quoted Python string is still read as code (a possible false positive, never a missed call).
 * `#` starts a comment only in Python-like files (hash), because in JavaScript it is a private-field marker.
 */
export function codeOnly(line: string, state: { inBlock: boolean }, hashComments: boolean): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    const two = line.slice(i, i + 2);
    if (state.inBlock) {
      if (two === "*/") { state.inBlock = false; i += 2; out += "  "; } else { i++; out += " "; }
      continue;
    }
    if (two === "/*") { state.inBlock = true; i += 2; out += "  "; continue; }
    if (two === "//" || (hashComments && c === "#")) break;
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < line.length && line[j] !== c) j += line[j] === "\\" ? 2 : 1;
      out += c + " ".repeat(Math.max(0, Math.min(j, line.length) - i - 1)) + (j < line.length ? c : "");
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Section 16 / Node 3a: heuristic pattern scanner, same honest tradeoff
 * as secrets.ts and idiom.ts — it will miss real gaps and occasionally
 * flag a false positive. UNLIKE secrets.ts, this NEVER blocks. It only
 * surfaces suggestions; applying a fix is always a separate, human
 * decision. Scoped to the files actually being changed, not the repo.
 */
export function auditSecurityPatterns(files: { path: string; content: string }[]): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  for (const file of files) {
    const lines = file.content.split("\n");
    const hasRateLimitHint = RATE_LIMIT_HINT_RE.test(file.content);
    const hasValidationHint = VALIDATION_HINT_RE.test(file.content);

    const hashComments = /\.(?:py|pyi|rb|sh|ya?ml)$/i.test(file.path);
    const blockState = { inBlock: false };
    lines.forEach((rawLine, i) => {
      const line = rawLine;
      const code = codeOnly(rawLine, blockState, hashComments);
      if (ROUTE_HANDLER_RE.test(line) && !hasRateLimitHint) {
        findings.push({
          path: file.path,
          line: i + 1,
          category: "rate_limiting",
          message: `Route handler with no rate-limiting pattern detected anywhere in this file. Consider express-rate-limit or equivalent.`,
        });
      }
      if (BODY_ACCESS_RE.test(line) && !hasValidationHint) {
        findings.push({
          path: file.path,
          line: i + 1,
          category: "input_validation",
          message: `Reads req.body/query/params with no validation pattern (zod/joi/yup) detected in this file.`,
        });
      }
      if (EVAL_RE.test(code)) {
        findings.push({
          path: file.path,
          line: i + 1,
          category: "dangerous_eval",
          message: `eval() or new Function() — arbitrary code execution risk. Almost always avoidable.`,
        });
      }
    });
  }

  return findings;
}