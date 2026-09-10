// src/verify/python_test_integrity.ts
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "../platform/spawn_sync.js";
import type { TestIntegrityChecker } from "./test_integrity.js";

export interface TestIntegrityFinding {
  path: string;
  reason: string;
}

export interface TestIntegrityResult {
  flagged: boolean;
  findings: TestIntegrityFinding[];
}

interface PythonTestProfile {
  assertionCount: number;
  skipCount: number;
}

function getPythonBinary(): string | null {
  for (const bin of ["python3", "python"]) {
    // cwd must never default to process.cwd() (packages/core during test
    // runs) — a bare "python"/"python3" probe with no matching interpreter
    // on PATH can trigger Windows' py launcher / pymanager shim to silently
    // self-install a runtime into cwd. Same reasoning as python.ts and
    // python.pack.ts; pin cwd to the OS tmpdir instead since this function
    // has no baseDir of its own to route through .purix-tmp/.
    const res = spawnSync([bin, "--version"], { cwd: tmpdir(), stdout: "pipe", stderr: "pipe" });
    if (res.exitCode === 0) return bin;
  }
  return null;
}

function analyzePythonFile(content: string): PythonTestProfile | null {
  const tmpFile = join(tmpdir(), `purix-py-ast-${Math.random().toString(36).slice(2)}.py`);
  writeFileSync(tmpFile, content, "utf-8");

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
        self.skip_count = 0

    def visit_Assert(self, node):
        self.assert_count += 1
        self.generic_visit(node)

    def visit_Call(self, node):
        if isinstance(node.func, ast.Attribute):
            if node.func.attr in ("skip", "skipif", "todo", "skip_if"):
                self.skip_count += 1
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
        self.generic_visit(node)

visitor = TestVisitor()
visitor.visit(tree)
print(json.dumps({"assertionCount": visitor.assert_count, "skipCount": visitor.skip_count}))
`;

  const scriptFile = join(tmpdir(), `purix-py-script-${Math.random().toString(36).slice(2)}.py`);
  writeFileSync(scriptFile, pyScript, "utf-8");

  try {
    const pythonBin = getPythonBinary();
    if (!pythonBin) return null;
    const res = spawnSync([pythonBin, scriptFile, tmpFile], {
      cwd: tmpdir(),
      stdout: "pipe",
      stderr: "pipe",
    });

    if (res.exitCode !== 0) return null;
    const parsed = JSON.parse(res.stdout.toString().trim());
    if (parsed.error) return null;
    return {
      assertionCount: parsed.assertionCount ?? 0,
      skipCount: parsed.skipCount ?? 0,
    };
  } catch {
    return null;
  } finally {
    try { unlinkSync(tmpFile); } catch {}
    try { unlinkSync(scriptFile); } catch {}
  }
}

export function checkPythonTestIntegrity(
  before: { path: string; content: string }[],
  after: { path: string; content: string }[]
): TestIntegrityResult {
  const beforeByPath = new Map(before.map((f) => [f.path, f.content]));
  const findings: TestIntegrityFinding[] = [];

  for (const file of after) {
    if (!file.path.endsWith(".py")) continue;
    const priorContent = beforeByPath.get(file.path);
    if (priorContent === undefined) continue;
    if (priorContent === file.content) continue;

    const priorProfile = analyzePythonFile(priorContent);
    const newProfile = analyzePythonFile(file.content);

    if (!priorProfile || !newProfile) {
      findings.push({
        path: file.path,
        reason: `couldn't parse python test file to compare assertions — treating as a flag`,
      });
      continue;
    }

    if (newProfile.assertionCount < priorProfile.assertionCount) {
      findings.push({
        path: file.path,
        reason: `assertion count dropped from ${priorProfile.assertionCount} to ${newProfile.assertionCount}`,
      });
      continue;
    }

    if (newProfile.skipCount > priorProfile.skipCount) {
      findings.push({
        path: file.path,
        reason: `${newProfile.skipCount - priorProfile.skipCount} new skip annotation(s) added`,
      });
    }
  }

  return { flagged: findings.length > 0, findings };
}

export function isPythonTestFilePath(path: string): boolean {
  return path.endsWith(".py") && (path.includes("test_") || path.includes("_test"));
}

export const pythonTestIntegrityChecker: TestIntegrityChecker = {
  check: checkPythonTestIntegrity,
  isTestFile: isPythonTestFilePath,
};