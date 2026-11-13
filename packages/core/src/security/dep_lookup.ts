// src/security/dep_lookup.ts
//
// F03-03 and the lookup half of F03-02 (research 03, tasks 3.1 and 3.4; decision D-q, docs/DECISIONS-2026-11-12.md).
//
// What it does: for the dependencies a change ADDS or RAISES, ask (a) the package registry whether the name exists and when it was first
// published, and (b) OSV whether the exact (name, version) has advisories or a malicious-package record (`MAL-` ids). It is OFF unless
// PURIX_DEP_LOOKUP is set, because it sends package names off the machine.
//
// How it fits the synchronous gate (ADR-009 keeps the network out of the gate's own path): the caller awaits `prefetchDependencyLookup`
// BEFORE verification, which fills an in-memory cache; the gate then reads the cache through `dependencyGateOptions()`, synchronously. A
// pair the cache does not hold is "not checked", never clean. Anything that goes wrong (offline, a 5xx, a refused request, a reply
// whose shape is unexpected) caches nothing for that pair, so the gate says "not checked".
//
// What leaves the machine, and only this: package names and exact versions, in the request URL (registry) or one JSON body (OSV, fixed host
// api.osv.dev). No file content, no headers, no credentials, no project name. A name that resolves to a private registry (a custom `registry=`
// or a `@scope:registry=` in the project's .npmrc) is never sent to OSV, because it could be a private package name.
//
// Limits stated on purpose: requests are unauthenticated, so a registry that needs a login answers 401 and the name is "not checked"; the
// cache lives for one process (10 minutes per entry); PyPI is asked at pypi.org only (pip.conf is not read); OSV records are matched by id,
// and whether OSV omits withdrawn records from `querybatch` was not verified.
import { readFileSync, statSync, realpathSync } from "node:fs";
import { isIP } from "node:net";
import { join, sep } from "node:path";
import { netFetch } from "../platform/net.js";
import { purixEnv } from "../platform/env.js";
import { resolveSafePath } from "../gates/path_guard.js";
import { isLockfile } from "./lock_parsers.js";
import { isDependencyFile, isRegistrySpec, manifestDelta, type DepPair, type RegistryVerdict } from "./dep_delta.js";

export interface DepLookupMode {
  osv: boolean;
  registry: boolean;
}

/** PURIX_DEP_LOOKUP: "all" (or "1", "on", "true") = both; "osv" or "registry" = one; anything else, or unset = off. Comma lists work ("osv,registry"). */
export function depLookupMode(): DepLookupMode {
  const raw = (purixEnv("PURIX_DEP_LOOKUP") ?? "").trim().toLowerCase();
  if (raw === "") return { osv: false, registry: false };
  const parts = raw.split(/[\s,]+/).filter(Boolean);
  if (parts.some((p) => ["all", "1", "on", "true", "yes"].includes(p))) return { osv: true, registry: true };
  return { osv: parts.includes("osv"), registry: parts.includes("registry") };
}

export const OSV_BATCH_URL = "https://api.osv.dev/v1/querybatch";
const NPM_DEFAULT_REGISTRY = "https://registry.npmjs.org";
const PYPI_BASE = "https://pypi.org/pypi";
const OSV_MAX_QUERIES = 1000; // documented maximum per batch request
const OSV_MAX_PAGES = 5;
const MAX_REGISTRY_BODY = 10 * 1024 * 1024;
const MAX_NAMES_PER_RUN = 200; // a change adding more than this is looked up for the first 200 only; the rest read "not checked"
const TTL_MS = 10 * 60 * 1000;

type Fetcher = typeof netFetch;
export interface LookupIo {
  fetch?: Fetcher;
  now?: () => number;
}

interface Timed<T> {
  at: number;
  value: T;
}
const advisoryCache = new Map<string, Timed<string[]>>();
const registryCache = new Map<string, Timed<RegistryVerdict>>();

export function clearDependencyLookupCache(): void {
  advisoryCache.clear();
  registryCache.clear();
}

const pairKey = (p: { ecosystem: string; name: string; version: string }) => `${p.ecosystem}\0${p.name}\0${p.version}`;
const nameKey = (p: { ecosystem: string; name: string }) => `${p.ecosystem}\0${p.name}`;

function fresh<T>(m: Map<string, Timed<T>>, key: string, now: number): T | undefined {
  const hit = m.get(key);
  if (!hit) return undefined;
  if (now - hit.at > TTL_MS) {
    m.delete(key);
    return undefined;
  }
  return hit.value;
}

