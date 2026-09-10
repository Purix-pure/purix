// scripts/check-core-boundary.ts
//
// Part 1's CI boundary check: packages/core must never import from
// packages/api or packages/cli. Built and verified against a deliberately
// bad import BEFORE the file-move restructure happened, so the boundary
// has been enforced from the moment packages/ existed, not bolted on
// after the fact.
//
// Two ways a core file could reach into cli/api, both checked:
//   1. A package-specifier import, e.g. `from "purix/..."` (the CLI
//      package's published name — see packages/cli/package.json).
//   2. A relative path that climbs out of packages/core into a sibling
//      package, e.g. `from "../../../cli/src/..."`. Unlikely given the
//      package.json exports setup, but a bad copy-paste could still do
//      this, and grep for the literal string is what the prompt asked
//      for, so both are covered rather than trusting the specifier form
//      alone.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const CORE_ROOT = join(import.meta.dirname, "..", "packages", "core");
const FORBIDDEN_SPECIFIERS = ["purix", "@purix/api"];
const FORBIDDEN_PATH_FRAGMENTS = ["packages/api", "packages/cli"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules") continue;
      walk(full, out);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

// Matches the module specifier string out of a real import/export/require
// statement — e.g. `from "purix/x"` or `require("purix/x")` —
// rather than just checking whether the forbidden text appears anywhere on
// a line that happens to contain the word "import". A comment explaining
// the boundary rule (like this file's own docs, or gated-confirm.ts's
// header) is prose, not a specifier, and must not trip the check.
const SPECIFIER_PATTERN = /(?:from\s+|require\()\s*["']([^"']+)["']/g;

const violations: { file: string; line: number; text: string }[] = [];

for (const file of walk(CORE_ROOT)) {
  const lines = readFileSync(file, "utf-8").split("\n");
  lines.forEach((line, i) => {
    for (const match of line.matchAll(SPECIFIER_PATTERN)) {
      const specifier = match[1];
      const hit =
        FORBIDDEN_SPECIFIERS.find((s) => specifier.startsWith(s)) ??
        FORBIDDEN_PATH_FRAGMENTS.find((s) => specifier.includes(s));
      if (hit) {
        violations.push({ file: relative(process.cwd(), file), line: i + 1, text: line.trim() });
      }
    }
  });
}

if (violations.length > 0) {
  console.error("Core boundary violation — packages/core must never import from packages/cli or packages/api:\n");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.text}`);
  }
  console.error(`\n${violations.length} violation(s) found.`);
  process.exit(1);
}

console.log("Core boundary check passed — no packages/core file imports from packages/cli or packages/api.");