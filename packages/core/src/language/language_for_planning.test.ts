// AI-04: languageForPlanning answers "which language should a new component use?" without asking anyone.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { languageForPlanning } from "./registry.js";
import { createConfigStore } from "../state/config.js";
import { closeDb } from "../manifest/store.js";
import { safeRmSync } from "../platform/fs_retry.js";

describe("languageForPlanning", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "purix-lang-plan-")); });
  afterEach(() => { closeDb(); safeRmSync(dir); });

  it("an empty folder with nothing configured has no language (it is never defaulted)", () => {
    expect(languageForPlanning(dir)).toEqual({ ok: false, found: [] });
  });

  it("the configured language wins, even when the folder's files point elsewhere", () => {
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    createConfigStore(dir).set("language", "python");
    expect(languageForPlanning(dir)).toEqual({ ok: true, language: "python" });
  });

  it("exactly one language in the folder's files is used when nothing is configured", () => {
    writeFileSync(join(dir, "requirements.txt"), "pytest\n");
    expect(languageForPlanning(dir)).toEqual({ ok: true, language: "python" });
  });

  it("two languages in the folder is not a guess: the caller gets both and must ask", () => {
    writeFileSync(join(dir, "requirements.txt"), "pytest\n");
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    const r = languageForPlanning(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect([...r.found].sort()).toEqual(["python", "typescript"]);
  });
});
