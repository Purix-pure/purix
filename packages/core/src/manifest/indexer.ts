// packages/core/src/manifest/indexer.ts
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { verifyInSandbox } from "../sandbox/sandbox.js";
import { writeManifest, listManifest } from "./store.js";
import { resolveLanguage, getLanguageProvider } from "../language/registry.js";
import { requireLanguage } from "../licensing/tier.js";
import type { ComponentRecord, ManifestEntry } from "./schema.js";

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
      } catch {}
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

function extractSymbols(filePath: string, content: string, lang: string): ComponentRecord[] {
  const records: ComponentRecord[] = [];
  const relPath = relative(process.cwd(), filePath);

  const exportRegex = /export\s+(?:async\s+)?(?:function|class|const|let|interface|type)\s+(\w+)/g;
  let match;
  while ((match = exportRegex.exec(content)) !== null) {
    const symbolName = match[1]!;
    records.push({
      symbol_name: symbolName,
      file_location: relPath,
      signature: match[0],
      language: lang,
      verification_status: "pass",
      last_verified_commit_hash: null,
      reusable: true,
      rationale: null,
    });
  }

  if (lang === "python") {
    const pyRegex = /^(?:async\s+)?(def|class)\s+(\w+)/gm;
    while ((match = pyRegex.exec(content)) !== null) {
      const symbolName = match[2]!;
      if (!symbolName.startsWith("_")) {
        records.push({
          symbol_name: symbolName,
          file_location: relPath,
          signature: match[0],
          language: lang,
          verification_status: "pass",
          last_verified_commit_hash: null,
          reusable: true,
          rationale: null,
        });
      }
    }
  }

  if (lang === "rust") {
    const rustRegex = /^(?:pub\s+)?(fn|struct|impl|trait|enum)\s+(\w+)/gm;
    while ((match = rustRegex.exec(content)) !== null) {
      records.push({
        symbol_name: match[2]!,
        file_location: relPath,
        signature: match[0],
        language: lang,
        verification_status: "pass",
        last_verified_commit_hash: null,
        reusable: true,
        rationale: null,
      });
    }
  }

  if (lang === "go") {
    const goRegex = /^(?:func|type)\s+(\w+)/gm;
    while ((match = goRegex.exec(content)) !== null) {
      records.push({
        symbol_name: match[1]!,
        file_location: relPath,
        signature: match[0],
        language: lang,
        verification_status: "pass",
        last_verified_commit_hash: null,
        reusable: true,
        rationale: null,
      });
    }
  }

  if (lang === "ruby") {
    const rbRegex = /^(def|class|module)\s+(\w+)/gm;
    while ((match = rbRegex.exec(content)) !== null) {
      records.push({
        symbol_name: match[2]!,
        file_location: relPath,
        signature: match[0],
        language: lang,
        verification_status: "pass",
        last_verified_commit_hash: null,
        reusable: true,
        rationale: null,
      });
    }
  }

  if (records.length === 0) {
    records.push({
      symbol_name: relPath,
      file_location: relPath,
      signature: `file:${relPath}`,
      language: lang,
      verification_status: "pass",
      last_verified_commit_hash: null,
      reusable: false,
      rationale: null,
    });
  }

  return records;
}

export async function runIndex(baseDir: string = process.cwd(), options: IndexOptions = {}): Promise<IndexResult> {
  const ignorePatterns = loadIgnorePatterns(baseDir);
  const files = walkDir(baseDir, baseDir, ignorePatterns);

  let fileCount = 0;
  const allComponents: ComponentRecord[] = [];

  for (const absPath of files) {
    const relPath = relative(baseDir, absPath);
    let lang = "typescript";
    if (relPath.endsWith(".py")) lang = "python";
    else if (relPath.endsWith(".rs")) lang = "rust";
    else if (relPath.endsWith(".go")) lang = "go";
    else if (relPath.endsWith(".rb")) lang = "ruby";
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

    // Verification dispatch trace: CLI -> runIndex -> verifyInSandbox -> provider.verify -> runTests -> checkIdiom
    const verification = verifyInSandbox(`comp-${fileCount}`, [{ path: relPath, new_content: content }], baseDir);
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
