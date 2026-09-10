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
const EVAL_RE = /\beval\s*\(|new Function\s*\(/;

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

    lines.forEach((line, i) => {
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
      if (EVAL_RE.test(line)) {
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