
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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns true when a matching .test.ts file exists for a modified file", () => {
    writeFileSync(join(tmpDir, "foo.test.ts"), "// test");
    expect(hasTestCoverage([{ path: "foo.ts" }], tmpDir)).toBe(true);
  });

  it("returns false when no matching .test.ts file exists", () => {
    expect(hasTestCoverage([{ path: "foo.ts" }], tmpDir)).toBe(false);
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
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("falls back to built-in defaults when dof-patterns.json is absent", () => {
    const patterns = loadDofPatterns(tmpDir);
    expect(patterns).toContain("src/security/**");
    expect(patterns.length).toBeGreaterThan(0);
  });

  it("loads custom patterns from dof-patterns.json when present and valid", () => {
    writeFileSync(join(tmpDir, "dof-patterns.json"), JSON.stringify(["custom/**"]));
    const patterns = loadDofPatterns(tmpDir);
    expect(patterns).toEqual(["custom/**"]);
  });

  it("falls back to defaults, without throwing, when the config file isn't valid JSON", () => {
    writeFileSync(join(tmpDir, "dof-patterns.json"), "{ not valid json");
    const patterns = loadDofPatterns(tmpDir);
    expect(patterns).toContain("src/security/**");
  });

  it("falls back to defaults, without throwing, when the config isn't an array of strings", () => {
    writeFileSync(join(tmpDir, "dof-patterns.json"), JSON.stringify({ not: "an array" }));
    const patterns = loadDofPatterns(tmpDir);
    expect(patterns).toContain("src/security/**");
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