// packages/core/src/language/discovery.ts
//
// Step 1 of the language-plugin-architecture migration (see
// docs/adr-drafts/language-plugin-architecture.md). This is new,
// ADDITIVE infrastructure — it does not yet replace registry.ts's
// existing publicProviders/publicPacks arrays or any of the other
// hardcoded language lists (SCAFFOLD_EXTENSION_LANGUAGES, ToolchainLang,
// lang.ts's display array, tier.ts's allowedLanguages). Those are
// retired one at a time in later, separately-verified changes, per the
// design doc's §4 migration plan — this file's job is only to prove the
// discovery+manifest+cache mechanism itself works, in isolation, before
// anything depends on it.
//
// Why manifests live under packages/core/src/language/manifests/ for now
// (not yet split into separate @purix/lang-* packages): every real
// call site of getLanguageProvider()/getLanguagePack() (13+ across core,
// cli, and mcp-server, confirmed by grep before writing this file) calls
// them SYNCHRONOUSLY, never awaited. Splitting languages into separate
// npm packages, discovered via node_modules scanning, is a real future
// step (design doc §4 step 3) — but it does not need to block proving
// out the manifest/cache mechanism now, and rushing straight to a
// filesystem-wide node_modules scan in the same change that also has to
// keep 13 synchronous call sites working is exactly the kind of
// "forcing a rushed abstraction... late in this pass" CHANGES.md
// correctly declined to do for the lifecycle.ts/ingest.ts duplication.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { LanguageManifest } from "./manifest_schema.js";
import { parseLanguageManifest } from "./manifest_schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface DiscoveredLanguage {
  manifest: LanguageManifest;
  manifestPath: string;
  // The directory a language's actual code/tooling lives in — this is
  // the answer to "where are a language's install/tool files", so
  // callers never need to hardcode a path per language (see
  // toolchain_tmp.ts's ToolchainLang union, which this is meant to
  // eventually replace).
  installRoot: string;
}

/**
 * Scans packages/core/src/language/manifests/ for *.json files and
 * parses each as a LanguageManifest. Deliberately does NOT import any
 * language's actual provider/pack code — reading a manifest must never
 * execute untrusted/uncertified code (see manifest_schema.ts's doc
 * comment and design doc §5.2). A malformed manifest is skipped with a
 * warning, not allowed to abort discovery for every other language —
 * one bad manifest should never take down the whole registry.
 */
export function discoverLanguages(manifestsDir: string = join(__dirname, "manifests")): DiscoveredLanguage[] {
  if (!existsSync(manifestsDir)) {
    return [];
  }

  const discovered: DiscoveredLanguage[] = [];
  const entries = readdirSync(manifestsDir).filter((f) => f.endsWith(".json"));

  for (const fileName of entries) {
    const manifestPath = join(manifestsDir, fileName);
    try {
      const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
      const manifest = parseLanguageManifest(raw, manifestPath);
      discovered.push({
        manifest,
        manifestPath,
        // Interim: the manifests directory's parent (language/) is the
        // install root while manifests live inside @purix/core itself.
        // Once languages move to separate @purix/lang-* packages (design
        // doc §4 step 3), this becomes that package's resolved directory
        // instead — callers that only read `.installRoot` off a
        // DiscoveredLanguage don't need to change when that happens.
        installRoot: dirname(manifestsDir),
      });
    } catch (err) {
      // Fails open for the OTHER languages, fails closed for THIS one:
      // a language with a broken manifest is simply not discovered,
      // exactly the same "no error, just not found" outcome as a
      // language that was never installed at all. Logged, not thrown,
      // so one bad manifest can't break `purix lang list` entirely.
      console.error(`[language-discovery] skipping "${fileName}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return discovered;
}

/**
 * A stable, order-independent fingerprint of what's currently
 * discoverable — sorted by id so the hash doesn't change just because
 * readdirSync happened to return entries in a different order. This is
 * the cache-invalidation signal for language_registry (see design doc
 * §5.1): compare this against the DB's stored discovery_hash before
 * trusting cached capability/tool-path data, rather than a TTL — a TTL
 * is a known source of silent staleness bugs (pnpm/pnpm#12100, cited in
 * the design doc), a content hash isn't.
 */
export function computeDiscoveryHash(discovered: DiscoveredLanguage[]): string {
  const sorted = [...discovered].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  const fingerprint = sorted
    .map((d) => `${d.manifest.id}@${d.manifest.minSupportedVersion}`)
    .join("|");
  return createHash("sha256").update(fingerprint).digest("hex");
}
