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

/**
 * Section 8 Should-have: "vuln scan." Shells out to `npm audit --json`
 * rather than reimplementing an advisory database — npm's audit hits the
 * real registry advisory feed, which is the thing actually worth trusting
 * here. Requires an npm-resolvable lockfile (package-lock.json). If this
 * is a bun-only project with no package-lock.json, npm audit has nothing
 * to check against — this returns ran:false rather than a false "clean."
 */
export function runVulnScan(targetDir: string = process.cwd()): VulnScanResult {
  const lockfile = join(targetDir, "package-lock.json");
  if (!existsSync(lockfile)) {
    return {
      ran: false,
      reason: "No package-lock.json found — npm audit needs one to resolve against. Run `npm install` once (alongside your bun workflow) to generate it, or `bun pm` doesn't currently expose an equivalent audit.",
      findings: [],
    };
  }

  const result = spawnSync(["npm", "audit", "--json"], { cwd: targetDir, stdout: "pipe", stderr: "pipe" });

  let parsed: any;
  try {
    parsed = JSON.parse(result.stdout.toString());
  } catch {
    return {
      ran: false,
      reason: result.stderr.toString().trim() || "npm audit produced no parseable output",
      findings: [],
    };
  }

  const findings: VulnFinding[] = [];
  // npm audit's JSON shape differs between npm 6, 7, and 8+. This handles
  // the v7+ shape (`vulnerabilities` keyed by package name). If you're on
  // npm 6 this won't parse right — check `npm --version` if findings come
  // back empty on a project you know has issues.
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
