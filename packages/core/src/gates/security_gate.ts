// src/gates/security_gate.ts
import { scanForSecrets } from "../security/secrets.js";
import type { SecretFinding } from "../security/secrets.js";
import { recordOverrideAudit } from "../security/override_audit.js";

export type SecuritySeverity = "Critical" | "High" | "Medium" | "Low";

export interface SecurityFindingItem {
  path: string;
  line: number;
  category: string;
  severity: SecuritySeverity;
  message: string;
}

export interface SecurityGateResult {
  ok: boolean;
  findings: SecurityFindingItem[];
  blocked: boolean;
  reason?: string;
}

const SQL_INJECTION_RE = /(query|execute|run)\s*\(\s*['"`].*(\+|\$\{)/i;
const COMMAND_INJECTION_RE = /\b(exec|spawn|execSync|spawnSync|eval)\s*\([^)]*(\+|`|\$\{)/;
const WEAK_CRYPTO_RE = /createHash\s*\(\s*['"](md5|sha1)['"]\s*\)|createCipher\(|createDecipher\(/i;
const UNSAFE_DESERIALIZATION_RE = /vm\.runInNewContext|eval\s*\(/;

const PYTHON_SQL_INJECTION_RE = /\.execute\s*\(\s*(f['"].*\{|['"].*%|['"].*\+)/i;
const PYTHON_WEAK_CRYPTO_RE = /hashlib\.(md5|sha1)/i;
const PYTHON_UNSAFE_DESERIALIZATION_RE = /pickle\.loads|yaml\.load\b/i;

const TOP_PACKAGES = [
  "lodash", "express", "react", "commander", "typescript", "axios", "debug", "uuid", "dotenv", "zod", "chalk", "tsx", "turbo", "node", "jest", "vitest", "mocha"
];

function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [];
    for (let j = 0; j <= a.length; j++) {
      if (i === 0) matrix[i]![j] = j;
      else if (j === 0) matrix[i]![j] = i;
      else if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i]![j] = matrix[i - 1]![j - 1]!;
      } else {
        matrix[i]![j] = Math.min(
          matrix[i - 1]![j - 1]! + 1,
          matrix[i]![j - 1]! + 1,
          matrix[i - 1]![j]! + 1
        );
      }
    }
  }
  return matrix[b.length]![a.length]!;
}

export const GOLDEN_CORPUS: { name: string; code: string; shouldBlock: boolean; severity: SecuritySeverity }[] = [
  {
    name: "Safe SQL query",
    code: 'db.prepare("SELECT * FROM users WHERE id = ?").get(id);',
    shouldBlock: false,
    severity: "Low",
  },
  {
    name: "SQL injection with string concat",
    code: 'db.query("SELECT * FROM users WHERE name = " + userInput);',
    shouldBlock: true,
    severity: "Critical",
  },
  {
    name: "Hardcoded secret",
    code: 'const apiKey = "AKIAIOSFODNN7EXAMPLE";',
    shouldBlock: true,
    severity: "Critical",
  },
  {
    name: "Weak crypto MD5",
    code: 'const hash = crypto.createHash("md5").update(data).digest("hex");',
    shouldBlock: true,
    severity: "High",
  },
];

let invocationSecurityOverride: string | undefined = undefined;

export function setSecurityOverride(reason?: string): void {
  invocationSecurityOverride = reason;
}

export function runSecurityGate(
  files: { path: string; content: string }[],
  overrideReasonParam?: string
): SecurityGateResult {
  const findings: SecurityFindingItem[] = [];

  // 1. Secret scan (reusing security/secrets.ts) — always Critical
  const secretFindings = scanForSecrets(files);
  for (const sf of secretFindings) {
    findings.push({
      path: sf.path,
      line: sf.line,
      category: "Hardcoded Secret",
      severity: "Critical",
      message: `Hardcoded secret detected (${sf.reason}): ${sf.match}`,
    });
  }

  // 2. Pattern-based code checks
  for (const file of files) {
    const lines = file.content.split("\n");
    lines.forEach((line, idx) => {
      const lineNo = idx + 1;

      if (SQL_INJECTION_RE.test(line)) {
        findings.push({
          path: file.path,
          line: lineNo,
          category: "SQL Injection",
          severity: "Critical",
          message: `Potential SQL injection via string concatenation or template interpolation.`,
        });
      }

      if (COMMAND_INJECTION_RE.test(line) && !line.includes("process.execPath")) {
        findings.push({
          path: file.path,
          line: lineNo,
          category: "Command/Code Injection",
          severity: "Critical",
          message: `Potential command or code injection pattern.`,
        });
      }

      if (WEAK_CRYPTO_RE.test(line)) {
        findings.push({
          path: file.path,
          line: lineNo,
          category: "Weak Cryptography",
          severity: "High",
          message: `Use of known-weak cryptographic primitive (MD5/SHA1 or legacy cipher).`,
        });
      }

      if (UNSAFE_DESERIALIZATION_RE.test(line)) {
        findings.push({
          path: file.path,
          line: lineNo,
          category: "Unsafe Deserialization / Evaluation",
          severity: "High",
          message: `Use of unsafe evaluation or deserialization method.`,
        });
      }

      if (file.path.endsWith(".py")) {
        if (PYTHON_SQL_INJECTION_RE.test(line)) {
          findings.push({
            path: file.path,
            line: lineNo,
            category: "SQL Injection",
            severity: "Critical",
            message: `Potential Python SQL injection via string formatting or concatenation.`,
          });
        }
        if (PYTHON_WEAK_CRYPTO_RE.test(line)) {
          findings.push({
            path: file.path,
            line: lineNo,
            category: "Weak Cryptography",
            severity: "High",
            message: `Use of known-weak Python cryptographic primitive (hashlib.md5/sha1).`,
          });
        }
        if (PYTHON_UNSAFE_DESERIALIZATION_RE.test(line)) {
          findings.push({
            path: file.path,
            line: lineNo,
            category: "Unsafe Deserialization / Evaluation",
            severity: "High",
            message: `Use of unsafe Python deserialization (pickle.loads/yaml.load).`,
          });
        }
      }
    });

    // 3. Dependency / Manifest checks (package.json)
    if (file.path.endsWith("package.json")) {
      try {
        const pkg = JSON.parse(file.content);
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        for (const depName of Object.keys(allDeps)) {
          // Typosquat check
          for (const topPkg of TOP_PACKAGES) {
            if (depName !== topPkg) {
              const dist = levenshteinDistance(depName, topPkg);
              if (dist > 0 && dist <= 2 && depName.length >= 4) {
                findings.push({
                  path: file.path,
                  line: 1,
                  category: "Typosquatting Risk",
                  severity: "High",
                  message: `Dependency "${depName}" is suspiciously close to popular package "${topPkg}" (edit distance ${dist}).`,
                });
              }
            }
          }
        }
      } catch {
        // invalid JSON package.json handled elsewhere or ignored here
      }
    }
  }

  const blockingFindings = findings.filter((f) => f.severity === "Critical" || f.severity === "High");
  let blocked = blockingFindings.length > 0;
  let reason = blocked
    ? `Security gate blocked changes due to ${blockingFindings.length} Critical/High severity finding(s): ${blockingFindings.map((f) => `${f.category} in ${f.path}:${f.line}`).join(", ")}`
    : undefined;

  const activeOverride = overrideReasonParam !== undefined ? overrideReasonParam : invocationSecurityOverride;
  if (blocked && activeOverride !== undefined) {
    const overrideReason = activeOverride;
    invocationSecurityOverride = undefined;
    recordOverrideAudit("SecurityGate", overrideReason, reason ?? "Critical/High security finding");
    console.log(`  [override] SecurityGate overridden: ${overrideReason.trim()}`);
    blocked = false;
    reason = undefined;
  }

  return {
    ok: !blocked,
    findings,
    blocked,
    reason,
  };
}