// ---- reading the project's own registry settings ----------------------------------------------------------------------------------

const BASE_READ_LIMIT = 1024 * 1024;

function readProjectFile(targetDir: string, relPath: string): string | undefined {
  try {
    if (!resolveSafePath(targetDir, relPath).ok) return undefined;
    const real = realpathSync(join(targetDir, relPath));
    const root = realpathSync(targetDir);
    if (!real.startsWith(root.endsWith(sep) ? root : root + sep)) return undefined;
    const st = statSync(real);
    if (!st.isFile() || st.size > BASE_READ_LIMIT) return undefined;
    return readFileSync(real, "utf-8");
  } catch {
    return undefined;
  }
}

/** `registry=` and `@scope:registry=` lines of an .npmrc. Values that look like `${ENV}` templates are ignored (they cannot be resolved here). */
export function parseNpmrcRegistries(text: string | undefined): { registry?: string; scoped: Map<string, string> } {
  const scoped = new Map<string, string>();
  let registry: string | undefined;
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const line = raw.replace(/^\s+|\s+$/g, "");
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const m = /^(@[^:=\s]+:)?registry\s*=\s*(.+)$/.exec(line);
    if (!m) continue;
    const value = m[2]!.trim().replace(/^["']|["']$/g, "");
    if (value.includes("${")) continue;
    if (m[1]) scoped.set(m[1].slice(0, -1), value);
    else registry = value;
  }
  return { ...(registry !== undefined ? { registry } : {}), scoped };
}

/** True for a registry URL this module may call: https, a host name or public address (no loopback, private or link-local IP literal, no localhost). */
export function isAllowedRegistryUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "") return false;
  const h = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return false;
  const kind = isIP(h);
  if (kind === 4) {
    const [a, b] = h.split(".").map(Number) as [number, number];
    return !(a === 0 || a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127));
  }
  if (kind === 6) return false;
  return true;
}

export interface NpmRegistryChoice {
  /** The URL to ask, without a trailing slash; undefined when the project's setting cannot be used here. */
  url?: string;
  /** True when this is the public npm registry (so a name may go to OSV too). */
  isPublic: boolean;
}

export function npmRegistryFor(name: string, npmrc: ReturnType<typeof parseNpmrcRegistries>): NpmRegistryChoice {
  const scope = name.startsWith("@") ? name.slice(0, name.indexOf("/")) : undefined;
  const configured = (scope ? npmrc.scoped.get(scope) : undefined) ?? npmrc.registry;
  if (configured === undefined) return { url: NPM_DEFAULT_REGISTRY, isPublic: true };
  const url = configured.replace(/\/+$/, "");
  const isPublic = /^https:\/\/registry\.npmjs\.org$/i.test(url) || /^https:\/\/registry\.yarnpkg\.com$/i.test(url);
  return isAllowedRegistryUrl(url) ? { url, isPublic } : { isPublic: false };
}

// ---- the lookups -------------------------------------------------------------------------------------------------------------------

function encodeNpmName(name: string): string {
  return name.startsWith("@") ? `@${encodeURIComponent(name.slice(1)).replace(/%2F/g, "%2f")}` : encodeURIComponent(name);
}

async function readCapped(res: Response): Promise<string | undefined> {
  const len = Number(res.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > MAX_REGISTRY_BODY) {
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    return undefined;
  }
  const text = await res.text();
  return text.length > MAX_REGISTRY_BODY ? undefined : text;
}

async function askNpm(fetcher: Fetcher, base: string, name: string): Promise<RegistryVerdict | undefined> {
  const url = `${base}/${encodeNpmName(name)}`;
  const host = new URL(url).host;
  const res = await fetcher("dependency-lookup", url, { method: "GET", headers: { accept: "application/json" }, redirect: "manual" });
  if (res.status === 404) return { ecosystem: "npm", name, state: "missing", host };
  if (res.status !== 200) return undefined;
  const text = await readCapped(res);
  if (text === undefined) return { ecosystem: "npm", name, state: "exists", host }; // too large to read: a big, long-lived package
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const time = typeof json === "object" && json !== null ? (json as Record<string, unknown>)["time"] : undefined;
  const created = typeof time === "object" && time !== null ? (time as Record<string, unknown>)["created"] : undefined;
  return { ecosystem: "npm", name, state: "exists", host, ...(typeof created === "string" && !Number.isNaN(Date.parse(created)) ? { created } : {}) };
}

