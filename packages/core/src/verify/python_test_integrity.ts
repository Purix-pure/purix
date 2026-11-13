// src/verify/python_test_integrity.ts
import { mkdtempSync, rmSync } from "node:fs";
import { writeFileAtomic } from "../platform/atomic_write.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "../platform/spawn_sync.js";
import { isPythonTestPath } from "./python_test_discovery.js";
import { diffTestProfiles, type TestIntegrityChecker, type TestIntegrityFinding, type TestIntegrityResult } from "./test_integrity.js";

// Re-exported for anything importing these from this module's old location.
export type { TestIntegrityFinding, TestIntegrityResult };

interface PythonTestProfile {
  assertionCount: number;
  // Unparsed source text of each `assert <expr>` test expression (via
  // Python's own ast.unparse, Python 3.9+ — this project's floor is 3.10,
  // see python.ts minSupportedVersion). Tracking targets, not just a
  // count, is what lets the shared diffTestProfiles() catch an assertion
  // on one thing being silently swapped for an assertion on something
  // else (previously only the TypeScript checker could do this — see
  // audit finding 2.4).
  assertionTargets: string[];
  skipCount: number;
  /** "swallowed", "dead", "xfail": things that make a test pass without checking (compared by the shared diff). */
  weakeners: Record<string, number>;
}

function getPythonBinary(): string | null {
  for (const bin of ["python3", "python"]) {
    // cwd must never default to process.cwd() (packages/core during test
    // runs) — a bare "python"/"python3" probe with no matching interpreter
    // on PATH can trigger Windows' py launcher / pymanager shim to silently
    // self-install a runtime into cwd. Same reasoning as python.ts and
    // python.pack.ts; pin cwd to the OS tmpdir instead since this function
    // has no baseDir of its own to route through .purix/tmp/.
    // tier T1 (platform/spawn_sync.ts): a hung interpreter must not be waited on for the default ten minutes.
    const res = spawnSync([bin, "--version"], { cwd: tmpdir(), stdout: "pipe", stderr: "pipe", tier: "T1" });
    if (res.exitCode === 0) return bin;
  }
  return null;
}

