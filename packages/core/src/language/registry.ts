// packages/core/src/language/registry.ts
import type { LanguageProvider } from "./provider.js";
import type { LanguagePack } from "./pack.js";
import { typescriptProvider } from "./providers/typescript.js";
import { pythonProvider } from "./providers/python.js";
import { pythonPack } from "./providers/python.pack.js";
import { createConfigStore } from "../state/config.js";
import { readManifest } from "../manifest/store.js";
import { requireLanguage } from "../licensing/tier.js";

const publicProviders: LanguageProvider[] = [typescriptProvider, pythonProvider];
// Kept empty rather than removed: this is the extension point for a
// future internal/experimental language (previously Go, Ruby, Rust —
// removed for the beta launch to minimize shipped surface area, see
// the beta-readiness note in tier.ts). Add a provider here, gate it
// behind PURIX_INTERNAL_LANGUAGES, and it's back without redesigning
// this file.
const internalProviders: LanguageProvider[] = [];
const providers: LanguageProvider[] = process.env.PURIX_INTERNAL_LANGUAGES === "true" 
  ? [...publicProviders, ...internalProviders] 
  : publicProviders;

const publicPacks: LanguagePack[] = [pythonPack];
const internalPacks: LanguagePack[] = [];
const packs: LanguagePack[] = process.env.PURIX_INTERNAL_LANGUAGES === "true"
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
