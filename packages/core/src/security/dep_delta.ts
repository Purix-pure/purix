// src/security/dep_delta.ts
//
// F03-02 (research 03, task 3.4): which dependencies did THIS change add or raise? A scan of the whole old tree answers a different
// question and can read clean for a change that adds a vulnerable package. This module only works out the (ecosystem, name, version)
// pairs a change introduced, from package.json, package-lock.json and requirements.txt. It reads files it is handed and does no
// network and no process call, so the gate can use it on the synchronous path.
//
// A package.json holds ranges (^4.17.15), and a range does not name the version that will be installed, so a pair from a range has no
// `version` and cannot be looked up from the manifest alone. A lockfile does name exact versions. A git, URL, path or workspace
// source is not a registry version at all and is never given one.

import { isLockfile, isPyproject, lockPairs, pyprojectPairs } from "./lock_parsers.js";

export interface DepPair {
  ecosystem: "npm" | "PyPI";
  name: string;
  /** What the file says: an exact version, a range, or a source. */
  spec: string;
  /** Set only when the file names one exact registry version. A range or a non-registry source has none. */
  version?: string;
}

/** F03-03: what a registry said about one name. `missing` is a 404; a lookup that failed or was refused has no verdict at all (it is "not checked"). */
export interface RegistryVerdict {
  ecosystem: "npm" | "PyPI";
  name: string;
  state: "exists" | "missing";
  /** When the name was first published (ISO 8601), when the registry said. */
  created?: string;
  /** The registry host that answered, so a person can see which registry was asked. */
  host: string;
}

/**
 * True when a spec names a package that is fetched from a registry by name, so asking a registry "does this name exist" is meaningful.
 * False for git, URL, path, workspace, catalog, alias and `name @ url` forms: those do not resolve through the registry by this name.
 */
export function isRegistrySpec(spec: string): boolean {
  const s = spec.trim();
  if (/^(?:git\+[a-z]+:|git:|github:|gitlab:|bitbucket:|gist:|https?:|file:|link:|portal:|patch:|workspace:|catalog:|npm:)/i.test(s)) return false;
  if (/^[\w.-]+\/[\w.-]+(?:#.+)?$/.test(s)) return false; // GitHub shorthand
  if (/^(?:\.{0,2}\/|~\/)/.test(s)) return false;
  if (/^@\s|^git\+|^https?:|^file:/i.test(s)) return false; // PEP 508 direct reference
  return true;
}

export interface ManifestDelta {
  pairs: DepPair[];
  /** The file is a manifest but could not be read, so the delta is unknown (an empty list would read as "nothing added"). */
  unreadable?: boolean;
}

const EXACT_SEMVER = /^=?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;
const PIN_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

function baseName(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

/** True for the file names this module reads. */
export function isDependencyFile(path: string): boolean {
  const n = baseName(path).toLowerCase();
  return n === "package.json" || n === "requirements.txt" || isLockfile(path) || isPyproject(path);
}

function exactVersion(spec: string): string | undefined {
  const m = EXACT_SEMVER.exec(spec.trim());
  return m ? m[1] : undefined;
}

function npmPairsFromPackageJson(text: string): Map<string, DepPair> | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof json !== "object" || json === null) return undefined;
  const out = new Map<string, DepPair>();
  for (const section of PIN_SECTIONS) {
    const deps = (json as Record<string, unknown>)[section];
    if (typeof deps !== "object" || deps === null) continue;
    for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof spec !== "string") continue;
      const version = exactVersion(spec);
      out.set(name, { ecosystem: "npm", name, spec, ...(version ? { version } : {}) });
    }
  }
  return out;
}

function pypiPairsFromRequirements(text: string): Map<string, DepPair> {
  const out = new Map<string, DepPair>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s#.*$/, "").trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(.*)$/.exec(line.split(";")[0] ?? "");
    if (!m) continue;
    const name = (m[1] ?? "").toLowerCase().replace(/_/g, "-");
    const rest = (m[2] ?? "").trim();
    const pin = /^===?\s*([0-9][0-9A-Za-z.+!_-]*)$/.exec(rest);
    out.set(name, { ecosystem: "PyPI", name, spec: rest || "(unpinned)", ...(pin ? { version: pin[1] } : {}) });
  }
  return out;
}

function parse(path: string, text: string): Map<string, DepPair> | undefined {
  const n = baseName(path).toLowerCase();
  if (n === "package.json") return npmPairsFromPackageJson(text);
  if (isLockfile(path)) return lockPairs(path, text);
  if (isPyproject(path)) return pyprojectPairs(text);
  if (n === "requirements.txt") return pypiPairsFromRequirements(text);
  return undefined;
}

/**
 * The pairs `next` has that `base` did not have, or had with a different spec. `base` undefined means a new file: everything is added.
 * A base that cannot be read is treated as empty (every pair counts as added: more is reported, never less). A `next` that cannot be
 * read gives `unreadable`, never an empty clean list.
 */
export function manifestDelta(path: string, base: string | undefined, next: string): ManifestDelta {
  if (!isDependencyFile(path)) return { pairs: [] };
  const after = parse(path, next);
  if (after === undefined) return { pairs: [], unreadable: true };
  const before = base === undefined ? new Map<string, DepPair>() : (parse(path, base) ?? new Map<string, DepPair>());
  const pairs: DepPair[] = [];
  for (const [key, pair] of after) {
    const old = before.get(key);
    if (old === undefined || old.spec !== pair.spec) pairs.push(pair);
  }
  return { pairs };
}
