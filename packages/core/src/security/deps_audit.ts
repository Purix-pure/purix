// src/security/deps_audit.ts
import { spawnSync } from "../platform/spawn_sync.js";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { asArray, asObject, asText, type JsonObject } from "../platform/json_shape.js";

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

  // H1: advisory only. A package.json that cannot be read as an object, or a range that is not text, is skipped, never a crash.
  let pkg: JsonObject;
  try {
    pkg = asObject(JSON.parse(await readFile(pkgPath, "utf-8")));
  } catch {
    return [];
  }
  const findings: PinningFinding[] = [];

  for (const section of ["dependencies", "devDependencies"] as const) {
    for (const [name, range] of Object.entries(asObject(pkg[section]))) {
      if (typeof range !== "string") continue;
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

export interface VulnScanOptions {
  /** Hard stop for the audit command, in milliseconds. Default: the spawn wrapper's default tier. */
  deadlineMs?: number;
}

// "yarn1" and "yarn-berry" are told apart by the lockfile: Yarn 1's starts "# yarn lockfile v1" and has no `__metadata`, Yarn 4's has a
// `__metadata:` block (both observed 2026-11-07, Yarn 1.22.22 and 4.18.1). Yarn 2 and 3 share the Yarn 4 marker but were not run.
type AuditTool = "pnpm" | "yarn1" | "yarn-berry" | "npm";

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
  const yarnLock = join(targetDir, "yarn.lock");
  if (existsSync(yarnLock)) {
    try {
      return readFileSync(yarnLock, "utf-8").includes("__metadata:") ? "yarn-berry" : "yarn1";
    } catch {
      return "yarn1";
    }
  }
  if (existsSync(join(targetDir, "package-lock.json"))) return "npm";
  return null;
}

export type Parsed = { report: true; findings: VulnFinding[] } | { report: false; why: string };

const SEVERITIES = ["low", "moderate", "high", "critical"] as const;
function severityOf(v: unknown): VulnFinding["severity"] {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  return (SEVERITIES as readonly string[]).includes(s) ? (s as VulnFinding["severity"]) : "moderate";
}

// eslint-disable-next-line no-control-regex
const stripAnsi = (t: string) => t.replace(/\u001b\[[0-9;]*m/g, "");
const firstLine = (t: string) => stripAnsi(t).split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";

/**
 * Recognises the three real report shapes recorded on 2026-11-07 (npm 10.9.9, pnpm 10.34.9, pnpm 11.28.11): npm's `vulnerabilities`
 * object and pnpm's `advisories` object. An object with neither is not a report, for example the `{ "error": { "message": ... } }` that pnpm 10 and
 * npm print on stdout when the registry cannot be reached.
 */
export function parseJsonReport(stdout: string): Parsed {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return { report: false, why: firstLine(stdout) || "no parseable output" };
  }
  const parsed = asObject(raw);
  const findings: VulnFinding[] = [];
  const isMap = (v: unknown): boolean => typeof v === "object" && v !== null && !Array.isArray(v);
  if (isMap(parsed.advisories)) {
    for (const a of Object.values(asObject(parsed.advisories)).map(asObject)) {
      findings.push({
        module: asText(a.module_name, "(unknown)"),
        severity: severityOf(a.severity),
        title: asText(a.title, "(no title)"),
        url: asText(a.url, ""),
        range: asText(a.vulnerable_versions, "unknown"),
      });
    }
    return { report: true, findings };
  }
  if (isMap(parsed.vulnerabilities)) {
    for (const [name, value] of Object.entries(asObject(parsed.vulnerabilities))) {
      const v = asObject(value);
      for (const viaEntry of asArray(v.via)) {
        // `via` also holds plain package names (text): those point at another entry and are not findings themselves.
        if (typeof viaEntry !== "object" || viaEntry === null) continue;
        const via = asObject(viaEntry);
        findings.push({
          module: name,
          severity: severityOf(via.severity ?? v.severity),
          title: asText(via.title, "(no title)"),
          url: asText(via.url, ""),
          range: asText(v.range, "unknown"),
        });
      }
    }
    return { report: true, findings };
  }
  const message = asObject(parsed.error).message ?? parsed.message ?? asObject(parsed.error).summary;
  return { report: false, why: typeof message === "string" && message ? message : "the output is not an audit report" };
}

/** `yarn audit --json` (Yarn 1): one JSON object per line. A finished run always ends with an `auditSummary` line, even when clean. */
export function parseYarn1Report(stdout: string): Parsed {
  const findings: VulnFinding[] = [];
  let sawSummary = false;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: JsonObject;
    try {
      entry = asObject(JSON.parse(trimmed));
    } catch {
      continue;
    }
    if (entry.type === "auditSummary") sawSummary = true;
    if (entry.type === "auditAdvisory") {
      const d = asObject(asObject(entry.data).advisory);
      if (Object.keys(d).length > 0) {
        findings.push({
          module: asText(d.module_name, "(unknown)"),
          severity: severityOf(d.severity),
          title: asText(d.title, "(no title)"),
          url: asText(d.url, ""),
          range: asText(d.vulnerable_versions, "unknown"),
        });
      }
    }
  }
  return sawSummary || findings.length > 0 ? { report: true, findings } : { report: false, why: firstLine(stdout) || "no audit summary in the output" };
}

