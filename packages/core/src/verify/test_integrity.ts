// src/verify/test_integrity.ts
import { Project, Node, ts, type SourceFile } from "ts-morph";
import { isTestPath } from "./test_discovery.js";

export interface TestIntegrityFinding {
  path: string;
  reason: string;
}

export interface TestIntegrityResult {
  flagged: boolean;
  findings: TestIntegrityFinding[];
}

interface TestFileProfile {
  assertionCount: number;
  assertionTargets: string[];
  /** Each assertion as written (matcher and expected value included), whitespace-insensitive. */
  assertionExpressions: string[];
  skipCount: number;
  weakeners: Record<string, number>;
}

function parseInMemory(content: string, path: string): SourceFile | null {
  try {
    const project = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: { allowJs: true, target: ts.ScriptTarget.ES2020 },
    });
    return project.createSourceFile(path, content);
  } catch {
    return null;
  }
}

const SKIP_CALLEE_SUFFIXES = new Set(["skip", "todo"]);
const SKIP_BARE_IDENTIFIERS = new Set(["xit", "xdescribe", "xtest"]);

/**
 * AST-based, not regex — same reasoning as ast_transforms.ts: a regex
 * counting "expect(" would also match a comment or a string literal
 * containing that text, which would make this check itself unreliable
 * at the one job it has. Falls back to a NULL profile (not a zero
 * profile) on parse failure, so a file that fails to parse gets flagged
 * as "couldn't analyze," never silently scored as "0 assertions, must
 * have been weakened."
 */
function analyzeTestFile(content: string, path: string): TestFileProfile | null {
  const sourceFile = parseInMemory(content, path);
  if (!sourceFile) return null;

  let assertionCount = 0;
  const assertionTargets: string[] = [];
  const assertionExpressions: string[] = [];
  const weakeners: Record<string, number> = {};
  let skipCount = 0;
  const bump = (label: string): void => {
    weakeners[label] = (weakeners[label] ?? 0) + 1;
  };

  // One assertion: its target (first argument, as before), its full expression, and where it sits. An assertion that no longer
  // runs (inside a swallowing try/catch, a branch that never runs, or outside any test) is as good as a deleted one.
  const record = (call: Node, target: string, expression: Node): void => {
    assertionCount += 1;
    assertionTargets.push(target);
    assertionExpressions.push(compact(expression.getText()));
    let inTest = false;
    for (let child: Node = call, a = call.getParent(); a; child = a, a = a.getParent()) {
      if (Node.isCallExpression(a) && TEST_CALLEE.test(a.getExpression().getText())) inTest = true;
      if (Node.isTryStatement(a) && child === a.getTryBlock()) {
        const handler = a.getCatchClause();
        if (handler && !handler.getDescendants().some((d) => Node.isThrowStatement(d))) bump("swallowed");
      }
      if (Node.isIfStatement(a) && child === a.getThenStatement() && isNeverTrue(a.getExpression())) bump("dead");
    }
    if (!inTest) bump("outside_test");
  };

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const expr = node.getExpression();

    // expect(x)... — counts once per expect() call, not once per chained
    // matcher, since expect(x).toBe(1) is one checked assertion. The full chain (matcher and expected value) is kept too,
    // so changing toBe(3) to toBeDefined(), or to toBe(add(1, 2)), is seen (research 06: 9 of 13 evasions were invisible).
    if (Node.isIdentifier(expr) && expr.getText() === "expect") {
      const args = node.getArguments();
      record(node, args.length > 0 ? args[0]!.getText() : "(no argument)", chainTop(node));
      return;
    }

    // TEST-REPORT F5: node:assert / chai-style assertions, which this check
    // used to ignore entirely — deleting `assert.equal(...)` from a node:test
    // file (a runner verify/tests.ts supports first-class) went unflagged.
    // Matches the *callee expression* (a short identifier chain, so comments
    // and string literals still can't be counted): assert(x), assert.ok(x),
    // assert.equal(a, b), assert.strict.deepEqual(a, b), and node:test's
    // t.assert.equal(a, b).
    const calleeText = expr.getText();
    if (/^assert(\.\w+)*$/.test(calleeText) || /\.assert(\.\w+)+$/.test(calleeText)) {
      const args = node.getArguments();
      record(node, args.length > 0 ? args[0]!.getText() : "(no argument)", node);
      return;
    }

    // chai's should-style (x.should.equal(1)) and supertest's .expect(200): deleting them went unseen. Counted once per chain
    // (should) or once per call (supertest chains several .expect()s, each a check).
    if (/\.should\b/.test(calleeText) && chainTop(node) === node) {
      record(node, calleeText, node);
      return;
    }
    if (Node.isPropertyAccessExpression(expr) && expr.getName() === "expect" && !Node.isIdentifier(expr.getExpression())) {
      const args = node.getArguments();
      record(node, args.length > 0 ? args[0]!.getText() : "(no argument)", node);
      return;
    }

    // it.only / test.only / describe.only: every other test in the run silently stops running.
    if (Node.isPropertyAccessExpression(expr) && expr.getName() === "only" && /^(it|test|describe|suite|specify)$/.test(expr.getExpression().getText())) {
      bump("only");
      return;
    }
    if (Node.isIdentifier(expr) && (expr.getText() === "fit" || expr.getText() === "fdescribe")) {
      bump("only");
      return;
    }

    // it.skip(...), test.skip(...), describe.skip(...), it.todo(...)
    if (Node.isPropertyAccessExpression(expr) && SKIP_CALLEE_SUFFIXES.has(expr.getName())) {
      skipCount += 1;
      return;
    }

    // bare xit(...) / xdescribe(...) forms some test runners also accept
    if (Node.isIdentifier(expr) && SKIP_BARE_IDENTIFIERS.has(expr.getText())) {
      skipCount += 1;
    }
  });

  return { assertionCount, assertionTargets, assertionExpressions, skipCount, weakeners };
}

