
// src/gates/trustgate.test.ts
//
// §6.2: three independent gates (test-integrity, coverage, confidence)
// feeding one auto_commit / human_confirm / abort decision, checked in a
// specific order. This is the single highest-leverage file to pin down —
// a regression here either blocks legitimate auto-commits or, worse,
// silently widens what auto-commits. hasTestCoverage / loadDofPatterns
// touch the real filesystem, so those get temp-dir fixtures; everything
// else is pure.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRmSync } from "../platform/fs_retry.js";
import {
  evaluateTrustGate,
  hasTestCoverage,
  loadDofPatterns,
  checkDeterministicOverrideFloor,
  type TrustGateInput,
} from "./trustgate";

function baseInput(overrides: Partial<TrustGateInput> = {}): TrustGateInput {
  return {
    confidence: 0.9,
    contractChanging: false,
    hasCoverage: true,
    testIntegrity: { flagged: false },
    ...overrides,
  };
}

describe("evaluateTrustGate — gate ordering and outcomes", () => {
  it("auto-commits high confidence, non-contract-changing, covered, clean-integrity changes", () => {
    const result = evaluateTrustGate(baseInput());
    expect(result.action).toBe("auto_commit");
  });

  it("routes to human_confirm when test integrity is flagged, regardless of confidence", () => {
    const result = evaluateTrustGate(
      baseInput({ confidence: 0.99, testIntegrity: { flagged: true, reason: "assertion removed" } })
    );
    expect(result.action).toBe("human_confirm");
    expect(result.reason).toMatch(/weakened or removed/);
    expect(result.reason).toMatch(/assertion removed/);
  });

  it("test-integrity gate takes priority over the abort-worthy low-confidence case", () => {
    // Even a near-zero confidence would normally abort, but a flagged
    // test-integrity issue is checked first per §6.2's ordering.
    const result = evaluateTrustGate(
      baseInput({ confidence: 0.01, testIntegrity: { flagged: true } })
    );
    expect(result.action).toBe("human_confirm");
  });

  it("routes to human_confirm when there's no test coverage, regardless of high confidence", () => {
    const result = evaluateTrustGate(baseInput({ confidence: 0.99, hasCoverage: false }));
    expect(result.action).toBe("human_confirm");
    expect(result.reason).toMatch(/no test coverage/);
  });

  it("coverage gate takes priority over abort: no coverage + very low confidence still asks a human, doesn't abort", () => {
    const result = evaluateTrustGate(baseInput({ confidence: 0.01, hasCoverage: false }));
    expect(result.action).toBe("human_confirm");
  });

  it("aborts when confidence is below the reject threshold (with integrity clean and coverage present)", () => {
    const result = evaluateTrustGate(baseInput({ confidence: 0.1 }));
    expect(result.action).toBe("abort");
    expect(result.reason).toMatch(/below the reject threshold/);
  });

  it("aborts just below the reject threshold boundary (0.34)", () => {
    const result = evaluateTrustGate(baseInput({ confidence: 0.34 }));
    expect(result.action).toBe("abort");
  });

  it("does not abort exactly at the reject threshold boundary (0.35)", () => {
    const result = evaluateTrustGate(baseInput({ confidence: 0.35 }));
    expect(result.action).not.toBe("abort");
  });

  it("requires confirmation in the middle band, between reject and confirm thresholds", () => {
    const result = evaluateTrustGate(baseInput({ confidence: 0.5 }));
    expect(result.action).toBe("human_confirm");
    expect(result.reason).toMatch(/between the reject.*and confirm/);
  });

  it("auto-commits exactly at the confirm threshold boundary (0.75) when non-contract-changing", () => {
    const result = evaluateTrustGate(baseInput({ confidence: 0.75 }));
    expect(result.action).toBe("auto_commit");
  });

  it("stays in human_confirm just below the confirm threshold boundary (0.74)", () => {
    const result = evaluateTrustGate(baseInput({ confidence: 0.74 }));
    expect(result.action).toBe("human_confirm");
  });

  it("always requires confirmation for contract-changing edits, even at very high confidence (§7.5)", () => {
    const result = evaluateTrustGate(baseInput({ confidence: 1.0, contractChanging: true }));
    expect(result.action).toBe("human_confirm");
    expect(result.reason).toMatch(/contract-changing/);
  });

  it("contract-changing does not override an outright abort at very low confidence", () => {
    const result = evaluateTrustGate(baseInput({ confidence: 0.1, contractChanging: true }));
    expect(result.action).toBe("abort");
  });
});

