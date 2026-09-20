// src/security/deps_audit.ts
import { spawnSync } from "../platform/spawn_sync.js";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface PinningFinding {
  name: string;
  declaredRange: string;
  section: "dependencies" | "devDependencies";
  reason: string;
}

/**
 * Section 8 Should-have: "dependency version pinning." Pure, no network —
 * just reads package.json and flags any range that isn't an exact pin.
 * ^ and ~ are the common offenders (a fresh `npm install` next month can
 * silently pull a different version into a scaffolded component's deps).
 * This is advisory like idiom.ts, not a blocker — flags, doesn't fail.
 */
export async function checkVersionPinning(targetDir: string = process.cwd()): Promise<PinningFinding[]> {
  const pkgPath = join(targetDir, "package.json");
  if (!existsSync(pkgPath)) return [];

  const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
  const findings: PinningFinding[] = [];

  for (const section of ["dependencies", "devDependencies"] as const) {
    const deps: Record<string, string> = pkg[section] ?? {};
    for (const [name, range] of Object.entries(deps)) {
      if (range.startsWith("^")) {
        findings.push({ name, declaredRange: range, section, reason: "caret range — allows minor/patch drift" });
      } else if (range.startsWith("~")) {
        findings.push({ name, declaredRange: range, section, reason: "tilde range — allows patch drift" });
      } else if (range === "*" || range === "latest") {
        findings.push({ name, declaredRange: range, section, reason: "unpinned entirely — any version can land" });
      }
      // exact versions ("1.2.3") and workspace:/file: refs pass silently
    }
  }

  return findings;
}

export interface VulnFinding {
  module: string;
  severity: "low" | "moderate" | "high" | "critical";
  title: string;
  url: string;
  range: string;
}

export interface VulnScanResult {
  ran: boolean;
  reason?: string;
  findings: VulnFinding[];
}

type AuditTool = "pnpm" | "yarn" | "npm";

/**
 * Same lockfile-priority pattern as installTypescriptHint() in verify.ts:
 * detect which package manager the TARGET project actually uses, rather
 * than assuming npm. Bun (bun.lock/bun.lockb) is deliberately excluded —
 * Bun does not currently expose an audit subcommand equivalent to
 * `npm audit`/`pnpm audit`/`yarn audit`, so there is no tool to shell out
 * to for a Bun-only project; that case falls through to ran:false below.
 */
function detectAuditTool(targetDir: string): AuditTool | null {
  if (existsSync(join(targetDir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(targetDir, "yarn.lock"))) return "yarn";
  if (existsSync(join(targetDir, "package-lock.json"))) return "npm";
  return null;
}

/**
 * Section 8 Should-have: "vuln scan." Shells out to the target project's
 * own package manager's audit command rather than reimplementing an
 * advisory database — each of pnpm/yarn/npm audit hits the real registry
 * advisory feed, which is the thing actually worth trusting here.
 * BUG FIX: this used to hardcode `npm audit` against `package-lock.json`
 * regardless of which package manager the target project actually uses,
 * so it always returned ran:false on pnpm/yarn projects (including this
 * repo's own). Now detects pnpm-lock.yaml / yarn.lock / package-lock.json
 * and dispatches to the matching tool, each with its own JSON parser
 * since the shapes differ.
 */
export function runVulnScan(targetDir: string = process.cwd()): VulnScanResult {
  const tool = detectAuditTool(targetDir);
  if (!tool) {
    return {
      ran: false,
      reason: "No pnpm-lock.yaml, yarn.lock, or package-lock.json found — nothing to resolve an audit against. (Bun projects aren't supported here: Bun doesn't currently expose an audit command equivalent to npm/pnpm/yarn audit.)",
      findings: [],
    };
  }

  const command = tool === "pnpm" ? ["pnpm", "audit", "--json"]
    : tool === "yarn" ? ["yarn", "audit", "--json"]
    : ["npm", "audit", "--json"];

  const result = spawnSync(command, { cwd: targetDir, stdout: "pipe", stderr: "pipe" });

  const stdout = result.stdout.toString();
  const findings: VulnFinding[] = [];

  if (tool === "yarn") {
    // yarn audit --json emits one JSON object per line (NDJSON), not a
    // single JSON document — parse line by line and pick out advisories.
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: any;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (entry.type === "auditAdvisory") {
        const d = entry.data?.advisory;
        if (d) {
          findings.push({
            module: d.module_name ?? "(unknown)",
            severity: d.severity ?? "moderate",
            title: d.title ?? "(no title)",
            url: d.url ?? "",
            range: d.vulnerable_versions ?? "unknown",
          });
        }
      }
    }
    return { ran: true, findings };
  }

  // pnpm audit --json and npm audit --json (v7+) share the same
  // `vulnerabilities` object shape, keyed by package name.
  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {
      ran: false,
      reason: result.stderr.toString().trim() || `${tool} audit produced no parseable output`,
      findings: [],
    };
  }

  for (const [name, v] of Object.entries<any>(parsed.vulnerabilities ?? {})) {
    for (const via of v.via ?? []) {
      if (typeof via === "object") {
        findings.push({
          module: name,
          severity: via.severity ?? v.severity ?? "moderate",
          title: via.title ?? "(no title)",
          url: via.url ?? "",
          range: v.range ?? "unknown",
        });
      }
    }
  }

  return { ran: true, findings };
}

export function formatVulnScan(result: VulnScanResult): string {
  if (!result.ran) return `  (vuln scan skipped: ${result.reason})`;
  if (result.findings.length === 0) return "  no known vulnerabilities found.";
  const bySeverity = { critical: 0, high: 0, moderate: 0, low: 0 };
  for (const f of result.findings) bySeverity[f.severity]++;
  const summary = Object.entries(bySeverity)
    .filter(([, n]) => n > 0)
    .map(([sev, n]) => `${n} ${sev}`)
    .join(", ");
  const detail = result.findings
    .map((f) => `  [${f.severity}] ${f.module} (${f.range}) — ${f.title}${f.url ? ` (${f.url})` : ""}`)
    .join("\n");
  return `  ${summary}\n${detail}`;
}
