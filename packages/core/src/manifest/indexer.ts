// packages/core/src/manifest/indexer.ts
//
// `purix index` lists the project's TypeScript and Python files and records their exported symbols. It does NOT compile or test
// anything: every record it writes is "pending" (the word adopt already uses for "registered, not yet verified"), and the result
// says `verification: "not_run"`. A file is verified the first time it is changed through Purix (research 02, section 3.2,
// option B).
//
// Why it no longer verifies each file: the old indexer ran one whole-project verification per file (a full copy and compile
// each). Measured 2026-11-10 on 5, 10 and 20 real TypeScript files from Purix's own core package (Linux, 2 CPUs, one run each):
// 7.3, 14.7 and 32.6 s, so about 1.5 s per file and growing, which is 7 minutes or more for 300 files against the 10 s limit of
// attention in scripts/speed-budgets.json. The trace research 02 asked for found nothing that decides anything from the index's
// per-file pass or fail: `purix check`, `purix status`, the evidence bundle, the hook and the governed lock skip the index row, and
// the resolver, adopt and change-target read only file, symbol and language from it.
import { readdirSync, readFileSync, existsSync, mkdirSync, lstatSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "../platform/spawn_sync.js";
import { writeManifest, listManifest } from "./store.js";
import { languageForFile, getLanguageProvider } from "../language/registry.js";
import { requireLanguage } from "../licensing/tier.js";
import type { ComponentRecord, ManifestEntry } from "./schema.js";
import { computeSyncHash } from "../state/hash.js";
import { writeJsonAtomic } from "../platform/atomic_write.js";
import { purixDir, PURIX_DIRNAME, toPosixPath } from "../platform/layout.js";

export interface IndexOptions {
  full?: boolean;
  incremental?: boolean;
  languages?: string[];
}

export interface IndexResult {
  fileCount: number;
  componentCount: number;
  /**
   * Always "not_run": indexing lists files and symbols and runs no compile and no test. There is deliberately no failure count here:
   * a count of zero would read as "checked, none failed" to a person or an agent reading this result.
   */
  verification: "not_run";
  /** Files seen in the tree that no registered language claims, so they were not indexed. */
  unsupportedFileCount: number;
  /**
   * Where the list of files came from. "git": inside a git repository, git's own list (tracked plus untracked and not ignored), so
   * every .gitignore rule is honoured exactly (research 05 section 2.1). "walk": outside a repository, or when git could not run,
   * a folder walk that skips node_modules, .git, .purix, .turbo, dist and build and reads .gitignore only as literal path prefixes,
   * so a source folder named build or dist is not indexed there.
   */
  fileListSource: "git" | "walk";
  components: ComponentRecord[];
}

// Never project source, in either mode.
const ALWAYS_SKIPPED_DIRS = ["node_modules", ".git", PURIX_DIRNAME, ".turbo"];
// Conventional build output. Skipped only by the folder walk, which has no better information: git's list does not skip them (a
// folder called build or dist can be real source, F05-06) and leaves ignoring generated output to the project's .gitignore.
const WALK_ONLY_SKIPPED_DIRS = ["dist", "build"];

function shouldIgnore(relPath: string, ignorePatterns: string[], mode: "git" | "walk"): boolean {
  if (!relPath) return false;
  const segments = relPath.split(/[/\\]/);
  if (ALWAYS_SKIPPED_DIRS.some((d) => segments.includes(d))) return true;
  if (mode === "walk" && WALK_ONLY_SKIPPED_DIRS.some((d) => segments.includes(d))) return true;
  for (const pattern of ignorePatterns) {
    if (relPath === pattern || relPath.startsWith(pattern + "/") || relPath.startsWith(pattern + "\\")) {
      return true;
    }
  }
  return false;
}

/** Ignore rules read as literal path prefixes. In git mode only .purixignore is read: git applies .gitignore itself. */
function loadIgnorePatterns(baseDir: string, ignoreFiles: string[]): string[] {
  const patterns: string[] = [];
  for (const ignoreFile of ignoreFiles) {
    const p = resolve(baseDir, ignoreFile);
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, "utf-8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith("#")) {
            patterns.push(trimmed);
          }
        }
      } catch { /* best-effort ignore-pattern parse */ }
    }
  }
  return patterns;
}

