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
  // Lazy by design: the TypeScript checker pulls in ts-morph (which bundles
  // a full copy of the TypeScript compiler, ~500ms to import) purely to
  // support this one escalation-time check. That cost must not be paid by
  // every command that merely looks up a language provider — e.g. `purix
  // --version`, which resolves providers via registry.ts but never touches
  // test-integrity checking. A getter (called only at the one point that
  // actually needs it — see escalate.ts) keeps the dynamic import out of
  // the eager module-load path. Returns undefined if this language has no
  // checker, matching the old optional-property behavior.
  getTestIntegrityChecker?(): Promise<TestIntegrityChecker | undefined>;
}
