#!/usr/bin/env node
// scripts/check-core-exports.mjs: H4, the public surface of @purix/core.
//
//   node scripts/check-core-exports.mjs           check (exit 1 on any difference)
//   node scripts/check-core-exports.mjs --write   rewrite the "exports" map of packages/core/package.json from the evidence below
//
// WHY: core used to export every file ("./*"), so every internal module was importable from outside once published, and nothing
// said which ones were meant to be. The evidence for "public" is what the sibling packages (cli, mcp-server) and the repository
// scripts actually import as `@purix/core/<path>`. The exports map lists exactly those paths and nothing else.
//   - A path someone imports that is not in the map  -> FAIL (the import would break once published).
//   - A path in the map that nobody imports          -> FAIL (the surface grew with no user; remove it or add the user).
//   - A path in the map with no source file          -> FAIL (a dead entry).
// To make a module public on purpose: import it from another package, run this script with --write, and review the diff of
// packages/core/package.json (CODEOWNERS should cover it).
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const write = process.argv.includes("--write");
const pkgPath = join(root, "packages", "core", "package.json");

const SCAN_DIRS = ["packages/cli/src", "packages/mcp-server/src", "packages/core/src", "scripts"];
const SKIP = new Set(["node_modules", "dist", ".turbo", ".purix", ".release-check", ".test-logs"]);
const EXT = /\.(ts|mts|mjs|js|cjs)$/;

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) yield* walk(p);
    else if (EXT.test(name)) yield p;
  }
}

const used = new Map(); // subpath -> first file that imports it
const SPEC = /["'`]@purix\/core\/([A-Za-z0-9_\-/]+)["'`]/g;
for (const d of SCAN_DIRS) {
  for (const f of walk(join(root, d))) {
    if (f.endsWith("check-core-exports.mjs")) continue;
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(SPEC)) if (!used.has(m[1])) used.set(m[1], f.slice(root.length + 1));
  }
}

const wanted = [...used.keys()].sort();
const entry = (sub) => ({ types: `./dist/${sub}.d.ts`, default: `./dist/${sub}.js` });
const wantedMap = Object.fromEntries(wanted.map((s) => [`./${s}`, entry(s)]));

const raw = readFileSync(pkgPath, "utf8");
const pkg = JSON.parse(raw);

if (write) {
  pkg.exports = wantedMap;
  const indent = /\n( +)"/.exec(raw)?.[1].length ?? 2;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, indent) + (raw.endsWith("\n") ? "\n" : ""));
  console.log(`check-core-exports: wrote ${wanted.length} entries to packages/core/package.json`);
  process.exit(0);
}

const problems = [];
const have = pkg.exports && typeof pkg.exports === "object" ? pkg.exports : {};
if (Object.keys(have).some((k) => k.includes("*"))) problems.push('exports still has a wildcard key (for example "./*"): list paths explicitly');
for (const s of wanted) {
  const key = `./${s}`;
  if (!have[key]) problems.push(`imported but not exported: @purix/core/${s} (first used in ${used.get(s)})`);
  else if (JSON.stringify(have[key]) !== JSON.stringify(entry(s))) problems.push(`export entry for ${key} does not point at dist/${s}`);
  if (!existsSync(join(root, "packages", "core", "src", `${s}.ts`))) problems.push(`no source file for @purix/core/${s} (first used in ${used.get(s)})`);
}
for (const key of Object.keys(have)) {
  if (key.includes("*")) continue;
  if (!used.has(key.slice(2))) problems.push(`exported but imported by no package or script: ${key}`);
}

if (problems.length) {
  console.error(`check-core-exports: FAIL\n  - ${problems.join("\n  - ")}\nFix: import what you need from another package, then run: node scripts/check-core-exports.mjs --write`);
  process.exit(1);
}
console.log(`check-core-exports: ok (${wanted.length} public subpaths, each imported by a sibling package or script)`);