/**
 * Git's own file list for `baseDir`: tracked files plus untracked files that no ignore rule excludes (`--exclude-standard` reads
 * .gitignore at every level, .git/info/exclude and the user's global excludes). NUL-separated, so no name is quoted. Returns null
 * when baseDir is not inside a work tree or git could not run to completion (not installed, timed out, killed, output too large,
 * "dubious ownership"); the caller then walks the folder instead and says so.
 */
function gitFileList(baseDir: string): string[] | null {
  const inside = spawnSync(["git", "-C", baseDir, "rev-parse", "--is-inside-work-tree"], { tier: "T1" });
  if (inside.stopped || inside.exitCode !== 0 || inside.stdout.toString().trim() !== "true") return null;
  const res = spawnSync(["git", "-C", baseDir, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    tier: "T2",
    maxOutputBytes: 256 * 1024 * 1024,
  });
  if (res.stopped || res.exitCode !== 0) return null;
  const names = new Set(res.stdout.toString().split("\0").filter(Boolean));
  const files: string[] = [];
  for (const name of [...names].sort()) {
    const abs = join(baseDir, name);
    try {
      // A tracked file deleted from disk, a submodule folder and a symlink are not indexed (the walk never indexed a symlink).
      if (lstatSync(abs).isFile()) files.push(abs);
    } catch { /* listed by git but not on disk */ }
  }
  return files;
}

function walkDir(dir: string, baseDir: string, ignorePatterns: string[], fileList: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return fileList;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const rel = relative(baseDir, fullPath);
    if (shouldIgnore(rel, ignorePatterns, "walk")) continue;
    if (entry.isDirectory()) {
      walkDir(fullPath, baseDir, ignorePatterns, fileList);
    } else if (entry.isFile()) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

// Builds one ComponentRecord with the fields shared by every extraction
// branch below. Only symbol_name/signature/reusable vary per call site;
// factoring this out keeps the per-language regexes from having to repeat
// the other 5 fields verbatim each time (see audit finding 2.7).
function makeRecord(
  symbolName: string,
  relPath: string,
  signature: string,
  lang: string,
  reusable: boolean
): ComponentRecord {
  return {
    symbol_name: symbolName,
    file_location: relPath,
    signature,
    language: lang,
    // Indexing records that a symbol exists, not that anything was run on it.
    verification_status: "pending",
    last_verified_commit_hash: null,
    reusable,
    rationale: null,
  };
}

// NOTE: Rust/Go/Ruby extraction was intentionally removed for this beta
// (see BETA_SCOPE.md) — only TypeScript and Python are supported. If a
// language is reintroduced, add its extraction branch here AND register
// its provider in core/src/language/registry.ts so the two stay in sync
// (see audit finding 3.1, where the two had drifted).
function extractSymbols(filePath: string, content: string, lang: string, baseDir: string = process.cwd()): ComponentRecord[] {
  const records: ComponentRecord[] = [];
  // Relative to the folder being indexed, the same base every other path in this run uses. It was the current directory, which is the
  // same folder only until a caller names another, or spells it differently (macOS: cwd is /private/var/..., the caller's is /var/...).
  const relPath = toPosixPath(relative(baseDir, filePath));
  // A UTF-8 byte-order mark sits in front of the first line and would hide a first-line `def`/`class` from the line-anchored regex below.
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);

  const exportRegex = /export\s+(?:async\s+)?(?:function|class|const|let|interface|type)\s+(\w+)/g;
  let match;
  while ((match = exportRegex.exec(content)) !== null) {
    records.push(makeRecord(match[1]!, relPath, match[0], lang, true));
  }

  if (lang === "python") {
    const pyRegex = /^(?:async\s+)?(def|class)\s+(\w+)/gm;
    while ((match = pyRegex.exec(content)) !== null) {
      const symbolName = match[2]!;
      if (!symbolName.startsWith("_")) {
        records.push(makeRecord(symbolName, relPath, match[0], lang, true));
      }
    }
  }

  if (records.length === 0) {
    records.push(makeRecord(relPath, relPath, `file:${relPath}`, lang, false));
  }

  return records;
}

