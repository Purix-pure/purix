// src/verify/python_test_discovery.ts
//
// Which pytest files are RELATED to a changed Python file. Same two relations as the JS/TS rule in
// test_discovery.ts, using Python's own conventions, and the same result shape so the sandbox, the
// trust gate and the "not tested" reporting treat both languages alike.
//
//   1. NAME:    test_x.py or x_test.py for a changed x.py.
//   2. IMPORTS: a test that imports the changed module, directly or through other project files.
//   3. conftest.py: a changed conftest selects every test below its folder (it shapes them all).
// A changed test file selects itself.
//
// Deliberate limits, reported rather than hidden:
//  - Imports are found by pattern, not by running Python. A module is matched by its dotted path suffix
//    (src/pkg/mod.py is "mod", "pkg.mod" and "src.pkg.mod"), so two files that share a short name can
//    match each other. That OVER-matches: it can run an extra test, never skip one.
//  - Dynamic imports (importlib, __import__), imports built from variables, and installed packages are
//    not followed.
//  - Only .py files are scanned; the scan stops at MAX_FILES and says so (`truncated`).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { TestDiscovery } from "./test_discovery.js";
import { PURIX_DIRNAME } from "../platform/layout.js";

const SKIP_DIRS = new Set([
  "node_modules", ".git", PURIX_DIRNAME, "dist", "build", "out", "__pycache__", ".venv", "venv", "env",
  ".tox", ".nox", ".mypy_cache", ".pytest_cache", ".ruff_cache", "site-packages", ".eggs",
]);
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 1_000_000;

const norm = (p: string) => p.split(sep).join("/");

export function isPythonFile(path: string): boolean {
  return path.endsWith(".py");
}

/** pytest's default file patterns (test_*.py, *_test.py), conftest.py, and any .py inside a tests/ or test/ folder. */
export function isPythonTestPath(relPath: string): boolean {
  const p = norm(relPath);
  const file = basename(p);
  if (!file.endsWith(".py")) return false;
  if (/^test_.*\.py$/.test(file) || /_test\.py$/.test(file) || file === "conftest.py") return true;
  return p.split("/").slice(0, -1).some((s) => s === "tests" || s === "test");
}

/** A file pytest collects by default. Only these can be handed to pytest as a target (anything else exits "no tests collected"). */
export function isPytestFile(relPath: string): boolean {
  const file = basename(norm(relPath));
  return /^test_.*\.py$/.test(file) || /_test\.py$/.test(file);
}

function stemOf(file: string): string {
  return basename(file).replace(/\.py$/, "").replace(/^test_/, "").replace(/_test$/, "");
}

function walk(baseDir: string): { files: string[]; truncated: boolean } {
  const files: string[] = [];
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
      if (!name.endsWith(".py") || st.size > MAX_FILE_BYTES) continue;
      if (files.length >= MAX_FILES) return { files, truncated: true };
      files.push(norm(relative(baseDir, full)));
    }
  }
  return { files, truncated: false };
}

/** Every dotted name a file can be imported as: each suffix of its path ("src/pkg/mod.py" -> mod, pkg.mod, src.pkg.mod). */
export function moduleKeys(relPath: string): string[] {
  const parts = norm(relPath).replace(/\.py$/, "").split("/");
  if (parts[parts.length - 1] === "__init__") parts.pop(); // pkg/__init__.py is "pkg"
  const keys: string[] = [];
  for (let i = parts.length - 1; i >= 0; i--) keys.push(parts.slice(i).join("."));
  return keys;
}

interface ImportRef { level: number; module: string; names: string[] }

const FROM_RE = /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]*)/gm;
const IMPORT_RE = /^[ \t]*import[ \t]+([^\n]+)/gm;

function nameList(raw: string): string[] {
  return raw
    .replace(/[()]/g, " ")
    .split("\n").map((l) => l.split("#")[0]!).join(",") // strip a comment per line, then treat lines as separate names
    .split(",")
    .map((n) => n.trim().split(/\s+as\s+/)[0]!.trim())
    .filter((n) => /^[A-Za-z_]\w*$/.test(n));
}

