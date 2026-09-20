// packages/core/src/language/registry.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { resolveLanguage } from "./registry";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigStore } from "../state/config";
import { clearEntitlementsCache } from "../licensing/tier";

describe("ADR-017 Registry & Language Gating", () => {
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

  // Previously untested: Document 4 finding §1.1/§1.5 found a live defect
  // where sandbox.ts caught exactly this thrown error and silently
  // defaulted to "typescript" — the one outcome this throw exists to
  // prevent. That caller-side bug is fixed separately (sandbox.ts now
  // fails closed), but the throw itself had zero test coverage, so a
  // future regression here would stay invisible until it broke a caller
  // again. This locks in both halves: the throw fires, and for the right
  // reason.
  it("throws when multiple language markers are present with no explicit declaration", () => {
    process.env.PURIX_DEV_TIER = "pro";
    // A real, legitimate layout this can hit: a TS frontend and a Python
    // backend sharing one repo root with no monorepo split and no
    // explicit `language` set in .purix/config.json.
    writeFileSync(join(tmpDir, "tsconfig.json"), "{}");
    writeFileSync(join(tmpDir, "requirements.txt"), "");
    expect(() => resolveLanguage(undefined, tmpDir)).toThrow(/Multiple language markers detected/);
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