describe("hasTestCoverage (filesystem-backed)", () => {
  let originalCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), "purix-trustgate-test-"));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    safeRmSync(tmpDir);
  });

  it("returns true when a matching .test.ts file exists for a modified file", () => {
    writeFileSync(join(tmpDir, "foo.test.ts"), "// test");
    expect(hasTestCoverage([{ path: "foo.ts" }], tmpDir)).toBe(true);
  });

  it("returns false when no matching .test.ts file exists", () => {
    expect(hasTestCoverage([{ path: "foo.ts" }], tmpDir)).toBe(false);
  });

  it("finds a test in test/ that imports the file (the old sibling rule said false)", () => {
    mkdirSync(join(tmpDir, "test"), { recursive: true });
    writeFileSync(join(tmpDir, "foo.ts"), "export const foo = 1;");
    writeFileSync(join(tmpDir, "test", "foo.test.ts"), 'import { foo } from "../foo";');
    expect(hasTestCoverage([{ path: "foo.ts" }], tmpDir)).toBe(true);
  });
  it("counts a test of an importer as coverage, and a .spec file", () => {
    writeFileSync(join(tmpDir, "util.ts"), "export const u = 1;");
    writeFileSync(join(tmpDir, "svc.ts"), 'import { u } from "./util";');
    writeFileSync(join(tmpDir, "svc.spec.ts"), 'import "./svc";');
    expect(hasTestCoverage([{ path: "util.ts" }], tmpDir)).toBe(true);
  });
  it("a source nothing relates to is not covered even when other tests exist", () => {
    writeFileSync(join(tmpDir, "a.ts"), "export const a = 1;");
    writeFileSync(join(tmpDir, "b.ts"), "export const b = 1;");
    writeFileSync(join(tmpDir, "a.test.ts"), 'import "./a";');
    expect(hasTestCoverage([{ path: "b.ts" }], tmpDir)).toBe(false);
  });
  it("treats a test file itself as not needing its own test file, and doesn't count it toward coverage", () => {
    expect(hasTestCoverage([{ path: "foo.test.ts" }], tmpDir)).toBe(false);
  });

  it("returns true if at least one of several files has coverage", () => {
    writeFileSync(join(tmpDir, "bar.test.ts"), "// test");
    expect(hasTestCoverage([{ path: "foo.ts" }, { path: "bar.ts" }], tmpDir)).toBe(true);
  });

  it("resolves nested paths correctly", () => {
    mkdirSync(join(tmpDir, "src", "nested"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "nested", "foo.test.ts"), "// test");
    expect(hasTestCoverage([{ path: "src/nested/foo.ts" }], tmpDir)).toBe(true);
  });
});

describe("loadDofPatterns (filesystem-backed)", () => {
  let originalCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), "purix-dof-test-"));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    safeRmSync(tmpDir);
  });

  it("falls back to built-in defaults when dof-patterns.json is absent", () => {
    const patterns = loadDofPatterns(tmpDir);
    expect(patterns).toContain("**/security/**");
    expect(patterns.length).toBeGreaterThan(0);
  });

  it("adds a project's patterns to the built-in floor and never replaces it", () => {
    writeFileSync(join(tmpDir, "dof-patterns.json"), JSON.stringify(["custom/**"]));
    const patterns = loadDofPatterns(tmpDir);
    expect(patterns).toContain("custom/**");
    // The built-in floor is still there (security review: a repository must not be able to drop it).
    expect(patterns).toContain("**/security/**");
    expect(patterns).toContain("**/*.env*");
    expect(patterns).toContain(".github/workflows/**");
    // A2a-1: the files that define the floor are always held, even under a custom list.
    expect(patterns).toEqual(expect.arrayContaining(["dof-patterns.json", "purix.config.json", ".purix/policy.json"]));
  });

  it("refuses an empty dof-patterns.json ([]): the floor stays on (a list of blank entries too)", () => {
    const whole = loadDofPatterns(join(tmpDir, "no-such-folder"));
    for (const body of [[], ["", "   "]]) {
      writeFileSync(join(tmpDir, "dof-patterns.json"), JSON.stringify(body));
      expect(loadDofPatterns(tmpDir)).toEqual(whole);
    }
  });

  it("falls back to defaults, without throwing, when the config file isn't valid JSON", () => {
    writeFileSync(join(tmpDir, "dof-patterns.json"), "{ not valid json");
    const patterns = loadDofPatterns(tmpDir);
    expect(patterns).toContain("**/security/**");
  });

  it("falls back to defaults, without throwing, when the config isn't an array of strings", () => {
    writeFileSync(join(tmpDir, "dof-patterns.json"), JSON.stringify({ not: "an array" }));
    const patterns = loadDofPatterns(tmpDir);
    expect(patterns).toContain("**/security/**");
  });
});

