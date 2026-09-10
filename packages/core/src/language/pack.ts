// packages/core/src/language/pack.ts

export type ToolResultStatus = "pass" | "fail" | "not_installed";

export interface ToolResult {
  status: ToolResultStatus;
  reason?: string;
  actionHint?: string;
}

export interface ToolSpec {
  name: string;
  pinnedVersion: string;
  resolveBinPath(baseDir: string): string;
  isInstalled(baseDir: string): boolean;
  install(baseDir: string): Promise<{ ok: boolean; error?: string }>;
  installMethod?: "package-manager" | "language-toolchain-component" | "custom-script";
}

export interface LanguagePack {
  languageId: string;
  minSupportedVersion: string;
  tools: ToolSpec[];
  tier: "free" | "pro" | "team" | "enterprise";

  // baseDir is required (not optional) so implementations can never silently
  // fall back to process.cwd() for a subprocess probe — see
  // python.pack.ts::checkRuntimePresent for why that matters on Windows.
  checkRuntimePresent(baseDir: string): { present: boolean; message?: string };
  checkProjectValid(baseDir: string): { valid: boolean; reason?: string };
  extraSetup?(baseDir: string): Promise<{ ok: boolean; error?: string }>;

  capabilities: {
    compileOrTypeCheck: boolean;
    testExecution: boolean;
    testIntegrityCheck: boolean;
    idiomCheck: boolean;
    dependencyVulnScan: boolean;
  };

  isFullyInstalled(baseDir: string): boolean;
  install(baseDir: string): Promise<Array<{ tool: string; ok: boolean; error?: string }>>;
  uninstall(baseDir: string): Promise<{ ok: boolean; error?: string }>;
}