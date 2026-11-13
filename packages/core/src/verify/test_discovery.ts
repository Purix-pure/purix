// src/verify/test_discovery.ts
//
// Which tests are RELATED to a change. This replaces the old rule "x.ts maps to the sibling
// x.test.ts", which could not see tests kept in test/ or __tests__/, tests named .spec, tests of a
// module's importers, or JavaScript projects at all — so a well-tested project looked untested and
// the trust gate asked a human to approve covered code.
//
// Two relations, both deterministic and local (no model, no runner-specific feature):
//   1. IMPORTS: a test is related if it imports the changed file, directly or through a chain of
//      other project files (the same idea as Jest's --findRelatedTests, applied uniformly so
//      node:test — which has no such option — Jest, Vitest and Mocha all get the same answer).
//   2. NAME: a test whose name stem equals the changed file's stem (a.ts <-> a.test.ts, a.spec.ts,
//      __tests__/a.ts, test/a.test.ts). Catches tests that reach the code only at runtime.
// A changed file that is itself a test is always selected (the old rule never ran it).
//
// Deliberate limits, reported rather than hidden:
//  - Imports are found by pattern, not by the TypeScript compiler (loading it costs ~500ms per
//    verification, see language/providers/typescript.ts). The pattern OVER-matches (an import
//    mentioned in a comment counts), which only ever runs an extra test; it never skips one.
//  - Imports whose specifier is not a string literal, and bare package names (workspace packages,
//    node_modules), cannot be followed. tsconfig `paths`/`baseUrl` aliases are followed.
//  - Only JS/TS files are scanned; the scan stops at MAX_FILES and says so (`truncated`).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, basename, sep, isAbsolute } from "node:path";
import { PURIX_DIRNAME } from "../platform/layout.js";

export const SOURCE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;
const SKIP_DIRS = new Set(["node_modules", ".git", PURIX_DIRNAME, "dist", "build", "out", "coverage", ".next", ".turbo", ".cache"]);
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 1_000_000;

export interface TestDiscovery {
  /** Related test files, project-relative with forward slashes. */
  tests: string[];
  /** For each selected test, why (e.g. "imports src/a.ts", "name matches src/a.ts", "is the changed file"). */
  reasons: Record<string, string[]>;
  /** Changed non-test source files that no test is related to. */
  uncovered: string[];
  /** Number of JS/TS files scanned, and whether the scan hit its cap. */
  scanned: number;
  truncated: boolean;
}

const norm = (p: string) => p.split(sep).join("/");

export function isJsTsFile(path: string): boolean {
  return SOURCE_EXTS.some((e) => path.endsWith(e));
}

/** Node's own default test patterns, plus .spec and __tests__ (Jest/Vitest/Mocha conventions). */
export function isTestPath(relPath: string): boolean {
  const p = norm(relPath);
  const file = basename(p);
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) return true;
  if (/[-_]test\.[cm]?[jt]sx?$/.test(file) || /^test[-.]/.test(file) && isJsTsFile(file)) return true;
  const segs = p.split("/").slice(0, -1);
  return isJsTsFile(file) && segs.some((s) => s === "__tests__" || s === "test");
}

function stemOf(file: string): string {
  return basename(file).replace(/\.[cm]?[jt]sx?$/, "").replace(/\.(test|spec)$/, "").replace(/[-_]test$/, "");
}

function walk(baseDir: string): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;
  const stack = [baseDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { stack.push(full); continue; }
      if (!isJsTsFile(name) || st.size > MAX_FILE_BYTES) continue;
      if (files.length >= MAX_FILES) { truncated = true; return { files, truncated }; }
      files.push(norm(relative(baseDir, full)));
    }
  }
  return { files, truncated };
}

const IMPORT_PATTERNS: RegExp[] = [
  /\b(?:import|export)\s[^'";]*?\sfrom\s*['"]([^'"\n]+)['"]/g, // import x from "y" / export { a } from "y" (multi-line safe)
  /\bimport\s*['"]([^'"\n]+)['"]/g,                             // import "y"
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,                    // import("y")
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,                   // require("y")
];

export function extractSpecifiers(source: string): string[] {
  const out = new Set<string>();
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) if (m[1]) out.add(m[1]);
  }
  return [...out];
}

/** tsconfig.json is JSONC: strip comments and trailing commas outside strings before parsing. */
function parseJsonc(text: string): any {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      out += c;
      if (c === "\\") { out += text[++i] ?? ""; } else if (c === '"') inStr = false;
    } else if (c === '"') { inStr = true; out += c; }
    else if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; }
    else if (c === "/" && text[i + 1] === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; }
    else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

interface AliasConfig { baseUrl: string | null; paths: { prefix: string; suffix: string; targets: string[] }[] }