async function askPyPI(fetcher: Fetcher, name: string): Promise<RegistryVerdict | undefined> {
  const url = `${PYPI_BASE}/${encodeURIComponent(name)}/json`;
  const host = new URL(url).host;
  const res = await fetcher("dependency-lookup", url, { method: "GET", headers: { accept: "application/json" }, redirect: "manual" });
  if (res.status === 404) return { ecosystem: "PyPI", name, state: "missing", host };
  if (res.status !== 200) return undefined;
  const text = await readCapped(res);
  if (text === undefined) return { ecosystem: "PyPI", name, state: "exists", host };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  let earliest: number | undefined;
  const releases = typeof json === "object" && json !== null ? (json as Record<string, unknown>)["releases"] : undefined;
  if (typeof releases === "object" && releases !== null) {
    for (const files of Object.values(releases as Record<string, unknown>)) {
      if (!Array.isArray(files)) continue;
      for (const f of files) {
        const t = typeof f === "object" && f !== null ? (f as Record<string, unknown>)["upload_time_iso_8601"] : undefined;
        const ms = typeof t === "string" ? Date.parse(t) : NaN;
        if (!Number.isNaN(ms) && (earliest === undefined || ms < earliest)) earliest = ms;
      }
    }
  }
  return { ecosystem: "PyPI", name, state: "exists", host, ...(earliest !== undefined ? { created: new Date(earliest).toISOString() } : {}) };
}

interface OsvQuery {
  package: { name: string; ecosystem: string };
  version: string;
  page_token?: string;
}

/** One OSV batch with pagination. Returns the ids per query position, or undefined if the answer could not be trusted. */
async function askOsv(fetcher: Fetcher, queries: OsvQuery[]): Promise<string[][] | undefined> {
  const ids: string[][] = queries.map(() => []);
  let pending = queries.map((q, i) => ({ q, i }));
  for (let page = 0; page < OSV_MAX_PAGES && pending.length > 0; page++) {
    const res = await fetcher("dependency-lookup", OSV_BATCH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queries: pending.map((p) => p.q) }),
      redirect: "manual",
    });
    if (res.status !== 200) return undefined;
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return undefined;
    }
    const results = typeof json === "object" && json !== null ? (json as Record<string, unknown>)["results"] : undefined;
    // Results are positional. A different length means the reply cannot be matched to the questions, so none of it is used.
    if (!Array.isArray(results) || results.length !== pending.length) return undefined;
    const next: typeof pending = [];
    for (let k = 0; k < pending.length; k++) {
      const r = results[k];
      if (typeof r !== "object" || r === null) return undefined;
      const vulns = (r as Record<string, unknown>)["vulns"];
      if (vulns !== undefined) {
        if (!Array.isArray(vulns)) return undefined;
        for (const v of vulns) {
          const id = typeof v === "object" && v !== null ? (v as Record<string, unknown>)["id"] : undefined;
          if (typeof id === "string") ids[pending[k]!.i]!.push(id);
        }
      }
      const token = (r as Record<string, unknown>)["next_page_token"];
      if (typeof token === "string" && token !== "") next.push({ q: { ...pending[k]!.q, page_token: token }, i: pending[k]!.i });
    }
    pending = next;
  }
  return ids; // a query still holding a token after the page cap already has ids, which is enough to report it
}

/**
 * Looks up what this change adds, and fills the cache the gate reads. Never throws and never blocks the change: every failure means
 * "nothing cached for that pair", which the gate reports as not checked. Does nothing, and costs nothing, unless PURIX_DEP_LOOKUP is set.
 */
