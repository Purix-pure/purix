// packages/core/src/language/registry.ts
import { purixEnv } from "../platform/env.js";
import type { LanguageProvider } from "./provider.js";
import type { LanguagePack } from "./pack.js";
import { typescriptProvider } from "./providers/typescript.js";
import { pythonProvider } from "./providers/python.js";
import { pythonPack } from "./providers/python.pack.js";
import { createConfigStore } from "../state/config.js";
import { readManifest } from "../manifest/store.js";
import { requireLanguage } from "../licensing/tier.js";
import { defaultExtensionTable, languageForExtensionTable, type ExtensionTable } from "./extension_table.js";

const publicProviders: LanguageProvider[] = [typescriptProvider, pythonProvider];
// Kept empty rather than removed: this is the extension point for a
// future internal/experimental language (previously Go, Ruby, Rust —
// removed for the beta launch to minimize shipped surface area, see
// the beta-readiness note in tier.ts). Add a provider here, gate it
// behind PURIX_INTERNAL_LANGUAGES, and it's back without redesigning
// this file.
const internalProviders: LanguageProvider[] = [];
const providers: LanguageProvider[] = purixEnv("PURIX_INTERNAL_LANGUAGES") === "true" 
  ? [...publicProviders, ...internalProviders] 
  : publicProviders;

const publicPacks: LanguagePack[] = [pythonPack];
const internalPacks: LanguagePack[] = [];
const packs: LanguagePack[] = purixEnv("PURIX_INTERNAL_LANGUAGES") === "true"
  ? [...publicPacks, ...internalPacks]
  : publicPacks;

export function registerLanguageProvider(provider: LanguageProvider): void {
  providers.push(provider);
}

export function getLanguageProvider(id: string): LanguageProvider | undefined {
  return providers.find((p) => p.id === id);
}

export function registerLanguagePack(pack: LanguagePack): void {
  packs.push(pack);
}

export function getLanguagePack(languageId: string): LanguagePack | undefined {
  return packs.find((p) => p.languageId === languageId);
}

// One rule for "which registered language does this file belong to". Gates that look at a file's
// language (index, cascade re-verification, audit) used to each guess `.py` -> python, everything
// else -> typescript, so a Go or Ruby file was checked by the TypeScript toolchain and could pass
// falsely. ADR-017 calls that a false-pass security defect. Returns undefined for a file no language
// claims, or that two languages both claim; callers must report that, never default it. The table is
// built from the language manifests (extension_table.ts), so this file names no language.
export function languageForFile(path: string, table: ExtensionTable = defaultExtensionTable()): string | undefined {
  return languageForExtensionTable(path, table);
}

/** Ids of every language this build can verify, in registration order. */
export function listLanguageIds(): string[] {
  return providers.map((p) => p.id);
}

/**
 * Languages whose marker files are present in `baseDir`, with no fallback. resolveLanguage() ends in a silent
 * "typescript" when nothing is detected, which is right for an existing file and wrong for a brand-new project:
 * a caller that must not guess (create in an empty folder) asks this instead and decides what to do with [].
 */
export function detectLanguages(baseDir: string = process.cwd()): string[] {
  return providers.filter((p) => p.detect(baseDir)).map((p) => p.id);
}

/** The language written in this project's config (`purix config set language <id>`), when it names a registered one. */
export function configuredLanguage(baseDir: string = process.cwd()): string | undefined {
  const explicit = createConfigStore(baseDir).get("language") as string | undefined;
  return explicit && providers.some((p) => p.id === explicit) ? explicit : undefined;
}

export function resolveLanguage(componentId?: string, baseDir: string = process.cwd()): string {
  // 1. Explicit config
  const config = createConfigStore(baseDir);
  const explicit = config.get("language") as string;
  if (explicit && providers.some((p) => p.id === explicit)) {
    if (explicit !== "typescript") {
      requireLanguage(explicit);
    }
    return explicit;
  }

  // 2. Manifest record
  if (componentId) {
    const entry = readManifest(componentId);
    if (entry && (entry as any).language && providers.some((p) => p.id === (entry as any).language)) {
      const lang = (entry as any).language;
      if (lang !== "typescript") {
        requireLanguage(lang);
      }
      return lang;
    }
  }

  // 3. Auto-detection via marker files
  const detected: string[] = [];
  for (const provider of providers) {
    if (provider.detect(baseDir)) {
      detected.push(provider.id);
    }
  }

  if (detected.length === 1) {
    const lang = detected[0]!;
    if (lang !== "typescript") {
      requireLanguage(lang);
    }
    return lang;
  }

  if (detected.length > 1) {
    throw new Error(
      `Multiple language markers detected (${detected.join(", ")}) with no explicit language declaration. ` +
        `Please specify language in configuration.`
    );
  }

  return "typescript";
}

/**
 * The language a new component should be written in, WITHOUT asking anyone: the one saved in this project's config, else
 * the one language the folder's own files identify. Zero or several candidates is not a guess; the caller must say so and
 * stop (the interactive CLI asks instead, see greenfield_preflight.ts). AI-04.
 */
export function languageForPlanning(baseDir: string = process.cwd()): { ok: true; language: string } | { ok: false; found: string[] } {
  const configured = configuredLanguage(baseDir);
  if (configured) return { ok: true, language: configured };
  const found = detectLanguages(baseDir);
  if (found.length === 1) return { ok: true, language: found[0]! };
  return { ok: false, found };
}
