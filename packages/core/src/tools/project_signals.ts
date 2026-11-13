// packages/core/src/tools/project_signals.ts
//
// ADR-060 D5: which catalog tools does THIS project already use? Read-only, never writes.
// Text matching on purpose (declared names only); it influences ranking and the stated reasons,
// not whether anything is installed.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CatalogEntry, ProjectSignals } from "./types.js";

function readText(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function declaredInNodeManifest(baseDir: string, entry: CatalogEntry): boolean {
  const text = readText(join(baseDir, "package.json"));
  if (text === "") return false;
  try {
    const pkg = JSON.parse(text) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    return entry.package in (pkg.dependencies ?? {}) || entry.package in (pkg.devDependencies ?? {});
  } catch {
    return false;
  }
}

function declaredInPythonFiles(baseDir: string, entry: CatalogEntry): boolean {
  const names = ["pyproject.toml", "setup.cfg", "tox.ini"];
  try {
    for (const f of readdirSync(baseDir)) if (/^requirements.*\.txt$/.test(f)) names.push(f);
  } catch {
    return false;
  }
  const re = new RegExp(`(^|[^A-Za-z0-9_-])${entry.package.replace(/[-.]/g, "[-_.]")}([^A-Za-z0-9_-]|$)`, "im");
  return names.some((n) => re.test(readText(join(baseDir, n))));
}

export function detectProjectSignals(baseDir: string, catalog: readonly CatalogEntry[]): ProjectSignals {
  const declared = new Set<string>();
  const binaries = new Set<string>();
  for (const e of catalog) {
    const isDeclared = e.method === "npm-ci" ? declaredInNodeManifest(baseDir, e) : declaredInPythonFiles(baseDir, e);
    if (isDeclared) declared.add(e.id);
    if (e.method === "npm-ci") {
      const dir = join(baseDir, "node_modules", ".bin");
      if (existsSync(join(dir, e.bin)) || existsSync(join(dir, `${e.bin}.cmd`))) binaries.add(e.id);
    }
  }
  return { declaredIds: declared, projectBinaryIds: binaries };
}

/** Language ids this folder looks like it uses (marker files only; read-only). Used as plan's default scope. */
export function guessLanguages(baseDir: string): string[] {
  const out: string[] = [];
  if (existsSync(join(baseDir, "package.json")) || existsSync(join(baseDir, "tsconfig.json"))) out.push("typescript");
  const py = ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"].some((f) => existsSync(join(baseDir, f)));
  if (py) out.push("python");
  return out;
}
