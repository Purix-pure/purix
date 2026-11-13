// A2a-1: the deterministic floor on the shared matcher. The 21 paths of research 08 (10 missed on the baseline), plus the
// manifests and lockfiles the plan adds. [path, must the floor hit]
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRmSync } from "../platform/fs_retry.js";
import { checkDeterministicOverrideFloor, loadDofPatterns } from "./trustgate.js";

const CASES: [string, boolean][] = [
  ["src/auth/login.ts", true],
  ["src\\auth\\login.ts", true], // Windows separators
  ["src/Auth/login.ts", true], // case
  ["db/migrations/001.sql", true],
  [".env", true],
  [".env.production", true],
  ["config/.env.local", true],
  ["src/security/x.ts", true],
  ["packages/x/src/security/y.ts", true], // nested
  ["src/notauth/foo.ts", true], // known safe-direction over-match
  ["src/authz/policy.ts", true],
  ["src/iam/roles.ts", true],
  [".github/workflows/ci.yml", true],
  ["Dockerfile", true],
  ["package.json", true],
  ["src/payments/charge.ts", false],
  ["CODEOWNERS", true],
  ["purix.config.json", true],
  [".claude/settings.json", true],
  ["./src/auth/a.ts", true],
  ["/abs/src/auth/a.ts", true],
  // manifests, lockfiles, CI and container files, in the root and nested
  ["pnpm-lock.yaml", true],
  ["package-lock.json", true],
  ["apps/web/package.json", true],
  ["requirements.txt", true],
  ["services/api/pyproject.toml", true],
  ["go.mod", true],
  ["Cargo.lock", true],
  ["services/api/Dockerfile.prod", true],
  [".gitlab-ci.yml", true],
  [".github/CODEOWNERS", true],
  ["docs/CODEOWNERS", true],
  [".codex/config.toml", true],
  [".cursor/rules/a.mdc", true],
  [".gemini/settings.json", true],
  [".purix/policy.json", true],
  ["dof-patterns.json", true],
  // ordinary source stays free
  ["src/utils/format.ts", false],
  ["README.md", false],
  ["src/author/bio.ts", false], // "author" is not "auth": the new patterns do not widen the old over-match
];

describe("deterministic override floor", () => {
  const patterns = loadDofPatterns("/definitely/not/a/dir");
  for (const [path, want] of CASES) {
    it(`${want ? "holds" : "lets through"} ${JSON.stringify(path)}`, () => {
      expect(checkDeterministicOverrideFloor([path], patterns).hit).toBe(want);
    });
  }

  it("reports the path as the caller gave it, not the normalised one", () => {
    const r = checkDeterministicOverrideFloor(["src\\Auth\\x.ts"], patterns);
    expect(r).toMatchObject({ hit: true, matchedPath: "src\\Auth\\x.ts" });
  });

  it("a pattern written with backslashes or capitals in dof-patterns.json still works", () => {
    const dir = mkdtempSync(join(tmpdir(), "purix-dof-"));
    try {
      writeFileSync(join(dir, "dof-patterns.json"), JSON.stringify(["Src\\Billing\\**"]));
      const p = loadDofPatterns(dir);
      expect(checkDeterministicOverrideFloor(["src/billing/x.ts"], p).hit).toBe(true);
    } finally {
      safeRmSync(dir);
    }
  });

  it("a path past the matcher's length bound holds the change (safe direction) instead of throwing", () => {
    expect(checkDeterministicOverrideFloor(["a/".repeat(5000) + "x.ts"], patterns).hit).toBe(true);
  });
});