const TEST_CALLEE = /^[xf]?(it|test|specify)(\.\w+)*$/;

/** Whitespace and trailing commas do not change what an assertion says: `expect(\n  a,\n).toBe(1)` is `expect(a).toBe(1)`. */
function compact(text: string): string {
  return text.replace(/\s+/g, "").replace(/,([)\]}])/g, "$1");
}

/** The outermost expression of a call/property chain that starts at `node` (expect(x).not.toBe(1) from expect(x)). */
function chainTop(node: Node): Node {
  let top = node;
  for (;;) {
    const parent = top.getParent();
    if (parent && (Node.isPropertyAccessExpression(parent) || Node.isCallExpression(parent)) && parent.getExpression() === top) top = parent;
    else return top;
  }
}

/** A condition that is a literal false: `if (false)`, `if (0)`, `if (null)`, `if (undefined)`, `if (!1)`. */
function isNeverTrue(cond: Node): boolean {
  const text = cond.getText().trim();
  return /^(false|0|null|undefined|""|''|!\s*(true|1))$/.test(text);
}

/**
 * The language-agnostic half of a test-integrity profile: every language
 * checker needs at least these three numbers/lists to compare before vs.
 * after. `assertionTargets` is optional so a checker that genuinely can't
 * extract per-assertion targets (rather than just hasn't bothered) can
 * still participate — see the language-specific description below for why
 * omitting it isn't the right default.
 */
export interface BaseTestProfile {
  assertionCount: number;
  assertionTargets?: string[];
  /** Each assertion as written. A checker that supplies it gets "an assertion changed or disappeared" for free. */
  assertionExpressions?: string[];
  skipCount: number;
  /**
   * Counts of things that make a test pass without checking, by label: "only", "swallowed", "dead", "outside_test", "xfail".
   * A label whose count goes up is a finding. Optional: a checker that cannot tell simply omits it.
   */
  weakeners?: Record<string, number>;
}

const WEAKENER_TEXT: Record<string, string> = {
  only: "a focused test (.only) was added, so the other tests in the run no longer run",
  swallowed: "assertion(s) are now inside a try/catch that does not rethrow, so a failure is swallowed",
  dead: "assertion(s) are now inside a branch that never runs",
  outside_test: "assertion(s) now sit outside any test (for example in a helper that is never called)",
  xfail: "an expected-failure marker was added, so a failing test no longer fails the run",
};

/**
 * Shared comparison logic for §6.4 Test-Integrity Check (Node 3c) across
 * every language checker. Deterministic, no LLM — runs before TrustGate
 * for both the Instruction and Diff paths alike, per Principle 12 (this
 * risk applies to a diff from any source, including Purix's own
 * self-healing loop under time pressure).
 *
 * What this flags: assertion count going down, a specific assertion
 * target disappearing (only when the profile tracks targets), or new
 * skip/todo annotations appearing. What it deliberately doesn't do:
 * judge whether the change was legitimate (a genuinely over-strict test
 * correctly loosened) — that's a human call by design (§6.4's own stated
 * scope limit), consistent with Principle 2 (LLM as arbiter, not author)
 * — no caller of this asks a model.
 *
 * Previously this control flow was duplicated per-language (TypeScript
 * and Python each had their own copy), and the duplication had already
 * let the two drift: Python's copy compared only assertion *counts*, so
 * it couldn't catch an assertion on `foo()` being deleted and replaced
 * by an unrelated one on `bar()` — same count, nothing flagged. Sharing
 * this function means every language checker gets the same detection
 * power as soon as its `analyze*File` supplies `assertionTargets`.
 */
