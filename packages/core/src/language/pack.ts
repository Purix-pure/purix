// packages/core/src/language/pack.ts
//
// A language pack says what a language needs from the machine and project (a runtime, project
// markers) and which verification capabilities it offers. It does NOT choose, install, locate, or
// pin tools: that is the tools broker (src/tools, ADR-060). A pack's tools are whatever the catalog
// lists for its language; ask `purix tools plan --for <language>`.

export interface LanguagePack {
  languageId: string;
  minSupportedVersion: string;
  tier: "free" | "pro" | "team" | "enterprise";

  // baseDir is required (not optional) so implementations can never silently
  // fall back to process.cwd() for a subprocess probe — see
  // python.pack.ts::checkRuntimePresent for why that matters on Windows.
  checkRuntimePresent(baseDir: string): { present: boolean; message?: string };
  checkProjectValid(baseDir: string): { valid: boolean; reason?: string };

  capabilities: {
    compileOrTypeCheck: boolean;
    testExecution: boolean;
    testIntegrityCheck: boolean;
    idiomCheck: boolean;
    dependencyVulnScan: boolean;
  };
}
