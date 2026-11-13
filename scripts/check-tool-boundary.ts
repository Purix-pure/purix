// scripts/check-tool-boundary.ts
//
// ADR-060 / PURIX-14 S5: tools are chosen, installed and located in ONE place, packages/core/src/tools/.
// This check fails if code anywhere else in packages/core/src starts doing it again.
//
// Rules (non-test files, comments removed):
//   B1 no `pip install`                         (the broker installs, hash-checked)
//   B2 no `npx`                                 (a package runner can fetch an unpinned package at run time)
//   B3 no `npm install` / `npm ci`              (same reason)
//   B4 no building a Python virtualenv          (`-m venv`)
//   B5 no spawning a catalog tool by bare name  (spawn(["pytest", ...])); ask the broker where it is: locateTool
//
// There is no baseline and no allowlist: zero is required. Running the project's OWN package manager's
// audit (npm/pnpm/yarn audit in security/deps_audit.ts) is not an install and is not matched.
//
// Limits, stated: text matching with a small comment scanner, not a parser. A command assembled from
// pieces is not caught. It finds the clear cases, which is what a guard needs.
//
//   node --import tsx scripts/check-tool-boundary.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { isTestFile, stripComments } from "./check-single-point.ts";

const SRC = join(import.meta.dirname, "..", "packages", "core", "src");

export interface BoundaryRule {
  id: string;
  describe: string;
  pattern: RegExp;
}

const CATALOG_BINS = "pytest|ruff|pyright|pip-audit|vitest|jest|mocha|eslint|tsc|tsx";

export const BOUNDARY_RULES: BoundaryRule[] = [
  { id: "B1", describe: "pip install outside tools/", pattern: /["'`]pip3?["'`]\s*,\s*["'`]install["'`]|\bpip3?\s+install\b/g },
  { id: "B2", describe: "npx outside tools/", pattern: /\bnpx\b/g },
  { id: "B3", describe: "npm install / npm ci outside tools/", pattern: /["'`]npm["'`]\s*,\s*["'`](?:install|ci|i)["'`]|\bnpm\s+(?:install|ci)\b/g },
  { id: "B4", describe: "creating a Python virtualenv outside tools/", pattern: /["'`]-m["'`]\s*,\s*["'`]venv["'`]/g },
  { id: "B5", describe: "spawning a catalog tool by bare name (use locateTool)", pattern: new RegExp(`\\(\\s*\\[\\s*["'\`](?:${CATALOG_BINS})["'\`]\\s*[,\\]]`, "g") },
];

/** Inside tools/ is where this work belongs. */
export function isBrokerFile(rel: string): boolean {
  return rel.startsWith("tools/");
}

export interface Finding {
  rule: string;
  file: string;
  line: number;
  text: string;
}

export function findViolations(files: Array<{ rel: string; text: string }>): Finding[] {
  const out: Finding[] = [];
  for (const f of files) {
    if (isTestFile(f.rel) || isBrokerFile(f.rel)) continue;
    const text = stripComments(f.text);
    for (const rule of BOUNDARY_RULES) {
      for (const m of text.matchAll(rule.pattern)) {
        const line = text.slice(0, m.index ?? 0).split("\n").length;
        out.push({ rule: rule.id, file: f.rel, line, text: m[0].trim() });
      }
    }
  }
  return out;
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

function main(): void {
  const files = walk(SRC).map((full) => ({ rel: relative(SRC, full).split(sep).join("/"), text: readFileSync(full, "utf-8") }));
  const found = findViolations(files);
  if (found.length > 0) {
    console.error("tool-boundary-check FAILED: tools are chosen, installed and located only in packages/core/src/tools/ (ADR-060).");
    for (const f of found) console.error(`  ${f.rule} ${f.file}:${f.line}  ${f.text}   (${BOUNDARY_RULES.find((r) => r.id === f.rule)!.describe})`);
    console.error("Ask the broker instead: locateTool / missingToolHint in tools/broker.ts.");
    process.exit(1);
  }
  console.log(`tool-boundary-check: ok (${files.length} files scanned, 0 violations).`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) main();
