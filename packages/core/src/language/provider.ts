// packages/core/src/language/provider.ts
import type { VerificationResult } from "../verify/verify.js";
import type { TestRunResult } from "../verify/tests.js";
import type { IdiomCheckResult } from "../verify/idiom.js";
import type { PinningFinding, VulnFinding } from "../security/deps_audit.js";
import type { TestIntegrityChecker } from "../verify/test_integrity.js";

export interface LanguageProvider {
  id: string;
  detect(baseDir: string): boolean;
  minSupportedVersion: string;
  verify(filePaths: string[], baseDir?: string, runFn?: any): VerificationResult;
  runTests(componentId: string, testFiles: string[], baseDir?: string, runFn?: any): TestRunResult;
  checkIdiom(filePaths: string[], baseDir?: string): IdiomCheckResult;
  auditDependencies(baseDir?: string, runFn?: any): Promise<{ pinning: PinningFinding[]; vulnerabilities: VulnFinding[] }>;

  getFingerprint(baseDir?: string): Promise<Record<string, string>>;
  testIntegrityChecker?: TestIntegrityChecker;
}