/**
 * `yarn npm audit --json --no-deprecations` (Yarn 4): one object per line, `{ value: <package>, children: { ID, Issue, URL, Severity,
 * "Vulnerable Versions", ... } }`. Recorded: a clean project prints nothing and exits 0; one with advisories exits 1; a failed run
 * prints text or nothing and exits 1. So empty output counts as clean only with exit code 0.
 */
export function parseYarnBerryReport(stdout: string, exitCode: number | null): Parsed {
  const findings: VulnFinding[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: JsonObject;
    try {
      entry = asObject(JSON.parse(trimmed));
    } catch {
      continue;
    }
    const c = asObject(entry.children);
    if (typeof c.Severity === "string") {
      findings.push({
        module: asText(entry.value, "(unknown)"),
        severity: severityOf(c.Severity),
        title: asText(c.Issue, "(no title)"),
        url: asText(c.URL, ""),
        range: asText(c["Vulnerable Versions"], "unknown"),
      });
    }
  }
  if (findings.length > 0) return { report: true, findings };
  if (stdout.trim() === "" && exitCode === 0) return { report: true, findings: [] };
  return { report: false, why: firstLine(stdout) || `exit code ${exitCode}, no output` };
}

/**
 * Section 8 Should-have: "vuln scan." Shells out to the target project's
 * own package manager's audit command rather than reimplementing an
 * advisory database — each of pnpm/yarn/npm audit hits the real registry
 * advisory feed, which is the thing actually worth trusting here.
 *
 * ADR-062: "could not check" never reads as clean. `ran: true` with no findings is returned only when the tool printed a report
 * in a shape recorded from the real tool (see deps_audit.real_output.test.ts). Anything else (an error object, a usage error, text, a
 * stopped run, a missing tool) is `ran: false` with the tool's own words as the reason. Before 2026-11-07 pnpm 10/11 reports
 * (`advisories`) and error objects were read as "0 findings", and a Yarn 4 usage error was read as a clean scan.
 */
export function runVulnScan(targetDir: string = process.cwd(), opts: VulnScanOptions = {}): VulnScanResult {
  const tool = detectAuditTool(targetDir);
  if (!tool) {
    return {
      ran: false,
      reason: "No pnpm-lock.yaml, yarn.lock, or package-lock.json found — nothing to resolve an audit against. (Bun projects aren't supported here: Bun doesn't currently expose an audit command equivalent to npm/pnpm/yarn audit.)",
      findings: [],
    };
  }

  const command =
    tool === "pnpm" ? ["pnpm", "audit", "--json"]
    : tool === "yarn1" ? ["yarn", "audit", "--json"]
    : tool === "yarn-berry" ? ["yarn", "npm", "audit", "--json", "--no-deprecations"]
    : ["npm", "audit", "--json"];
  const label = command.slice(0, tool === "yarn-berry" ? 3 : 2).join(" ");

  const result = spawnSync(command, { cwd: targetDir, stdout: "pipe", stderr: "pipe", ...(opts.deadlineMs !== undefined ? { deadlineMs: opts.deadlineMs } : {}) });

  if (result.stopped) {
    const why: Record<string, string> = {
      timeout: "ran past its time limit and was stopped",
      output_limit: "printed more than the output limit and was stopped",
      resource_limit: "was stopped at a resource limit",
      not_found: `could not be found (is ${command[0]} installed and on PATH?)`,
      spawn_error: "could not be started",
    };
    return { ran: false, reason: `${label} ${why[result.stopped] ?? `was stopped (${result.stopped})`}`, findings: [] };
  }

  const stdout = result.stdout.toString();
  const parsed =
    tool === "yarn1" ? parseYarn1Report(stdout)
    : tool === "yarn-berry" ? parseYarnBerryReport(stdout, result.exitCode)
    : parseJsonReport(stdout);

  if (!parsed.report) {
    const detail = parsed.why || firstLine(result.stderr.toString());
    return { ran: false, reason: `${label} did not produce an audit report (exit code ${result.exitCode}): ${detail}`, findings: [] };
  }
  return { ran: true, findings: parsed.findings };
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
