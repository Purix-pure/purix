// packages/core/src/language/manifest_schema.ts
//
// A language manifest is deliberately static data (JSON, not code) — the
// one thing discoverLanguages() (registry.ts) reads for every discovered
// `@purix/lang-*` package BEFORE deciding whether to load that package's
// actual LanguageProvider/LanguagePack implementation at all. This is the
// same split VS Code's `contributes` block and OpenClaw's plugin manifest
// both use, and for the same reason: reading this file must never execute
// the language package's code, so it's safe to read from a package that
// hasn't been vetted/certified yet (see docs/adr-drafts/
// language-plugin-architecture.md §5.2 for the research this is based on).
//
// This is also the single place SCAFFOLD_EXTENSION_LANGUAGES,
// ToolchainLang, lang.ts's display array, and licensing/tier.ts's
// allowedLanguages arrays should all end up deriving from — see §3.5 of
// the same doc for the full list of hardcoded lists this replaces.

export interface LanguageManifest {
  id: string;
  minSupportedVersion: string;
  tier: "free" | "pro" | "team" | "enterprise";
  // File extensions this language's scaffold files use, for
  // detectScaffoldLanguage's extension-based dispatch. Previously a
  // separate hand-maintained array (SCAFFOLD_EXTENSION_LANGUAGES) that
  // drifted out of sync with what was actually registered — see the
  // language-plugin-architecture design doc §1 for the specific bug this
  // caused (packages.zip's scaffold.ts still listed .rs/.go/.rb here
  // after BETA_SCOPE.md said they were removed).
  scaffoldExtensions: string[];
  capabilities: {
    compileOrTypeCheck: boolean;
    testExecution: boolean;
    testIntegrityCheck: boolean;
    idiomCheck: boolean;
    dependencyVulnScan: boolean;
  };
}

/**
 * Narrow, defensive parse — this reads JSON from a package that may not be
 * vetted yet (see the module doc comment above), so it validates shape
 * rather than trusting `JSON.parse`'s result verbatim. A malformed
 * manifest is skipped (with the caller logging why), never partially
 * trusted.
 */
export function parseLanguageManifest(raw: unknown, sourceDescription: string): LanguageManifest {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${sourceDescription}: manifest is not a JSON object`);
  }
  const m = raw as Record<string, unknown>;

  if (typeof m.id !== "string" || m.id.length === 0) {
    throw new Error(`${sourceDescription}: missing or invalid "id"`);
  }
  if (typeof m.minSupportedVersion !== "string" || m.minSupportedVersion.length === 0) {
    throw new Error(`${sourceDescription}: missing or invalid "minSupportedVersion"`);
  }
  if (m.tier !== "free" && m.tier !== "pro" && m.tier !== "team" && m.tier !== "enterprise") {
    throw new Error(`${sourceDescription}: "tier" must be one of free/pro/team/enterprise`);
  }
  if (!Array.isArray(m.scaffoldExtensions) || !m.scaffoldExtensions.every((e) => typeof e === "string")) {
    throw new Error(`${sourceDescription}: "scaffoldExtensions" must be a string array`);
  }
  const caps = m.capabilities as Record<string, unknown> | undefined;
  const capKeys = ["compileOrTypeCheck", "testExecution", "testIntegrityCheck", "idiomCheck", "dependencyVulnScan"] as const;
  if (typeof caps !== "object" || caps === null || !capKeys.every((k) => typeof caps[k] === "boolean")) {
    throw new Error(`${sourceDescription}: "capabilities" must set all of ${capKeys.join(", ")} as booleans`);
  }

  return {
    id: m.id,
    minSupportedVersion: m.minSupportedVersion,
    tier: m.tier,
    scaffoldExtensions: m.scaffoldExtensions,
    capabilities: {
      compileOrTypeCheck: caps.compileOrTypeCheck as boolean,
      testExecution: caps.testExecution as boolean,
      testIntegrityCheck: caps.testIntegrityCheck as boolean,
      idiomCheck: caps.idiomCheck as boolean,
      dependencyVulnScan: caps.dependencyVulnScan as boolean,
    },
  };
}
