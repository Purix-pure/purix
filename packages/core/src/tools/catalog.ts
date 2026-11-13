// packages/core/src/tools/catalog.ts
//
// ADR-060 D2/D3: the shipped catalog, its validator, and the one hash function for lock files.
import { createHash } from "node:crypto";
import { CATALOG_DATA } from "./catalog_data.js";
import type { CatalogEntry, Capability, ToolGroup } from "./types.js";

/** sha256 over the lock files, names sorted, NUL-separated. Must match scripts/generate-tool-catalog.mjs. */
export function hashLockFiles(files: Record<string, string>): string {
  const h = createHash("sha256");
  for (const name of Object.keys(files).sort()) {
    h.update(name);
    h.update("\0");
    h.update(files[name] ?? "");
    h.update("\0");
  }
  return h.digest("hex");
}

export interface CatalogProblem {
  id: string;
  problem: string;
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * Structural checks on one entry. Pure. `lock-invalid` in the installer comes from here.
 * pip: every requirement line is `name==x.y.z` (optionally with an environment marker) followed by
 * at least one sha256 hash, and there is no URL/path/editable requirement.
 * npm: package.json depends on exactly one exact version; every package in package-lock.json
 * (other than the root) has an `integrity` of sha512 and a `resolved` https URL.
 */
export function validateEntry(entry: CatalogEntry): string[] {
  const problems: string[] = [];
  if (!EXACT_VERSION.test(entry.version)) problems.push(`version "${entry.version}" is not an exact version`);
  if (!Number.isFinite(Date.parse(entry.releasedAt))) problems.push("releasedAt is not a valid date");
  if (entry.capabilities.length === 0) problems.push("no capabilities");
  if (entry.languages.length === 0) problems.push("no languages");
  if (entry.platforms.length === 0) problems.push("no platforms");
  if (entry.lockSha256 !== hashLockFiles(entry.files)) problems.push("lockSha256 does not match files");

  if (entry.method === "pip-venv") {
    const text = entry.files["requirements.txt"];
    if (typeof text !== "string" || text.trim() === "") {
      problems.push("requirements.txt missing");
    } else {
      problems.push(...validatePipLock(text, entry.package, entry.version));
    }
  } else {
    problems.push(...validateNpmFiles(entry));
  }
  return problems;
}

function validatePipLock(text: string, pkg: string, version: string): string[] {
  const problems: string[] = [];
  // Join continuation lines (`\` at end) so each requirement is one logical line.
  const logical = text.replace(/\\\r?\n/g, " ").split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
  if (logical.length === 0) return ["requirements.txt has no requirements"];
  let sawTop = false;
  for (const line of logical) {
    if (line.startsWith("-")) {
      problems.push(`option line not allowed in a catalog lock: ${line.slice(0, 40)}`);
      continue;
    }
    const m = /^([A-Za-z0-9_.-]+)==([^\s;]+)(\s*;[^-]*?)?\s+--hash=/.exec(line);
    if (!m) {
      problems.push(`requirement is not "name==version" followed by --hash: ${line.slice(0, 60)}`);
      continue;
    }
    if (!/--hash=sha256:[0-9a-f]{64}/.test(line)) problems.push(`${m[1]} has no sha256 hash`);
    if (/--hash=(?!sha256:)/.test(line)) problems.push(`${m[1]} has a non-sha256 hash`);
    if (m[1]!.toLowerCase().replace(/_/g, "-") === pkg.toLowerCase() && m[2] === version) sawTop = true;
  }
  if (!sawTop) problems.push(`lock does not pin ${pkg}==${version}`);
  return problems;
}

function validateNpmFiles(entry: CatalogEntry): string[] {
  const problems: string[] = [];
  const pkgText = entry.files["package.json"];
  const lockText = entry.files["package-lock.json"];
  if (typeof pkgText !== "string" || typeof lockText !== "string") return ["package.json and package-lock.json are both required"];
  try {
    const pkg = JSON.parse(pkgText) as { dependencies?: Record<string, string> };
    const deps = Object.entries(pkg.dependencies ?? {});
    if (deps.length !== 1 || deps[0]![0] !== entry.package || deps[0]![1] !== entry.version) {
      problems.push(`package.json must depend on exactly ${entry.package}@${entry.version}`);
    }
  } catch {
    problems.push("package.json is not valid JSON");
  }
  try {
    const lock = JSON.parse(lockText) as { lockfileVersion?: number; packages?: Record<string, { integrity?: string; resolved?: string; link?: boolean }> };
    if (!lock.packages) {
      problems.push("package-lock.json has no packages map");
    } else {
      let count = 0;
      for (const [path, p] of Object.entries(lock.packages)) {
        if (path === "") continue;
        count++;
        if (!p.integrity || !p.integrity.startsWith("sha512-")) problems.push(`${path} has no sha512 integrity`);
        if (!p.resolved || !p.resolved.startsWith("https://")) problems.push(`${path} has no https resolved URL`);
      }
      if (count === 0) problems.push("package-lock.json lists no packages");
    }
  } catch {
    problems.push("package-lock.json is not valid JSON");
  }
  return problems;
}

export function validateCatalog(entries: readonly CatalogEntry[]): CatalogProblem[] {
  const out: CatalogProblem[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.id)) out.push({ id: e.id, problem: "duplicate id" });
    seen.add(e.id);
    for (const p of validateEntry(e)) out.push({ id: e.id, problem: p });
  }
  return out;
}

/** The catalog shipped with this release. */
export function shippedCatalog(): readonly CatalogEntry[] {
  return CATALOG_DATA;
}

export function findEntry(catalog: readonly CatalogEntry[], id: string): CatalogEntry | undefined {
  return catalog.find((e) => e.id === id);
}

export interface ListFilter {
  group?: ToolGroup;
  capability?: Capability;
  language?: string;
}

export function filterCatalog(catalog: readonly CatalogEntry[], f: ListFilter = {}): CatalogEntry[] {
  return catalog
    .filter((e) => (f.group ? e.group === f.group : true))
    .filter((e) => (f.capability ? e.capabilities.includes(f.capability) : true))
    .filter((e) => (f.language ? e.languages.includes(f.language) : true))
    .slice()
    .sort((a, b) => a.group.localeCompare(b.group) || a.id.localeCompare(b.id));
}