describe("checkDeterministicOverrideFloor (pure glob matching)", () => {
  const patterns = ["**/auth/**", "**/*.env*", "src/security/**"];

  it("reports no hit when no path matches any pattern", () => {
    const result = checkDeterministicOverrideFloor(["src/utils/format.ts"], patterns);
    expect(result.hit).toBe(false);
  });

  it("matches a deeply nested path under a ** pattern", () => {
    const result = checkDeterministicOverrideFloor(["src/gates/auth/handler.ts"], patterns);
    expect(result.hit).toBe(true);
    expect(result.matchedPattern).toBe("**/auth/**");
  });

  it("matches a dotfile-like env pattern", () => {
    const result = checkDeterministicOverrideFloor([".env.production"], patterns);
    expect(result.hit).toBe(true);
  });

  it("matches the first offending path when checking a batch", () => {
    const result = checkDeterministicOverrideFloor(
      ["src/utils/format.ts", "src/security/secrets.ts"],
      patterns
    );
    expect(result.hit).toBe(true);
    expect(result.matchedPath).toBe("src/security/secrets.ts");
  });

  it("returns no hit for an empty path list", () => {
    expect(checkDeterministicOverrideFloor([], patterns).hit).toBe(false);
  });
});

describe("hasTestCoverage: every language through its own provider", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "purix-trustgate-py-")); });
  afterEach(() => { safeRmSync(tmpDir); });

  it("Python: a test_x.py (or a test that imports the module) is coverage; a lone .py file is not", () => {
    mkdirSync(join(tmpDir, "tests"), { recursive: true });
    writeFileSync(join(tmpDir, "cart.py"), "def total(): return 1\n");
    writeFileSync(join(tmpDir, "lonely.py"), "x = 1\n");
    writeFileSync(join(tmpDir, "tests", "test_cart.py"), "def test_c(): pass\n");
    expect(hasTestCoverage([{ path: "cart.py" }], tmpDir)).toBe(true);
    expect(hasTestCoverage([{ path: "lonely.py" }], tmpDir)).toBe(false);
    writeFileSync(join(tmpDir, "tests", "test_lonely.py"), "import lonely\n");
    expect(hasTestCoverage([{ path: "lonely.py" }], tmpDir)).toBe(true);
  });

  it("Python files used to count as covered whenever the file existed; now they need a related test", () => {
    writeFileSync(join(tmpDir, "orphan.py"), "x = 1\n");
    expect(hasTestCoverage([{ path: "orphan.py" }], tmpDir)).toBe(false);
  });

  it("a Python test file does not count toward coverage", () => {
    writeFileSync(join(tmpDir, "test_a.py"), "def test_a(): pass\n");
    expect(hasTestCoverage([{ path: "test_a.py" }], tmpDir)).toBe(false);
  });

  it("files no language claims (prompt, config, markdown) keep the legacy rule: an existing file counts, a missing one does not", () => {
    writeFileSync(join(tmpDir, "prompt.md"), "# prompt\n");
    expect(hasTestCoverage([{ path: "prompt.md" }], tmpDir)).toBe(true);
    expect(hasTestCoverage([{ path: "missing.json" }], tmpDir)).toBe(false);
  });

  it("a mixed change is covered when either language has a related test", () => {
    writeFileSync(join(tmpDir, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(tmpDir, "b.py"), "x = 1\n");
    writeFileSync(join(tmpDir, "test_b.py"), "import b\n");
    expect(hasTestCoverage([{ path: "a.ts" }, { path: "b.py" }], tmpDir)).toBe(true);
  });
});

describe("TrustGate and verification isolation", () => {
  const clean = { confidence: 0.95, contractChanging: false, hasCoverage: true, testIntegrity: { flagged: false } };
  it("does not auto-commit when verification ran with no isolation", () => {
    const d = evaluateTrustGate({ ...clean, isolation: "none" });
    expect(d.action).toBe("human_confirm");
    expect(d.reason).toMatch(/no isolation/);
  });
  it("still auto-commits when isolated or when the caller gives no isolation", () => {
    expect(evaluateTrustGate({ ...clean, isolation: "bwrap" }).action).toBe("auto_commit");
    expect(evaluateTrustGate(clean).action).toBe("auto_commit");
  });
  it("does not turn an abort into a confirm", () => {
    expect(evaluateTrustGate({ ...clean, confidence: 0.2, isolation: "none" }).action).toBe("abort");
  });
});