function loadAliases(baseDir: string): AliasConfig {
  const cfg: AliasConfig = { baseUrl: null, paths: [] };
  const p = join(baseDir, "tsconfig.json");
  if (!existsSync(p)) return cfg;
  try {
    const co = parseJsonc(readFileSync(p, "utf-8"))?.compilerOptions ?? {};
    if (typeof co.baseUrl === "string") cfg.baseUrl = norm(co.baseUrl).replace(/^\.\//, "").replace(/\/$/, "") || ".";
    for (const [pattern, targets] of Object.entries<any>(co.paths ?? {})) {
      const star = pattern.indexOf("*");
      cfg.paths.push({
        prefix: star === -1 ? pattern : pattern.slice(0, star),
        suffix: star === -1 ? "" : pattern.slice(star + 1),
        targets: (Array.isArray(targets) ? targets : []).map(String),
      });
    }
  } catch { /* unreadable tsconfig: aliases are simply not followed */ }
  return cfg;
}

const REPLACE_EXT: Record<string, string[]> = {
  ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"],
};

function resolveCandidate(baseRel: string, known: Set<string>): string | null {
  const cand = norm(baseRel.replace(/^\.\//, ""));
  if (known.has(cand)) return cand;
  for (const [from, tos] of Object.entries(REPLACE_EXT)) {
    if (cand.endsWith(from)) for (const to of tos) { const c = cand.slice(0, -from.length) + to; if (known.has(c)) return c; }
  }
  for (const e of SOURCE_EXTS) if (known.has(cand + e)) return cand + e;
  for (const e of SOURCE_EXTS) if (known.has(`${cand}/index${e}`)) return `${cand}/index${e}`;
  return null;
}

function resolveSpecifier(spec: string, fromRel: string, known: Set<string>, aliases: AliasConfig): string | null {
  if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
    return resolveCandidate(norm(join(dirname(fromRel), spec)), known);
  }
  for (const a of aliases.paths) {
    if (!spec.startsWith(a.prefix) || !spec.endsWith(a.suffix) || spec.length < a.prefix.length + a.suffix.length) continue;
    const mid = spec.slice(a.prefix.length, spec.length - a.suffix.length);
    for (const t of a.targets) {
      const target = t.replace("*", mid);
      const hit = resolveCandidate(norm(join(aliases.baseUrl ?? ".", target)), known);
      if (hit) return hit;
    }
  }
  if (aliases.baseUrl !== null) {
    const hit = resolveCandidate(norm(join(aliases.baseUrl, spec)), known);
    if (hit) return hit;
  }
  return null;
}

/**
 * F05-01 first slice (research 05 section 4, decision D18): the files each given file imports, resolved to files in the given set, using
 * the same specifier reader and resolver that test discovery uses. A pure read of the files; nothing is stored and nothing calls it yet
 * (where derived edges should live is the open question in ADR-068, not decided here). Package imports and anything that resolves
 * outside the set are left out. Dynamic `import(variable)` and computed `require` are not seen.
 * `files` are paths relative to `baseDir`; the result's paths are the same kind, each edge listed once, sorted.
 */
export function deriveImportEdges(files: string[], baseDir: string): { from: string; to: string }[] {
  const known = new Set(files.map(norm));
  const aliases = loadAliases(baseDir);
  const edges = new Map<string, { from: string; to: string }>();
  for (const from of [...known].sort()) {
    if (!isJsTsFile(from)) continue;
    let source: string;
    try { source = readFileSync(join(baseDir, from), "utf-8"); } catch { continue; }
    for (const spec of extractSpecifiers(source)) {
      const to = resolveSpecifier(spec, from, known, aliases);
      if (to !== null && to !== from) edges.set(`${from}\0${to}`, { from, to });
    }
  }
  return [...edges.values()];
}

export function discoverRelatedTests(changedPaths: string[], baseDir: string): TestDiscovery {
  // Classify by the PROJECT-RELATIVE path. An absolute path carries the machine's own folder names, and a checkout under
  // e.g. E:\test\purix made every file look like it lived in a "test" directory, so the changed file was reported as
  // "a test" and the real test beside it was never found (TypeScript conformance failed with "no supported test framework").
  const changed = changedPaths.map((p) => norm(isAbsolute(p) ? relative(baseDir, p) : p).replace(/^\.\//, "")).filter(isJsTsFile);
  const { files, truncated } = walk(baseDir);
  const known = new Set(files);
  for (const c of changed) known.add(c); // a changed file is real even if the scan skipped it
  const aliases = loadAliases(baseDir);

  // reverse graph: file -> files that import it
  const importers = new Map<string, Set<string>>();
  for (const f of known) {
    let src: string;
    try { src = readFileSync(resolve(baseDir, f), "utf-8"); } catch { continue; }
    for (const spec of extractSpecifiers(src)) {
      const target = resolveSpecifier(spec, f, known, aliases);
      if (!target || target === f) continue;
      let set = importers.get(target);
      if (!set) importers.set(target, (set = new Set()));
      set.add(f);
    }
  }

  const reasons: Record<string, string[]> = {};
  const note = (test: string, why: string) => {
    const list = (reasons[test] ??= []);
    if (!list.includes(why)) list.push(why);
  };
  const allTests = [...known].filter(isTestPath);
  const uncovered: string[] = [];

  for (const c of changed) {
    if (isTestPath(c)) { note(c, "is the changed file"); continue; }
    let hit = false;
    // 1. imports, transitively (visited-set BFS: cycles are fine)
    const seen = new Set<string>([c]);
    const queue = [c];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const imp of importers.get(cur) ?? []) {
        if (seen.has(imp)) continue;
        seen.add(imp);
        if (isTestPath(imp)) { note(imp, cur === c ? `imports ${c}` : `imports ${cur}, which depends on ${c}`); hit = true; }
        else queue.push(imp);
      }
    }
    // 2. name match
    const stem = stemOf(c);
    for (const t of allTests) if (t !== c && stemOf(t) === stem) { note(t, `name matches ${c}`); hit = true; }
    if (!hit) uncovered.push(c);
  }

  return { tests: Object.keys(reasons).sort(), reasons, uncovered, scanned: known.size, truncated };
}
