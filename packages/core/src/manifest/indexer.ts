// packages/core/src/manifest/indexer.ts
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { verifyInSandbox } from "../sandbox/sandbox.js";
import { writeManifest, listManifest } from "./store.js";
import { resolveLanguage, getLanguageProvider } from "../language/registry.js";
import { requireLanguage } from "../licensing/tier.js";
import type { ComponentRecord, ManifestEntry } from "./schema.js";
import { computeSyncHash } from "../state/hash.js";

export interface IndexOptions {
  full?: boolean;
  incremental?: boolean;
  languages?: string[];
}

export interface IndexResult {
  fileCount: number;
  componentCount: number;
  components: ComponentRecord[];
}

function shouldIgnore(relPath: string, ignorePatterns: string[]): boolean {
  if (!relPath) return false;
  const segments = relPath.split(/[/\\]/);
  if (
    segments.includes("node_modules") ||
    segments.includes(".git") ||
    segments.includes(".purix") ||
    segments.includes("dist") ||
    segments.includes("build") ||
    segments.includes(".turbo")
  ) {
    return true;
  }
  for (const pattern of ignorePatterns) {
    if (relPath === pattern || relPath.startsWith(pattern + "/") || relPath.startsWith(pattern + "\\")) {
      return true;
    }
  }
  return false;
}

function loadIgnorePatterns(baseDir: string): string[] {
  const patterns: string[] = [];
  for (const ignoreFile of [".gitignore", ".purixignore"]) {
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
    if (shouldIgnore(rel, ignorePatterns)) continue;
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
    verification_status: "pass",
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
function extractSymbols(filePath: string, content: string, lang: string): ComponentRecord[] {
  const records: ComponentRecord[] = [];
  const relPath = relative(process.cwd(), filePath);

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
  const ignorePatterns = loadIgnorePatterns(baseDir);
  const files = walkDir(baseDir, baseDir, ignorePatterns);

  let fileCount = 0;
  const allComponents: ComponentRecord[] = [];
  // Exactly the files this run indexed, with the content it read — the source
  // of truth for the manifest entry's tracked file list and its drift baseline.
  const indexedFiles: { path: string; content: string }[] = [];

  for (const absPath of files) {
    const relPath = relative(baseDir, absPath);
    let lang: string;
    if (relPath.endsWith(".py")) lang = "python";
    else {
      try {
        lang = resolveLanguage(undefined, baseDir);
      } catch {
        lang = "typescript";
      }
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

    // Verification dispatch trace: CLI -> runIndex -> verifyInSandbox -> provider.verify -> runTests -> checkIdiom
    // BUG FIX: `comp-${fileCount}` is a synthetic ID that can never match a
    // real manifest entry, so verifyInSandbox's internal language resolution
    // (which looks the componentId up in the manifest) always misses and
    // falls back to whole-repository auto-detection — verifying, say, a
    // .rs file against the TypeScript provider whenever the repo as a whole
    // looks like a TypeScript project, and recording a false "pass" that
    // never actually type-checked, compiled, or tested that file. Pass the
    // language this loop already determined per-file as an explicit
    // override so dispatch can't silently go through the wrong toolchain.
    const verification = verifyInSandbox(`comp-${fileCount}`, [{ path: relPath, new_content: content }], baseDir, lang);
    const verificationStatus = verification.status === "pass" ? "pass" : "fail";

    const symbols = extractSymbols(absPath, content, lang);
    for (const sym of symbols) {
      sym.verification_status = verificationStatus;
      allComponents.push(sym);
    }
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
    files: files.map((f) => relative(baseDir, f)),
    depends_on: [],
    depended_on_by: [],
    version_history: [],
    verification_status: "pass",
    last_synced_hash: null,
    components: allComponents,
  };

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

  const purixDir = join(baseDir, ".purix");
  mkdirSync(purixDir, { recursive: true });
  const componentsJsonPath = join(purixDir, "components.json");
  writeFileSync(componentsJsonPath, JSON.stringify(allComponents, null, 2), "utf-8");

  return {
    fileCount,
    componentCount: allComponents.length,
    components: allComponents,
  };
}