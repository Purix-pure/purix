// packages/core/src/language/provider.ts
import type { VerificationResult } from "../verify/verify.js";
import type { TestRunResult, RunTestsOptions } from "../verify/tests.js";
import type { IdiomCheckResult } from "../verify/idiom.js";
import type { PinningFinding, VulnFinding } from "../security/deps_audit.js";
import type { TestIntegrityChecker } from "../verify/test_integrity.js";
import type { TestDiscovery } from "../verify/test_discovery.js";

/** One syntax error found by a provider's parse check (AI-07). Positions are 1-based. */
export type ParseCheckResult =
  | { ok: true }
  | { ok: false; line: number; column: number; message: string; /** The checker's own code, e.g. "TS1005", when it has one. */ code?: string };

export interface LanguageProvider {
  id: string;
  detect(baseDir: string): boolean;
  minSupportedVersion: string;
  verify(filePaths: string[], baseDir?: string, runFn?: any): VerificationResult;
  /**
   * `options.baseline` (F06-02) offers a copy of the unmodified project so a failing test is judged against the unmodified code. A provider
   * that ignores it keeps its own rule (the Python provider has no re-run and no forgiveness: a failing pytest blocks).
   */
  runTests(componentId: string, testFiles: string[], baseDir?: string, options?: RunTestsOptions): TestRunResult;
  checkIdiom(filePaths: string[], baseDir?: string): IdiomCheckResult;
  // `ran: false` means the scan itself could not execute (tool not
  // installed, network unavailable, no manifest present) — this MUST be
  // distinguished from "ran and found nothing," per AGENTS.md's rule that
  // "checked and passed" and "could not check" are never the same outcome.
  // A caller that only reads `vulnerabilities.length === 0` cannot tell
  // these apart; `ran` exists so it doesn't have to guess.
  auditDependencies(baseDir?: string, runFn?: any): Promise<{ pinning: PinningFinding[]; vulnerabilities: VulnFinding[]; ran: boolean }>;

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
  /**
   * Which tests are related to these changed files, by this language's own conventions (imports, test
   * names and folders). One rule per language, owned here, so the verifier and the trust gate never
   * disagree about what "covered" means. A language with no rule omits this method, and its files
   * count as not covered.
   */
  findRelatedTests?(changedPaths: string[], baseDir: string): TestDiscovery;
  /**
   * Syntax-only check of one file's text, run before anything is copied or compiled (AI-07). Returns `undefined` when this
   * language does not handle that file, or when the check could not run (no interpreter): "could not check" is never
   * reported as "checked and fine" or as a failure. Cheap by contract: no project files, no type information. A language with
   * no such check omits the method, so conformance suites are unaffected.
   */
  parseCheck?(path: string, content: string): ParseCheckResult | undefined;
  /**
   * A1: does this language treat `path` (repo-relative, forward or back slashes) as one of ITS test files? One rule per language,
   * so the repair test lock and the integrity check never disagree with what the language's runner collects. A language with no
   * rule omits this; then provider-kit.ts's transitional table (by `id`) is consulted, and failing that the file is not a test.
   * Must be pure: no disk access. Return true for any path the runner would run as a test, helper files it loads (conftest.py)
   * included.
   */
  isTestFile?(path: string): boolean;
  /**
   * A1: files that are not tests but decide WHICH tests run or how they count (runner config, coverage config, snapshot folders),
   * as path patterns in the shared matcher's language (gates/path_match.ts). A pattern with no "/" matches that name in any
   * folder. A repair that edits one of these can make a failing test stop running, so the repair test lock treats them like
   * test files. Files that mix test settings with other settings (package.json, pyproject.toml, setup.cfg) are NOT listed: they
   * need a content check, which is the test-trust phase's job (A6), not a blanket block.
   */
  testConfigPaths?: readonly string[];
}