export function diffTestProfiles<P extends BaseTestProfile>(
  before: { path: string; content: string }[],
  after: { path: string; content: string }[],
  analyze: (content: string, path: string) => P | null,
  isRelevantPath: (path: string) => boolean,
  unparsableReason: string
): TestIntegrityResult {
  const beforeByPath = new Map(before.map((f) => [f.path, f.content]));
  const afterPaths = new Set(after.map((f) => f.path));
  const findings: TestIntegrityFinding[] = [];

  // A test file that was there before and is not now (deleted, or renamed away and so no longer a test file by name). The loop
  // below only ever looked at files that survive, so deleting a failing test file was invisible, although ADR-010 promises the
  // flag. Whether the deletion is legitimate is a human call; the check only makes sure it is seen.
  for (const file of before) {
    if (!isRelevantPath(file.path) || afterPaths.has(file.path)) continue;
    findings.push({ path: file.path, reason: "this test file is no longer present (deleted, or renamed so it is no longer a test file)" });
  }

  for (const file of after) {
    if (!isRelevantPath(file.path)) continue;
    const priorContent = beforeByPath.get(file.path);
    if (priorContent === undefined) continue; // newly-added test file, nothing to regress against
    if (priorContent === file.content) continue; // untouched

    const priorProfile = analyze(priorContent, file.path);
    const newProfile = analyze(file.content, file.path);

    if (!priorProfile || !newProfile) {
      findings.push({ path: file.path, reason: unparsableReason });
      continue;
    }

    if (newProfile.assertionCount < priorProfile.assertionCount) {
      findings.push({
        path: file.path,
        reason: `assertion count dropped from ${priorProfile.assertionCount} to ${newProfile.assertionCount}`,
      });
      continue; // one finding per file is enough signal; avoid pile-on noise
    }

    if (priorProfile.assertionTargets && newProfile.assertionTargets) {
      const newTargets = new Set(newProfile.assertionTargets);
      const removedTarget = priorProfile.assertionTargets.find((t) => !newTargets.has(t));
      if (removedTarget !== undefined) {
        findings.push({
          path: file.path,
          reason: `an assertion on \`${removedTarget}\` is no longer present (a different one may have replaced it, but that exact check disappeared)`,
        });
        continue;
      }
    }

    // An assertion as written (matcher and expected value) that is gone while the count held: it was changed. That is also how a
    // legitimate update looks, so this flags for a person to look; it never decides.
    if (priorProfile.assertionExpressions && newProfile.assertionExpressions) {
      const now = new Set(newProfile.assertionExpressions);
      const changed = priorProfile.assertionExpressions.find((e) => !now.has(e));
      if (changed !== undefined) {
        findings.push({
          path: file.path,
          reason: `an assertion was changed or removed: \`${changed.length > 80 ? changed.slice(0, 77) + "..." : changed}\` no longer appears as written (its matcher or expected value may have been loosened)`,
        });
        continue;
      }
    }

    const weakened = Object.keys(WEAKENER_TEXT).find((label) => (newProfile.weakeners?.[label] ?? 0) > (priorProfile.weakeners?.[label] ?? 0));
    if (weakened !== undefined) {
      findings.push({ path: file.path, reason: WEAKENER_TEXT[weakened]! });
      continue;
    }

    if (newProfile.skipCount > priorProfile.skipCount) {
      findings.push({
        path: file.path,
        reason: `${newProfile.skipCount - priorProfile.skipCount} new skip/todo annotation(s) added`,
      });
    }
  }

  return { flagged: findings.length > 0, findings };
}

export function checkTestIntegrity(
  before: { path: string; content: string }[],
  after: { path: string; content: string }[]
): TestIntegrityResult {
  return diffTestProfiles(
    before,
    after,
    analyzeTestFile,
    () => true, // TypeScript checker is applied to every file in the diff; isTestFilePath is only used to select which files to pass in upstream
    `couldn't parse this test file to compare assertions — treating as a flag rather than assuming it's fine`
  );
}

/**
 * Which files the integrity check (and the self-heal test lock in compile.ts) treats as tests. It is the
 * SAME rule test discovery uses (test_discovery.ts isTestPath: .test/.spec files, *_test and test-* names,
 * anything under test/ or __tests__/, JS as well as TS). It used to recognise only .test.ts and
 * .test.tsx, so weakening an assertion in test/a.ts or a.spec.ts was never checked, while discovery
 * happily ran those files as tests.
 */
export function isTestFilePath(path: string): boolean {
  return isTestPath(path);
}

export interface TestIntegrityChecker {
  check(before: { path: string; content: string }[], after: { path: string; content: string }[]): TestIntegrityResult;
  isTestFile(path: string): boolean;
}

export const typescriptTestIntegrityChecker: TestIntegrityChecker = {
  check: checkTestIntegrity,
  isTestFile: isTestFilePath,
};