export async function runIndex(baseDir: string = process.cwd(), options: IndexOptions = {}): Promise<IndexResult> {
  let files: string[];
  let fileListSource: "git" | "walk";
  const fromGit = gitFileList(baseDir);
  if (fromGit) {
    const ignorePatterns = loadIgnorePatterns(baseDir, [".purixignore"]);
    files = fromGit.filter((abs) => !shouldIgnore(relative(baseDir, abs), ignorePatterns, "git"));
    fileListSource = "git";
  } else {
    files = walkDir(baseDir, baseDir, loadIgnorePatterns(baseDir, [".gitignore", ".purixignore"]));
    fileListSource = "walk";
  }

  let fileCount = 0;
  let unsupportedFileCount = 0;
  const allComponents: ComponentRecord[] = [];
  // Exactly the files this run indexed, with the content it read — the source
  // of truth for the manifest entry's tracked file list and its drift baseline.
  const indexedFiles: { path: string; content: string }[] = [];

  for (const absPath of files) {
    const relPath = toPosixPath(relative(baseDir, absPath));
    // A file no registered language claims (JSON, Markdown, Go, ...) is not
    // indexed: it used to be verified by the TypeScript toolchain, which can
    // neither judge it nor honestly pass it (ADR-017), and it inflated the
    // component count with whole-file records for config and docs files.
    const lang = languageForFile(relPath);
    if (lang === undefined) {
      unsupportedFileCount++;
      continue;
    }

    if (options.languages && options.languages.length > 0) {
      if (!options.languages.includes(lang)) continue;
    }

    if (lang !== "typescript") {
      requireLanguage(lang);
    }

    fileCount++;
    const content = readFileSync(absPath, "utf-8");
    indexedFiles.push({ path: relPath, content });

    const symbols = extractSymbols(absPath, content, lang, baseDir);
    for (const sym of symbols) allComponents.push(sym);
  }

  const languagesFound = new Set(allComponents.map(c => c.language));
  const entryId = "purix-codebase-index";
  const existing = listManifest().find((m) => m.component_id === entryId);
  const manifestEntry: ManifestEntry = existing ?? {
    component_id: entryId,
    component_type: "codebase_index",
    current_version: 1,
    schema_version: 4,
    parts: { tools: [], config: {} },
    files: files.map((f) => toPosixPath(relative(baseDir, f))),
    depends_on: [],
    depended_on_by: [],
    version_history: [],
    verification_status: "pending",
    last_synced_hash: null,
    components: allComponents,
  };

  // The entry's own status says what this run did: nothing was verified, so it is "pending", on every run, including for an
  // entry an older version of `purix index` recorded as "pass" or "fail" (beta test report 2026-09-30, problem 3: the status
  // used to be hard-coded and then derived from per-file verification). "Not run" and "passed" are never the same outcome
  // (standard-02 section 5; ADR-017).
  manifestEntry.verification_status = "pending";

  manifestEntry.language = languagesFound.size === 1 ? Array.from(languagesFound)[0] : undefined;
  
  const dependencies: Record<string, Record<string, string>> = {};
  for (const lang of languagesFound) {
    const provider = getLanguageProvider(lang);
    if (provider && provider.getFingerprint) {
      dependencies[lang] = await provider.getFingerprint(baseDir);
    }
  }
  manifestEntry.dependencies = dependencies;
  manifestEntry.components = allComponents;
  // TEST-REPORT F25: an existing entry used to keep the file list from the
  // FIRST index forever, so files added later showed up in components.json but
  // were invisible to delete/drift/backup. Refresh it on every run.
  manifestEntry.files = indexedFiles.map((f) => f.path);
  // TEST-REPORT F3: this used to stay null, and checkDrift() treats a null
  // hash as "never drifted", so hand-edited indexed files were never flagged.
  // Indexing records the current state as the baseline; later edits drift.
  manifestEntry.last_synced_hash = computeSyncHash(indexedFiles);
  manifestEntry.current_version += 1;
  manifestEntry.version_history.push({
    version: manifestEntry.current_version,
    operation: "index",
    patch_ref: "index-run",
    contract_changed: false,
    timestamp: new Date().toISOString(),
    provenance: { source_type: "instruction", source_agent: null },
  });

  writeManifest(manifestEntry);

  const stateDir = purixDir(baseDir);
  mkdirSync(stateDir, { recursive: true });
  const componentsJsonPath = join(stateDir, "components.json");
  writeJsonAtomic(componentsJsonPath, allComponents);

  return {
    fileCount,
    componentCount: allComponents.length,
    verification: "not_run",
    unsupportedFileCount,
    fileListSource,
    components: allComponents,
  };
}