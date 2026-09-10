// src/verify/test_integrity.ts
import { Project, Node, ts, type SourceFile } from "ts-morph";

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
  skipCount: number;
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
  let skipCount = 0;

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const expr = node.getExpression();

    // expect(x)... — counts once per expect() call, not once per chained
    // matcher, since expect(x).toBe(1) is one checked assertion.
    if (Node.isIdentifier(expr) && expr.getText() === "expect") {
      const args = node.getArguments();
      assertionCount += 1;
      assertionTargets.push(args.length > 0 ? args[0]!.getText() : "(no argument)");
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

  return { assertionCount, assertionTargets, skipCount };
}

/**
 * §6.4 Test-Integrity Check (Node 3c). Deterministic, no LLM — runs
 * before TrustGate for both the Instruction and Diff paths alike, per
 * Principle 12 (this risk applies to a diff from any source, including
 * Purix's own self-healing loop under time pressure).
 *
 * What this flags: assertion count going down, a specific assertion
 * target disappearing, or new skip/todo annotations appearing. What it
 * deliberately doesn't do: judge whether the change was legitimate (a
 * genuinely over-strict test correctly loosened) — that's a human call
 * by design (§6.4's own stated scope limit), consistent with Principle 2
 * (LLM as arbiter, not author) — this file doesn't even ask a model.
 */
export function checkTestIntegrity(
  before: { path: string; content: string }[],
  after: { path: string; content: string }[]
): TestIntegrityResult {
  const beforeByPath = new Map(before.map((f) => [f.path, f.content]));
  const findings: TestIntegrityFinding[] = [];

  for (const file of after) {
    const priorContent = beforeByPath.get(file.path);
    if (priorContent === undefined) continue; // newly-added test file, nothing to regress against
    if (priorContent === file.content) continue; // untouched

    const priorProfile = analyzeTestFile(priorContent, file.path);
    const newProfile = analyzeTestFile(file.content, file.path);

    if (!priorProfile || !newProfile) {
      findings.push({
        path: file.path,
        reason: `couldn't parse this test file to compare assertions — treating as a flag rather than assuming it's fine`,
      });
      continue;
    }

    if (newProfile.assertionCount < priorProfile.assertionCount) {
      findings.push({
        path: file.path,
        reason: `assertion count dropped from ${priorProfile.assertionCount} to ${newProfile.assertionCount}`,
      });
      continue; // one finding per file is enough signal; avoid pile-on noise
    }

    const newTargets = new Set(newProfile.assertionTargets);
    const removedTarget = priorProfile.assertionTargets.find((t) => !newTargets.has(t));
    if (removedTarget !== undefined) {
      findings.push({
        path: file.path,
        reason: `an assertion on \`${removedTarget}\` is no longer present (a different one may have replaced it, but that exact check disappeared)`,
      });
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

/** Convenience: filters a file list down to the project's own test-naming convention (matches tests.ts). */
export function isTestFilePath(path: string): boolean {
  return path.endsWith(".test.ts") || path.endsWith(".test.tsx");
}

export interface TestIntegrityChecker {
  check(before: { path: string; content: string }[], after: { path: string; content: string }[]): TestIntegrityResult;
  isTestFile(path: string): boolean;
}

export const typescriptTestIntegrityChecker: TestIntegrityChecker = {
  check: checkTestIntegrity,
  isTestFile: isTestFilePath,
};