export function extractPythonImports(source: string): ImportRef[] {
  const refs: ImportRef[] = [];
  for (const m of source.matchAll(FROM_RE)) {
    refs.push({ level: m[1]!.length, module: m[2]!, names: nameList(m[3]!) });
  }
  for (const m of source.matchAll(IMPORT_RE)) {
    for (const part of m[1]!.split("#")[0]!.split(",")) {
      const mod = part.trim().split(/\s+as\s+/)[0]!.trim();
      if (/^[A-Za-z_][\w.]*$/.test(mod)) refs.push({ level: 0, module: mod, names: [] });
    }
  }
  return refs;
}

/** Files an import statement in `fromRel` can refer to. */
function resolveImport(ref: ImportRef, fromRel: string, known: Set<string>, byKey: Map<string, string[]>): string[] {
  const out = new Set<string>();
  if (ref.level === 0) {
    const names = [ref.module, ...ref.names.map((n) => (ref.module ? `${ref.module}.${n}` : n))];
    for (const n of names) for (const f of byKey.get(n) ?? []) out.add(f);
    return [...out];
  }
  // relative: "." is the file's own folder, ".." its parent, and so on
  let base = norm(dirname(fromRel));
  for (let i = 1; i < ref.level; i++) base = base === "." || base === "" ? "." : norm(dirname(base));
  const at = (rel: string) => (base === "." || base === "" ? rel : `${base}/${rel}`);
  const tryModule = (dotted: string) => {
    const path = at(dotted.replace(/\./g, "/"));
    if (known.has(`${path}.py`)) out.add(`${path}.py`);
    if (known.has(`${path}/__init__.py`)) out.add(`${path}/__init__.py`);
  };
  if (ref.module) {
    tryModule(ref.module);
    for (const n of ref.names) tryModule(`${ref.module}.${n}`);
  } else {
    if (known.has(at("__init__.py"))) out.add(at("__init__.py"));
    for (const n of ref.names) tryModule(n);
  }
  return [...out];
}

export function discoverRelatedPythonTests(changedPaths: string[], baseDir: string): TestDiscovery {
  const changed = changedPaths.map((p) => norm(p).replace(/^\.\//, "")).filter(isPythonFile);
  const { files, truncated } = walk(baseDir);
  const known = new Set(files);
  for (const c of changed) known.add(c); // a changed file is real even if the scan skipped it

  const byKey = new Map<string, string[]>();
  for (const f of known) for (const k of moduleKeys(f)) (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(f);

  // reverse graph: file -> files that import it
  const importers = new Map<string, Set<string>>();
  for (const f of known) {
    let src: string;
    try { src = readFileSync(resolve(baseDir, f), "utf-8"); } catch { continue; }
    for (const ref of extractPythonImports(src)) {
      for (const target of resolveImport(ref, f, known, byKey)) {
        if (target === f) continue;
        (importers.get(target) ?? importers.set(target, new Set()).get(target)!).add(f);
      }
    }
  }

  const reasons: Record<string, string[]> = {};
  const note = (test: string, why: string) => {
    const list = (reasons[test] ??= []);
    if (!list.includes(why)) list.push(why);
  };
  const allTests = [...known].filter(isPytestFile);
  const uncovered: string[] = [];

  for (const c of changed) {
    if (basename(c) === "conftest.py") {
      const dir = norm(dirname(c));
      const below = allTests.filter((t) => dir === "." || t.startsWith(`${dir}/`));
      for (const t of below) note(t, `conftest.py (${c}) applies to it`);
      if (below.length === 0) uncovered.push(c);
      continue;
    }
    if (isPytestFile(c)) { note(c, "is the changed file"); continue; }
    let hit = false;
    const seen = new Set<string>([c]);
    const queue = [c];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const imp of importers.get(cur) ?? []) {
        if (seen.has(imp)) continue;
        seen.add(imp);
        if (isPytestFile(imp)) { note(imp, cur === c ? `imports ${c}` : `imports ${cur}, which depends on ${c}`); hit = true; }
        else queue.push(imp);
      }
    }
    const stem = stemOf(c);
    for (const t of allTests) if (t !== c && stemOf(t) === stem) { note(t, `name matches ${c}`); hit = true; }
    if (!hit) uncovered.push(c);
  }

  return { tests: Object.keys(reasons).sort(), reasons, uncovered, scanned: known.size, truncated };
}