function analyzePythonFile(content: string, pythonBin: string | null): PythonTestProfile | null {
  if (!pythonBin) return null;
  // H3: both files go in a folder made for this call (mode 0700, name chosen by the system), not in the shared temp folder under a name
  // from Math.random, so no other local user can swap the script between the write and python reading it.
  const workDir = mkdtempSync(join(tmpdir(), "purix-py-"));
  const tmpFile = join(workDir, "subject.py");
  const scriptFile = join(workDir, "analyze.py");
  try {
    writeFileAtomic(tmpFile, content);

    const pyScript = `
import ast
import json
import sys

try:
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        code = f.read()
    tree = ast.parse(code)
except Exception:
    print(json.dumps({"error": "parse_error"}))
    sys.exit(0)

class TestVisitor(ast.NodeVisitor):
    def __init__(self):
        self.assert_count = 0
        self.assert_targets = []
        self.skip_count = 0
        self.weak = {}
        self.path = []

    def visit(self, node):
        self.path.append(node)
        super().visit(node)
        self.path.pop()

    def bump(self, label):
        self.weak[label] = self.weak.get(label, 0) + 1

    # One assertion, and where it sits: inside a try whose handlers never re-raise, or inside a branch that is literally false,
    # it can no longer fail the test. Judged on the ancestors of the assertion, not on text.
    def record(self, text):
        self.assert_count += 1
        self.assert_targets.append(text)
        for i in range(len(self.path) - 1, 0, -1):
            child, anc = self.path[i], self.path[i - 1]
            if isinstance(anc, ast.Try) and child in anc.body:
                if anc.handlers and not any(isinstance(n, ast.Raise) for h in anc.handlers for n in ast.walk(h)):
                    self.bump("swallowed")
            if isinstance(anc, ast.If) and child in anc.body:
                if isinstance(anc.test, ast.Constant) and not anc.test.value:
                    self.bump("dead")

    def visit_Assert(self, node):
        try:
            text = ast.unparse(node.test)
        except Exception:
            text = "(unparsable)"
        self.record(text)
        self.generic_visit(node)

    def visit_Call(self, node):
        if isinstance(node.func, ast.Attribute):
            if node.func.attr in ("skip", "skipif", "todo", "skip_if"):
                self.skip_count += 1
            if node.func.attr == "xfail":
                self.bump("xfail")
            # unittest: self.assertEqual(a, b) and friends are assertions too (deleting them went unseen)
            if node.func.attr.startswith("assert") and isinstance(node.func.value, ast.Name) and node.func.value.id == "self":
                try:
                    self.record(ast.unparse(node))
                except Exception:
                    self.record("(unparsable)")
        elif isinstance(node.func, ast.Name):
            if node.func.id in ("skip", "skipTest"):
                self.skip_count += 1
        self.generic_visit(node)

    def visit_FunctionDef(self, node):
        for dec in node.decorator_list:
            if isinstance(dec, ast.Attribute) and dec.attr in ("skip", "todo"):
                self.skip_count += 1
            elif isinstance(dec, ast.Call):
                func = dec.func
                if isinstance(func, ast.Attribute) and func.attr in ("skip", "skipif", "todo"):
                    self.skip_count += 1
                elif isinstance(func, ast.Name) and func.id in ("skip", "skipif"):
                    self.skip_count += 1
            d = dec.func if isinstance(dec, ast.Call) else dec
            if isinstance(d, ast.Attribute) and d.attr in ("xfail", "expectedFailure"):
                self.bump("xfail")
        self.generic_visit(node)

    visit_AsyncFunctionDef = visit_FunctionDef

visitor = TestVisitor()
visitor.visit(tree)
print(json.dumps({
    "assertionCount": visitor.assert_count,
    "assertionTargets": visitor.assert_targets,
    "skipCount": visitor.skip_count,
    "weakeners": visitor.weak,
}))
`;

    writeFileAtomic(scriptFile, pyScript);

    // A stop (deadline, signal, output cap) has a null exit code and gives null here, which the caller turns into a flag for a person.
    const res = spawnSync([pythonBin, scriptFile, tmpFile], {
      cwd: workDir,
      stdout: "pipe",
      stderr: "pipe",
      // T2 (60 s), not T1 (10 s): one analysis takes about 1 s on a quiet Windows machine and ten times that when the whole suite
      // runs at once, and at 10 s every analysis timed out (22 of them, 228 s) and a harmless edit was flagged as test tampering.
      // The interpreter probe above stays T1, so an interpreter that never answers is still given up on at 10 s.
      tier: "T2",
    });

    if (res.exitCode !== 0) return null;
    const parsed = JSON.parse(res.stdout.toString().trim());
    if (parsed.error) return null;
    return {
      assertionCount: parsed.assertionCount ?? 0,
      assertionTargets: parsed.assertionTargets ?? [],
      skipCount: parsed.skipCount ?? 0,
      weakeners: parsed.weakeners ?? {},
    };
  } catch {
    return null;
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* temp folder cleanup is best-effort */ }
  }
}

export function checkPythonTestIntegrity(
  before: { path: string; content: string }[],
  after: { path: string; content: string }[]
): TestIntegrityResult {
  // analyzePythonFile only needs `content` (it shells out to a temp file
  // rather than reading `path`), but diffTestProfiles' analyze signature
  // is (content, path) to match the TypeScript checker — the unused path
  // parameter is intentionally ignored here.
  // One interpreter probe per check, made only if a file needs analysing: it used to be repeated for both reads of every changed file.
  let pythonBin: string | null | undefined;
  const interpreter = (): string | null => (pythonBin === undefined ? (pythonBin = getPythonBinary()) : pythonBin);
  return diffTestProfiles(
    before,
    after,
    (content) => analyzePythonFile(content, interpreter()),
    (path) => path.endsWith(".py"),
    `couldn't parse python test file to compare assertions — treating as a flag`
  );
}

/**
 * Same rule Python test discovery uses (python_test_discovery.ts isPythonTestPath: test_*.py, *_test.py,
 * conftest.py, any .py in a tests/ or test/ folder). The old check matched the substrings "test_" and
 * "_test" anywhere in the path, so latest_report.py counted as a test file and a test kept in tests/
 * as plain helper code did not.
 */
export function isPythonTestFilePath(path: string): boolean {
  return isPythonTestPath(path);
}

export const pythonTestIntegrityChecker: TestIntegrityChecker = {
  check: checkPythonTestIntegrity,
  isTestFile: isPythonTestFilePath,
};