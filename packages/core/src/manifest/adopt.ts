// packages/core/src/manifest/adopt.ts
//
// `purix adopt <file-or-symbol>`: turn ONE file that `purix index` has seen
// but that no component owns yet into a real manifest component, at the moment
// someone is about to change it.
//
// Why this exists: after `purix index`, the resolver (resolver.ts) can only
// target components that own their files, and it deliberately skips the
// aggregate `purix-codebase-index` row. So every indexed-but-unowned file was
// unreachable for `modify` / `change`. Adopt-on-demand closes that without
// inflating the manifest with a component per indexed file.
//
// What it does NOT do: it never edits source files, never runs an LLM and
// never bypasses a gate. It only registers ownership. The change that follows
// still goes through the full verify -> gate -> commit loop.
import { existsSync, readFileSync } from "node:fs";
import { dirname, basename, extname, join, normalize, relative, resolve, isAbsolute } from "node:path";
import { toPosixPath, storedPosixPath } from "../platform/layout.js";
import type { ManifestEntry } from "./schema.js";
import { CURRENT_SCHEMA_VERSION } from "./schema_migrations.js";
import { computeSyncHash } from "../state/hash.js";

export const CODEBASE_INDEX_COMPONENT_ID = "purix-codebase-index";

export type AdoptLookup =
  | { outcome: "adoptable"; file: string; via: "file_path" | "symbol_name"; matchedOn: string }
  | { outcome: "already_owned"; file: string; owner: string }
  | { outcome: "ambiguous"; candidates: string[] }
  | { outcome: "not_indexed" };

function toPosix(p: string): string {
  return toPosixPath(p).replace(/^\.\//, "");
}

/** Normalise a user-typed path to the repo-relative POSIX form the index uses. */
export function normalizeRepoPath(input: string, baseDir: string): string {
  const abs = isAbsolute(input) ? normalize(input) : resolve(baseDir, input);
  return toPosix(relative(baseDir, abs));
}

function ownerOf(file: string, manifest: ManifestEntry[]): string | null {
  const owner = manifest.find((e) => e.component_id !== CODEBASE_INDEX_COMPONENT_ID && (e.files ?? []).some((f) => storedPosixPath(f) === file));
  return owner ? owner.component_id : null;
}

/**
 * Look a file path or an exact symbol name up in the index row. Symbols are
 * exact and case-sensitive, same as the resolver; a symbol defined in several
 * files is reported as ambiguous rather than guessed.
 */
export function lookupAdoptable(target: string, manifest: ManifestEntry[], baseDir: string): AdoptLookup {
  const index = manifest.find((e) => e.component_id === CODEBASE_INDEX_COMPONENT_ID);
  const records = index?.components ?? [];
  const indexedFiles = new Set<string>([...(index?.files ?? []), ...records.map((r) => r.file_location)].map(storedPosixPath));

  const asPath = normalizeRepoPath(target, baseDir);
  if (indexedFiles.has(asPath)) {
    const owner = ownerOf(asPath, manifest);
    return owner ? { outcome: "already_owned", file: asPath, owner } : { outcome: "adoptable", file: asPath, via: "file_path", matchedOn: asPath };
  }

  const bySymbol = [...new Set(records.filter((r) => r.symbol_name === target.trim()).map((r) => storedPosixPath(r.file_location)))];
  if (bySymbol.length === 1) {
    const file = bySymbol[0]!;
    const owner = ownerOf(file, manifest);
    return owner ? { outcome: "already_owned", file, owner } : { outcome: "adoptable", file, via: "symbol_name", matchedOn: target.trim() };
  }
  if (bySymbol.length > 1) return { outcome: "ambiguous", candidates: bySymbol.sort() };
  return { outcome: "not_indexed" };
}

/** The test file Purix's own test runner would pair with this source file, if it exists on disk. */
export function siblingTestFile(file: string, baseDir: string): string | null {
  const ext = extname(file);
  const stem = basename(file, ext);
  const dir = dirname(file);
  const candidates: string[] = [];
  if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".mjs") {
    if (!/\.(test|spec)$/.test(stem)) candidates.push(join(dir, `${stem}.test${ext}`), join(dir, `${stem}.spec${ext}`));
  } else if (ext === ".py") {
    if (!/^test_|_test$/.test(stem)) candidates.push(join(dir, `test_${stem}.py`), join(dir, `${stem}_test.py`));
  }
  for (const c of candidates) {
    const rel = toPosix(c);
    if (existsSync(resolve(baseDir, rel))) return rel;
  }
  return null;
}

function slug(s: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return out.length > 0 ? out : "component";
}

/** Derive a component id from the file name; add a path segment, then a counter, until unique. */
export function deriveAdoptedId(file: string, manifest: ManifestEntry[]): string {
  const taken = new Set(manifest.map((e) => e.component_id));
  taken.add(CODEBASE_INDEX_COMPONENT_ID);
  const ext = extname(file);
  const stem = basename(file, ext);
  const parts = dirname(file).split("/").filter((p) => p && p !== ".");
  const bases = [slug(stem)];
  if (parts.length > 0) bases.push(slug(`${parts[parts.length - 1]}-${stem}`));
  for (const b of bases) if (!taken.has(b)) return b;
  const root = bases[bases.length - 1]!;
  for (let n = 2; ; n++) if (!taken.has(`${root}-${n}`)) return `${root}-${n}`;
}

export interface BuildAdoptedInput {
  file: string;
  manifest: ManifestEntry[];
  baseDir: string;
  now?: Date;
  sourceAgent?: string | null;
}

export interface AdoptedPlan {
  entry: ManifestEntry;
}

/**
 * Pure assembly of the new component. Reads the files from disk only to
 * compute the baseline hash, so drift detection starts from what is really
 * there rather than from "never synced". The aggregate index row is left
 * untouched on purpose: the resolver already ignores it when looking for
 * owners, and rewriting it would only invite drift noise.
 */
export function buildAdoptedEntry(input: BuildAdoptedInput): AdoptedPlan {
  const { file, manifest, baseDir } = input;
  const fullPath = resolve(baseDir, file);
  if (!existsSync(fullPath)) {
    throw new Error(`"${file}" is in the index but no longer exists on disk. Run \`purix index\` to refresh, then try again.`);
  }
  const owner = ownerOf(file, manifest);
  if (owner) throw new Error(`"${file}" already belongs to component "${owner}". Use that id: purix modify ${owner} "<instruction>".`);

  const files = [file];
  const test = siblingTestFile(file, baseDir);
  if (test && !ownerOf(test, manifest)) files.push(test);

  const index = manifest.find((e) => e.component_id === CODEBASE_INDEX_COMPONENT_ID);
  const language = index?.components?.find((r) => r.file_location === file)?.language;
  const entry: ManifestEntry = {
    component_id: deriveAdoptedId(file, manifest),
    component_type: "module",
    current_version: 1,
    schema_version: CURRENT_SCHEMA_VERSION,
    parts: { tools: [], config: {} },
    files,
    depends_on: [],
    depended_on_by: [],
    version_history: [
      {
        version: 1,
        operation: "adopt",
        patch_ref: "adopted-from-index",
        contract_changed: false,
        timestamp: (input.now ?? new Date()).toISOString(),
        provenance: { source_type: "instruction", source_agent: input.sourceAgent ?? null },
      },
    ],
    // Registering ownership is not a verification run; do not claim "pass".
    verification_status: "pending",
    last_synced_hash: computeSyncHash(files.map((p) => ({ path: p, content: readFileSync(resolve(baseDir, p), "utf8") }))),
    ...(language ? { language } : {}),
  };
  return { entry };
}
