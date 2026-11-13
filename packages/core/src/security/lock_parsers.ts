// src/security/lock_parsers.ts
//
// F03-02 remainder (research 03, tasks 3.3, 3.4, 3.5): read what each package manager's lockfile and Python manifest says, as plain data.
// Pure text parsing, no network, no process call, no YAML or TOML library: each reader looks only for the few fields the checks need
// (name, version, where it was fetched from, the integrity value), line by line, and returns undefined when the text is not the format
// it expected, so the caller reports "could not read" and never an empty clean list.
//
// Formats read: package-lock.json / npm-shrinkwrap.json (lockfileVersion 1 to 3), pnpm-lock.yaml (v5, v6, v9 `packages:` section),
// yarn.lock (classic v1 and Berry), poetry.lock, uv.lock, and pyproject.toml dependency lists (PEP 621, PEP 735, Poetry).
// Written against format knowledge and hand-made fixtures; NOT run against real lockfiles from each tool (this workspace has no network to
// fetch them), so a format change or an unusual file may read as `undefined` ("not checked").
import type { DepPair } from "./dep_delta.js";

export interface LockEntry {
  /** Unique within one file: the install location for npm, `name@version` elsewhere. */
  key: string;
  ecosystem: "npm" | "PyPI";
  name: string;
  version: string;
  /** Where the file says the package was fetched from (a tarball URL, a git URL, a resolution string). */
  resolved?: string;
  /** The integrity or checksum value the file records. */
  integrity?: string;
  /** True when the entry does not come from a registry by name (git, URL, path, a private index): it is never looked up by name. */
  nonRegistry?: boolean;
}

const baseName = (p: string): string => (p.replace(/\\/g, "/").split("/").pop() ?? p).toLowerCase();

export function isLockfile(path: string): boolean {
  return ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "poetry.lock", "uv.lock"].includes(baseName(path));
}

export function isPyproject(path: string): boolean {
  return baseName(path) === "pyproject.toml";
}

// ---- npm ---------------------------------------------------------------------------------------------------------------------------

