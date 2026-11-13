// scripts/check-single-point.ts
//
// ADR-061 / PURIX-17 §5: a ratcheting "single point of call" check, same family as check-core-boundary.ts.
//
// Rules (all on packages/core/src, non-test files, comments removed):
//   R1 no console.* / process.stdout|stderr.write   (core returns data; the CLI and MCP adapters print)
//   R2 no fetch( outside platform/net.ts            (one network door: netFetch)
//   R3 no ".purix" path text outside platform/layout.ts   (one place for state paths)
//   R4 no process.env outside platform/env.ts      (one place for environment variables)
//   R5 no writeFileSync / renameSync outside platform/atomic_write.ts   (one place that writes state files)
//   R8 no node:child_process import in core, except the OpenCode plugin text in hooks/install.ts (one spawn point: platform/spawn_sync.ts,
//      which carries the deadline, the output cap and the stop marker; a direct spawnSync gets none of them. Zero tolerated)
//   R7 the words "not tested" are written in verify/outcome.ts only (one wording for every front door, zero tolerated)
//   R6 no network-capable import (an SDK or node:http/https/tls/dgram) anywhere in core, cli or mcp-server, except
//      platform/net.ts. An SDK opens its own connections, which `fetch(` text matching (R2) cannot see. Zero tolerated.
//
// How it works: tests/scripts/baseline are compared per file. Today's violations are recorded in
// scripts/single-point-baseline.json. A file whose count RISES, or a file with a violation that is not in
// the baseline, fails. Counts may only fall. Under packages/core/src/tools/ the baseline is not
// consulted at all: zero is required.
//
// Limits, stated: this is text matching with a small comment/string scanner, not a parser. A pattern built
// from pieces ("conso"+"le") is not caught; a "console.log" inside a template literal's text is counted.
// It finds the clear cases, which is what a ratchet needs.
//
//   node --import tsx scripts/check-single-point.ts             check (exit 1 on a problem)
//   node --import tsx scripts/check-single-point.ts --update    lower the baseline after a migration
//                                                               (refuses to raise any count)
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "packages", "core", "src");
const BASELINE = join(import.meta.dirname, "single-point-baseline.json");

export type RuleId = "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8";
export interface Rule {
  id: RuleId;
  describe: string;
  pattern: RegExp;
  exempt?: (relPath: string) => boolean;
  /** true: the rule also scans packages/cli and packages/mcp-server (their paths start with "@cli/" and "@mcp/"). */
  allPackages?: boolean;
}

export const RULES: Rule[] = [
  { id: "R1", describe: "console.* / process.stdout.write in core", pattern: /\bconsole\.[A-Za-z]+|\bprocess\.std(?:out|err)\.write\b/g },
  { id: "R2", describe: "fetch( outside platform/net.ts (use netFetch)", pattern: /\bfetch\s*\(/g, exempt: (p) => p === "platform/net.ts" },
  { id: "R3", describe: '".purix" path text outside platform/layout.ts', pattern: /(?<![A-Za-z0-9-])\.purix(?![A-Za-z0-9_-]|\.[A-Za-z])/g, exempt: (p) => p === "platform/layout.ts" },
  { id: "R4", describe: "process.env outside platform/env.ts (use purixEnv, ambientEnv, dataDrivenEnv)", pattern: /\bprocess\.env\b/g, exempt: (p) => p === "platform/env.ts" },
  // Append-only logs use appendFileSync and are not counted: appending one line is the right primitive there.
  { id: "R5", describe: "writeFileSync/renameSync outside platform/atomic_write.ts (use writeFileAtomic or createFileExclusive)", pattern: /\b(?:writeFileSync|renameSync)\b/g, // sandbox/sandbox.ts writes the proposed change into a disposable mkdtemp copy of the project that is deleted right after the
  // run. It is scratch, not state: an interrupted write loses nothing, and an fsync per file would only slow verification.
  exempt: (p) => p === "platform/atomic_write.ts" || p === "sandbox/sandbox.ts" },
  {
    id: "R6",
    describe: "network-capable import outside platform/net.ts (an SDK or node:http, https, tls, dgram; use netFetch)",
    pattern: /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](?:@google\/genai|@google-cloud\/[\w-]+|@anthropic-ai\/sdk|openai|axios|node-fetch|undici|got|superagent|ws|node:https?|https?|node:tls|tls|node:dgram|dgram|node:http2|http2)["']/g,
    exempt: (p) => p === "platform/net.ts",
    allPackages: true,
  },
  {
    id: "R7",
    describe: '"not tested" wording outside verify/outcome.ts (use notTestedMessage, notTestedInline, pendingNotTestedMessage or notTestedBadge)',
    pattern: /\bnot tested\b/gi,
    exempt: (p) => p === "verify/outcome.ts",
    allPackages: true,
  },
  {
    id: "R8",
    describe: "node:child_process import in core (use spawnSync from platform/spawn_sync.ts)",
    pattern: /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](?:node:)?child_process["']/g,
    // hooks/install.ts holds the source text of the OpenCode plugin. That text is written to disk and runs inside OpenCode, a
    // separate process that cannot import Purix, so it is not a spawn made by Purix. The scanner keeps template text, hence this exemption.
    exempt: (p) => p === "hooks/install.ts",
  },
];

export function isTestFile(rel: string): boolean {
  return /\.test\.ts$/.test(rel) || rel.startsWith("test-support/") || /(^|\/)test_helpers\.ts$/.test(rel) || rel.includes("/__golden__/") || rel.includes("/fixtures/");
}

export function isHardZero(rel: string): boolean {
  return rel.startsWith("tools/");
}

/** Removes // and block comments, keeping string and template contents. Newlines are kept. */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += n ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    out += c;
    i++;
  }
  return out;
}

