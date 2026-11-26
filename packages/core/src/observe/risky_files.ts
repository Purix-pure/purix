// src/observe/risky_files.ts
//
// "Risky files by pattern": which kinds of file the secret scan and the security gate stopped changes for, grouped by a generic file
// pattern (`.env*`, `*.pem`, `*.ts`, `Dockerfile`), never by name. The `policy_block` event already records the files it stopped (at most ten
// per event) and the category that fired; this only groups them. A pattern is what a person can read in a digest or share without
// handing over the project's layout.
//
// What this does not say: that a pattern is risky in itself (a `*.ts` count is mostly a sign of how much TypeScript the project has), or
// that files outside these events are safe. It counts stops, so it only sees changes made through Purix. Pure: no store, no clock.

export interface RiskyPattern {
  pattern: string;
  /** How many stops (policy_block events) named a file of this pattern. A stop that names two such files counts once. */
  stops: number;
  /** Category (secret pattern or security rule) to the number of stops that named it for this pattern. */
  categories: Record<string, number>;
}

export interface RiskyFiles {
  /** policy_block events that named at least one file. */
  stopsWithFiles: number;
  /** policy_block events that named none (older records, or a stop with no file). Counted so the total is never read as the whole. */
  stopsWithoutFiles: number;
  /** Most stops first; ties by pattern name. At most MAX_PATTERNS. */
  patterns: RiskyPattern[];
}

export const MAX_PATTERNS = 10;

/** Credential-style names that are better as one pattern than split by extension. Matched against the lower-cased base name. */
const NAMED: { test: RegExp; pattern: string }[] = [
  { test: /^\.env(\..+)?$/, pattern: ".env*" },
  { test: /^\.npmrc$|^\.pypirc$|^\.netrc$|^\.pgpass$/, pattern: "credential dotfile" },
  { test: /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/, pattern: "ssh key" },
  { test: /^dockerfile(\..+)?$|^docker-compose(\..+)?\.ya?ml$/, pattern: "Docker files" },
  { test: /^\.?(credentials|secrets?)(\..+)?$/, pattern: "credentials/secrets files" },
];

/** The generic pattern of one path. Directories are ignored on purpose: only the file's own name decides. */
export function filePattern(path: string): string {
  const base = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (base === "") return "(unnamed)";
  for (const n of NAMED) if (n.test.test(base)) return n.pattern;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "(no extension)";
  const ext = base.slice(dot + 1);
  // A very long or odd extension is more likely a name than a type; keep the pattern short and readable.
  return /^[a-z0-9_+-]{1,10}$/.test(ext) ? `*.${ext}` : "(other)";
}

export interface PolicyStop { files: string[]; categories: Record<string, number> }

export function tallyRiskyFiles(stops: PolicyStop[]): RiskyFiles {
  const byPattern = new Map<string, RiskyPattern>();
  let withFiles = 0;
  let without = 0;
  for (const s of stops) {
    if (s.files.length === 0) { without++; continue; }
    withFiles++;
    const patterns = new Set(s.files.map(filePattern));
    for (const p of patterns) {
      let r = byPattern.get(p);
      if (!r) { r = { pattern: p, stops: 0, categories: {} }; byPattern.set(p, r); }
      r.stops++;
      for (const [cat, n] of Object.entries(s.categories)) if (n > 0) r.categories[cat] = (r.categories[cat] ?? 0) + 1;
    }
  }
  const patterns = [...byPattern.values()].sort((a, b) => b.stops - a.stops || a.pattern.localeCompare(b.pattern)).slice(0, MAX_PATTERNS);
  return { stopsWithFiles: withFiles, stopsWithoutFiles: without, patterns };
}

/** Reads the shape a `policy_block` event's detail has (gates/policy_block_detail.ts); anything else gives empty lists, never a guess. */
export function policyStopOf(detail: Record<string, unknown>): PolicyStop {
  const files = Array.isArray(detail["files"]) ? detail["files"].filter((f): f is string => typeof f === "string") : [];
  const categories: Record<string, number> = {};
  const raw = detail["categories"];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "number" && Number.isFinite(v)) categories[k] = v;
  }
  return { files, categories };
}