function npmLock(text: string): Map<string, LockEntry> | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof json !== "object" || json === null) return undefined;
  const root = json as Record<string, unknown>;
  const out = new Map<string, LockEntry>();
  const add = (key: string, name: string, e: Record<string, unknown>): void => {
    const version = e["version"];
    if (typeof version !== "string") return;
    const resolved = typeof e["resolved"] === "string" ? (e["resolved"]) : undefined;
    const integrity = typeof e["integrity"] === "string" ? (e["integrity"]) : undefined;
    const link = e["link"] === true;
    out.set(key, {
      key, ecosystem: "npm", name, version,
      ...(resolved !== undefined ? { resolved } : {}),
      ...(integrity !== undefined ? { integrity } : {}),
      // A registry tarball URL ends in /-/<file>.tgz. Anything else (a git URL, a codeload tarball, a file: path) did not come from a registry by name.
      ...(link || (resolved !== undefined && !/\/-\/[^/?#]+\.tgz(?:[?#].*)?$/.test(resolved)) ? { nonRegistry: true } : {}),
    });
  };
  const packages = root["packages"];
  if (typeof packages === "object" && packages !== null) {
    for (const [key, entry] of Object.entries(packages as Record<string, unknown>)) {
      if (key === "" || typeof entry !== "object" || entry === null) continue;
      const at = key.lastIndexOf("node_modules/");
      if (at < 0) continue; // a workspace folder, not an installed package
      add(key, key.slice(at + "node_modules/".length), entry as Record<string, unknown>);
    }
    return out;
  }
  const deps = root["dependencies"]; // lockfileVersion 1: nested
  if (typeof deps === "object" && deps !== null) {
    const walk = (obj: Record<string, unknown>, prefix: string): void => {
      for (const [name, entry] of Object.entries(obj)) {
        if (typeof entry !== "object" || entry === null) continue;
        const e = entry as Record<string, unknown>;
        add(`${prefix}${name}`, name, e);
        if (typeof e["dependencies"] === "object" && e["dependencies"] !== null) walk(e["dependencies"] as Record<string, unknown>, `${prefix}${name}>`);
      }
    };
    walk(deps as Record<string, unknown>, "");
    return out;
  }
  return undefined;
}

// ---- pnpm --------------------------------------------------------------------------------------------------------------------------

const PNPM_KEY = /^ {2}['"]?\/?(@[^/@'"\s]+\/[^/@'"\s]+|[^/@'"\s]+)[@/](\d[^\s('"_:]*)[^'"]*['"]?:\s*$/;

function pnpmLock(text: string): Map<string, LockEntry> | undefined {
  const lines = text.split(/\r?\n/);
  if (!lines.some((l) => /^lockfileVersion:/.test(l))) return undefined;
  const out = new Map<string, LockEntry>();
  let inPackages = false;
  let current: LockEntry | undefined;
  for (const line of lines) {
    if (/^\S/.test(line)) {
      inPackages = /^packages:\s*$/.test(line);
      current = undefined;
      continue;
    }
    if (!inPackages) continue;
    const k = PNPM_KEY.exec(line);
    if (k) {
      const name = k[1]!;
      const version = k[2]!;
      current = { key: `${name}@${version}`, ecosystem: "npm", name, version };
      out.set(current.key, current);
      continue;
    }
    const r = /^ {4}resolution:\s*\{(.*)\}\s*$/.exec(line);
    if (r && current) {
      const body = r[1]!;
      const integrity = /integrity:\s*['"]?([^,}\s'"]+)/.exec(body)?.[1];
      const tarball = /tarball:\s*['"]?([^,}\s'"]+)/.exec(body)?.[1];
      const repo = /repo:\s*['"]?([^,}\s'"]+)/.exec(body)?.[1];
      const dir = /directory:\s*['"]?([^,}\s'"]+)/.exec(body)?.[1];
      if (integrity) current.integrity = integrity;
      const resolved = tarball ?? repo ?? dir;
      if (resolved) current.resolved = resolved;
      // A registry tarball ends in /-/<file>.tgz; any other tarball URL is a direct download, not a registry resolution by name.
      if (tarball && !/\/-\/[^/?#]+\.tgz(?:[?#].*)?$/.test(tarball)) current.nonRegistry = true;
      if (repo || dir || /type:\s*['"]?(?:git|directory)/.test(body)) current.nonRegistry = true;
    }
  }
  return out;
}

// ---- yarn --------------------------------------------------------------------------------------------------------------------------

function yarnNameFromSpec(spec: string): string | undefined {
  const s = spec.trim().replace(/^["']|["']$/g, "");
  const at = s.indexOf("@", 1);
  return at > 0 ? s.slice(0, at) : undefined;
}

function yarnLock(text: string): Map<string, LockEntry> | undefined {
  const lines = text.split(/\r?\n/);
  if (!lines.some((l) => /^# yarn lockfile v1/.test(l) || /^__metadata:/.test(l))) return undefined;
  const out = new Map<string, LockEntry>();
  let name: string | undefined;
  let cur: LockEntry | undefined;
  const flush = (): void => {
    if (cur) out.set(cur.key, cur);
    cur = undefined;
  };
  for (const line of lines) {
    if (/^[^\s#].*:\s*$/.test(line) && !line.startsWith("__metadata")) {
      flush();
      name = yarnNameFromSpec(line.replace(/:\s*$/, "").split(",")[0]!);
      cur = undefined;
      continue;
    }
    if (!name) continue;
    const v = /^ {2}version:?\s+["']?([^"'\s]+)["']?\s*$/.exec(line);
    if (v) {
      flush();
      cur = { key: `${name}@${v[1]}`, ecosystem: "npm", name, version: v[1]! };
      continue;
    }
    if (!cur) continue;
    const res = /^ {2}resolved\s+["']([^"']+)["']\s*$/.exec(line);
    if (res) {
      cur.resolved = res[1]!;
      if (/^git|^ssh|^file:|^https?:\/\/(?!.*\.tgz)/i.test(res[1]!)) cur.nonRegistry = true;
    }
    const resB = /^ {2}resolution:\s+["']([^"']+)["']\s*$/.exec(line);
    if (resB) {
      cur.resolved = resB[1]!;
      if (!/@npm:/.test(resB[1]!)) cur.nonRegistry = true;
    }
    const integ = /^ {2}(?:integrity\s+|checksum:\s+)["']?([^"'\s]+)["']?\s*$/.exec(line);
    if (integ) cur.integrity = integ[1]!;
  }
  flush();
  return out;
}

// ---- Python lockfiles --------------------------------------------------------------------------------------------------------------

function pyLock(text: string, isUv: boolean): Map<string, LockEntry> | undefined {
  if (!/^\[\[package\]\]/m.test(text)) return undefined;
  const out = new Map<string, LockEntry>();
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const version = /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    if (!name || !version) continue;
    const norm = name.toLowerCase().replace(/_/g, "-");
    // Anything with a source table is not a plain PyPI download (git, URL, directory, a private index): never looked up by name.
    const source = isUv ? /^source\s*=\s*\{([^}]*)\}/m.exec(block)?.[1] : /^\[package\.source\]/m.test(block) ? "poetry source" : undefined;
    const registryUv = isUv && source !== undefined && /\bregistry\s*=\s*"https:\/\/pypi\.org\/simple\/?"/.test(source);
    const nonRegistry = source !== undefined && !registryUv;
    const hash = /\bhash\s*=\s*"(sha256:[0-9a-f]+)"/.exec(block)?.[1];
    out.set(`${norm}@${version}`, {
      key: `${norm}@${version}`, ecosystem: "PyPI", name: norm, version,
      ...(source !== undefined ? { resolved: source.replace(/\s+/g, " ").trim() } : {}),
      ...(hash ? { integrity: hash } : {}),
      ...(nonRegistry ? { nonRegistry: true } : {}),
    });
  }
  return out;
}

/** Entries of one lockfile, or undefined when the text is not the format its file name promises. */
export function parseLockEntries(path: string, text: string): Map<string, LockEntry> | undefined {
  switch (baseName(path)) {
    case "package-lock.json":
    case "npm-shrinkwrap.json": return npmLock(text);
    case "pnpm-lock.yaml": return pnpmLock(text);
    case "yarn.lock": return yarnLock(text);
    case "poetry.lock": return pyLock(text, false);
    case "uv.lock": return pyLock(text, true);
    default: return undefined;
  }
}

/** The (name, version) pairs of a lockfile, in the shape dep_delta works with. A non-registry entry carries no version, so it is never looked up. */
export function lockPairs(path: string, text: string): Map<string, DepPair> | undefined {
  const entries = parseLockEntries(path, text);
  if (!entries) return undefined;
  const out = new Map<string, DepPair>();
  for (const [key, e] of entries) {
    out.set(key, e.nonRegistry ? { ecosystem: e.ecosystem, name: e.name, spec: e.resolved ?? "git+", } : { ecosystem: e.ecosystem, name: e.name, spec: e.version, version: e.version });
  }
  return out;
}

// ---- pyproject.toml ----------------------------------------------------------------------------------------------------------------

const PEP508 = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(.*)$/;

function pep508Pair(raw: string): DepPair | undefined {
  const body = raw.split(";")[0]!.trim();
  const m = PEP508.exec(body);
  if (!m) return undefined;
  const name = m[1]!.toLowerCase().replace(/_/g, "-");
  const rest = (m[2] ?? "").trim();
  const pin = /^===?\s*([0-9][0-9A-Za-z.+!_-]*)$/.exec(rest);
  return { ecosystem: "PyPI", name, spec: rest || "(unpinned)", ...(pin ? { version: pin[1]! } : {}) };
}

/** The tables of a TOML file as [header, body] pairs, by header line. Enough for the dependency tables below; not a TOML parser. */
function tomlTables(text: string): [string, string][] {
  const out: [string, string][] = [];
  let header = "";
  let body: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const h = /^\s*\[{1,2}([^\]]+)\]{1,2}\s*$/.exec(line);
    if (h && !/^\s*[A-Za-z0-9_.-]+\s*=/.test(line)) {
      out.push([header, body.join("\n")]);
      header = h[1]!.trim();
      body = [];
    } else body.push(line);
  }
  out.push([header, body.join("\n")]);
  return out;
}

function stringsIn(arrayBody: string): string[] {
  const out: string[] = [];
  for (const m of arrayBody.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)) out.push(m[1] ?? m[2] ?? "");
  return out;
}

/** Dependency pairs from pyproject.toml: PEP 621 `dependencies` and optional groups, PEP 735 `dependency-groups`, and Poetry's dependency tables. */
export function pyprojectPairs(text: string): Map<string, DepPair> | undefined {
  if (!/\[(?:project|tool\.poetry|dependency-groups)/.test(text)) return undefined;
  const out = new Map<string, DepPair>();
  const take = (p: DepPair | undefined): void => {
    if (p) out.set(p.name, p);
  };
  for (const [header, body] of tomlTables(text)) {
    if (header === "project") {
      const m = /^\s*dependencies\s*=\s*\[([\s\S]*?)\]\s*(?:\n|$)/m.exec(body);
      if (m) for (const s of stringsIn(m[1]!)) take(pep508Pair(s));
    } else if (header === "project.optional-dependencies" || header === "dependency-groups") {
      for (const m of body.matchAll(/^\s*[A-Za-z0-9_.-]+\s*=\s*\[([\s\S]*?)\]\s*(?:\n|$)/gm)) for (const s of stringsIn(m[1]!)) take(pep508Pair(s));
    } else if (/^tool\.poetry(?:\.group\.[^.]+)?\.dependencies$/.test(header) || header === "tool.poetry.dev-dependencies") {
      for (const m of body.matchAll(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=\s*(.+)$/gm)) {
        const name = m[1]!.toLowerCase().replace(/_/g, "-");
        if (name === "python") continue;
        const value = m[2]!.trim();
        if (value.startsWith("{")) {
          if (/\b(?:git|url|path)\s*=/.test(value)) {
            out.set(name, { ecosystem: "PyPI", name, spec: `git+${/\b(?:git|url|path)\s*=\s*"([^"]+)"/.exec(value)?.[1] ?? "source"}` });
            continue;
          }
          const v = /\bversion\s*=\s*"([^"]+)"/.exec(value)?.[1];
          if (v) {
            const exact = /^=?=?\s*(\d[0-9A-Za-z.+!_-]*)$/.exec(v);
            out.set(name, { ecosystem: "PyPI", name, spec: v, ...(exact ? { version: exact[1]! } : {}) });
          }
          continue;
        }
        const s = /^"([^"]*)"|^'([^']*)'/.exec(value);
        const spec = s ? (s[1] ?? s[2] ?? "") : undefined;
        if (spec === undefined) continue;
        const exact = /^=?=?\s*(\d[0-9A-Za-z.+!_-]*)$/.exec(spec);
        out.set(name, { ecosystem: "PyPI", name, spec: spec || "*", ...(exact ? { version: exact[1]! } : {}) });
      }
    }
  }
  return out;
}