export type Counts = Record<RuleId, Record<string, number>>;

export function countViolations(files: Array<{ rel: string; text: string }>): Counts {
  const counts: Counts = emptyCounts();
  for (const f of files) {
    if (isTestFile(f.rel)) continue;
    const text = stripComments(f.text);
    const outside = f.rel.startsWith("@cli/") || f.rel.startsWith("@mcp/");
    for (const rule of RULES) {
      if (outside && !rule.allPackages) continue;
      if (rule.exempt?.(f.rel)) continue;
      const n = (text.match(rule.pattern) ?? []).length;
      if (n > 0) counts[rule.id][f.rel] = n;
    }
  }
  return counts;
}

export interface Verdict {
  failures: string[];
  improvements: string[];
}

export function compare(current: Counts, baseline: Counts): Verdict {
  const failures: string[] = [];
  const improvements: string[] = [];
  for (const rule of RULES) {
    for (const [file, n] of Object.entries(current[rule.id])) {
      if (isHardZero(file)) {
        failures.push(`${rule.id} ${file}: ${n} violation(s); this module must have zero (${rule.describe})`);
        continue;
      }
      const allowed = baseline[rule.id]?.[file] ?? 0;
      if (n > allowed) failures.push(`${rule.id} ${file}: ${n} (baseline allows ${allowed}) — ${rule.describe}`);
      else if (n < allowed) improvements.push(`${rule.id} ${file}: ${allowed} -> ${n}`);
    }
    for (const [file, allowed] of Object.entries(baseline[rule.id] ?? {})) {
      if (!(file in current[rule.id])) improvements.push(`${rule.id} ${file}: ${allowed} -> 0`);
    }
  }
  return { failures, improvements };
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      walk(full, out);
    } else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

function loadFiles(): Array<{ rel: string; text: string }> {
  const out = walk(SRC).map((full) => ({ rel: relative(SRC, full).split(sep).join("/"), text: readFileSync(full, "utf-8") }));
  for (const [prefix, dir] of [["@cli/", join(ROOT, "packages", "cli", "src")], ["@mcp/", join(ROOT, "packages", "mcp-server", "src")]] as const) {
    if (!existsSync(dir)) continue;
    for (const full of walk(dir)) out.push({ rel: prefix + relative(dir, full).split(sep).join("/"), text: readFileSync(full, "utf-8") });
  }
  return out;
}

export function emptyCounts(): Counts {
  return { R1: {}, R2: {}, R3: {}, R4: {}, R5: {}, R6: {}, R7: {}, R8: {} };
}

function sortCounts(c: Counts): Counts {
  const out = emptyCounts();
  for (const r of RULES) for (const k of Object.keys(c[r.id]).sort()) out[r.id][k] = c[r.id][k]!;
  return out;
}

function main(): void {
  const current = countViolations(loadFiles());
  const baseline: Counts = existsSync(BASELINE) ? { ...emptyCounts(), ...(JSON.parse(readFileSync(BASELINE, "utf-8")).counts as Partial<Counts>) } : emptyCounts();
  const update = process.argv.includes("--update");
  const first = process.argv.includes("--init") || !existsSync(BASELINE);

  if (first && !existsSync(BASELINE)) {
    // Initial recording is allowed exactly once, and never records a hard-zero violation.
    const bad = compare(current, emptyCounts()).failures.filter((f) => f.includes("must have zero"));
    if (bad.length > 0) {
      console.error("single-point-check: cannot record a baseline while a zero-required module has violations:\n  " + bad.join("\n  "));
      process.exit(1);
    }
    writeFileSync(BASELINE, JSON.stringify({ note: "Counts may only fall. See ADR-061 and scripts/check-single-point.ts.", counts: sortCounts(current) }, null, 2) + "\n");
    console.log("single-point-check: baseline recorded.");
    return;
  }

  const verdict = compare(current, baseline);
  if (update) {
    if (verdict.failures.length > 0) {
      console.error("single-point-check --update refuses to RAISE a count or record a zero-required violation:\n  " + verdict.failures.join("\n  "));
      process.exit(1);
    }
    writeFileSync(BASELINE, JSON.stringify({ note: "Counts may only fall. See ADR-061 and scripts/check-single-point.ts.", counts: sortCounts(current) }, null, 2) + "\n");
    console.log(`single-point-check: baseline lowered (${verdict.improvements.length} improvement(s)).`);
    return;
  }

  if (verdict.failures.length > 0) {
    console.error("single-point-check FAILED:\n  " + verdict.failures.join("\n  "));
    process.exit(1);
  }
  const totals = RULES.map((r) => `${r.id}=${Object.values(current[r.id]).reduce((a, b) => a + b, 0)}`).join(" ");
  console.log(`single-point-check: ok (${totals}).${verdict.improvements.length > 0 ? ` ${verdict.improvements.length} file(s) improved; run with --update to lock it in.` : ""}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) main();
