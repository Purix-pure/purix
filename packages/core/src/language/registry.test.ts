// packages/core/src/language/registry.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { resolveLanguage } from "./registry";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigStore } from "../state/config";
import { clearEntitlementsCache } from "../licensing/tier";

describe("ADR-052 Registry & Language Gating", () => {
  let tmpDir: string;
  let oldCwd: string;

  const oldNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    // PURIX_DEV_TIER is only honored by getEntitlements() when
    // NODE_ENV === "test" — see the security note in tier.ts. Set it
    // explicitly here rather than relying on the test runner to set it,
    // so this suite doesn't silently break (or worse, silently start
    // testing against real Free-tier defaults) if the runner ever
    // changes how/whether it sets NODE_ENV.
    process.env.NODE_ENV = "test";
    tmpDir = mkdtempSync(join(tmpdir(), "purix-lang-test-"));
    oldCwd = process.cwd();
    process.chdir(tmpDir);
    clearEntitlementsCache(tmpDir);
  });

  afterEach(() => {
    process.chdir(oldCwd);
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.PURIX_DEV_TIER;
    process.env.NODE_ENV = oldNodeEnv;
  });

  it("allows typescript on free tier", () => {
    process.env.PURIX_DEV_TIER = "free";
    const config = createConfigStore(tmpDir);
    config.set("language", "typescript");
    const lang = resolveLanguage(undefined, tmpDir);
    expect(lang).toBe("typescript");
  });

  it("blocks python on free tier and throws Pro feature error", () => {
    process.env.PURIX_DEV_TIER = "free";
    const config = createConfigStore(tmpDir);
    config.set("language", "python");
    expect(() => resolveLanguage(undefined, tmpDir)).toThrow(/Pro feature/);
  });

  it("allows python on pro tier", () => {
    process.env.PURIX_DEV_TIER = "pro";
    const config = createConfigStore(tmpDir);
    config.set("language", "python");
    const lang = resolveLanguage(undefined, tmpDir);
    expect(lang).toBe("python");
  });

  // Added 2026-08-30 audit session, updated at beta-scope trim (Go/Ruby/Rust
  // removed from the codebase entirely — see BETA_SCOPE.md): this proves
  // resolveLanguage() never reaches an entitlement check for a language
  // whose provider isn't registered — providers.some(...) short-circuits
  // first. That composition-safety property matters independently of
  // whether any tier's allowedLanguages happens to name the language, so
  // this test keeps "rust" as a stand-in for "any id with no registered
  // provider," even though it's no longer in Pro's allowedLanguages either
  // post-trim. Confirmed by reading registry.ts's resolveLanguage(): an
  // unregistered id falls through the explicit-config branch entirely and
  // lands on auto-detection, which — finding no markers in an empty tmp
  // dir — returns the "typescript" default rather than throwing anything,
  // let alone a Pro-feature error. Asserting specifically that no
  // entitlement error is thrown is the actual point: that error shape
  // would mean the client trusted a server-issued allowedLanguages list
  // over its own registration gate, which is the bug this test exists to
  // catch — independent of which language ids are actually deleted.
  it("an unregistered language id (no provider present) never reaches the entitlement check", () => {
    process.env.PURIX_DEV_TIER = "pro";
    delete process.env.PURIX_INTERNAL_LANGUAGES;
    const config = createConfigStore(tmpDir);
    config.set("language", "rust");
    expect(() => resolveLanguage(undefined, tmpDir)).not.toThrow(/Pro feature/);
  });
});