export async function prefetchDependencyLookup(files: { path: string; new_content: string }[], targetDir: string, io: LookupIo = {}): Promise<void> {
  const mode = depLookupMode();
  if (!mode.osv && !mode.registry) return;
  try {
    const fetcher = io.fetch ?? netFetch;
    const now = (io.now ?? Date.now)();
    const pairs: DepPair[] = [];
    const manifestPairs: DepPair[] = []; // names a manifest adds; a lockfile's transitive names are not asked about at the registry
    for (const f of files) {
      if (!isDependencyFile(f.path)) continue;
      const added = manifestDelta(f.path, readProjectFile(targetDir, f.path), f.new_content).pairs;
      pairs.push(...added);
      if (!isLockfile(f.path)) manifestPairs.push(...added);
    }
    if (pairs.length === 0) return;
    const npmrc = parseNpmrcRegistries(readProjectFile(targetDir, ".npmrc"));

    // (a) registry existence and first-publish date, one request per new name
    const wantedNames = new Map<string, DepPair>();
    for (const p of manifestPairs) if (isRegistrySpec(p.spec) && !wantedNames.has(nameKey(p))) wantedNames.set(nameKey(p), p);
    const publicNpm = new Set<string>(); // names known to resolve at the public npm registry, the only ones OSV may see
    if (mode.registry || mode.osv) {
      for (const p of wantedNames.values()) if (p.ecosystem === "npm" && npmRegistryFor(p.name, npmrc).isPublic) publicNpm.add(p.name);
    }
    if (mode.registry) {
      const todo = [...wantedNames.entries()].filter(([k]) => fresh(registryCache, k, now) === undefined).slice(0, MAX_NAMES_PER_RUN);
      await Promise.all(
        todo.map(async ([k, p]) => {
          try {
            let verdict: RegistryVerdict | undefined;
            if (p.ecosystem === "PyPI") verdict = await askPyPI(fetcher, p.name);
            else {
              const choice = npmRegistryFor(p.name, npmrc);
              verdict = choice.url ? await askNpm(fetcher, choice.url, p.name) : undefined;
            }
            if (verdict) registryCache.set(k, { at: now, value: verdict });
          } catch {
            /* nothing cached: reads as not checked */
          }
        })
      );
    }

    // (b) advisories for exact pairs. A private npm name never goes to OSV.
    if (mode.osv) {
      const exact = new Map<string, DepPair>();
      for (const p of pairs) {
        if (p.version === undefined || !isRegistrySpec(p.spec)) continue;
        if (p.ecosystem === "npm" && !publicNpm.has(p.name)) continue;
        const k = pairKey({ ecosystem: p.ecosystem, name: p.name, version: p.version });
        if (fresh(advisoryCache, k, now) === undefined) exact.set(k, p);
      }
      const list = [...exact.entries()];
      for (let i = 0; i < list.length; i += OSV_MAX_QUERIES) {
        const chunk = list.slice(i, i + OSV_MAX_QUERIES);
        try {
          const answers = await askOsv(fetcher, chunk.map(([, p]) => ({ package: { name: p.name, ecosystem: p.ecosystem }, version: p.version! })));
          if (!answers) continue;
          chunk.forEach(([k], idx) => advisoryCache.set(k, { at: now, value: answers[idx]! }));
        } catch {
          /* nothing cached for this chunk */
        }
      }
    }
  } catch {
    /* a lookup problem must never break a change */
  }
}

// ---- what the synchronous gate reads -----------------------------------------------------------------------------------------------

/** Advisories for exact pairs from the cache. Undefined (so "not checked") unless EVERY pair has an answer: a partial answer is never presented as complete. */
export function cachedAdvisoryLookup(pairs: DepPair[], nowMs: number = Date.now()): { ecosystem: string; name: string; version: string; ids: string[] }[] | undefined {
  const out: { ecosystem: string; name: string; version: string; ids: string[] }[] = [];
  for (const p of pairs) {
    if (p.version === undefined) return undefined;
    const ids = fresh(advisoryCache, pairKey({ ecosystem: p.ecosystem, name: p.name, version: p.version }), nowMs);
    if (ids === undefined) return undefined;
    out.push({ ecosystem: p.ecosystem, name: p.name, version: p.version, ids });
  }
  return out;
}

/** The registry verdicts the cache holds for these pairs. A name with no verdict is simply absent from the answer. */
export function cachedRegistryLookup(pairs: DepPair[], nowMs: number = Date.now()): RegistryVerdict[] {
  const out: RegistryVerdict[] = [];
  const seen = new Set<string>();
  for (const p of pairs) {
    const k = nameKey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    const v = fresh(registryCache, k, nowMs);
    if (v) out.push(v);
  }
  return out;
}

/** The options to hand `runSecurityGate`: empty when the lookup is off, so the gate's output is exactly what it was before this existed. */
export function dependencyGateOptions(): {
  advisoryLookup?: typeof cachedAdvisoryLookup;
  registryLookup?: typeof cachedRegistryLookup;
} {
  const mode = depLookupMode();
  return {
    ...(mode.osv ? { advisoryLookup: cachedAdvisoryLookup } : {}),
    ...(mode.registry ? { registryLookup: cachedRegistryLookup } : {}),
  };
}
