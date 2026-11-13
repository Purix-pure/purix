// languageForFile is the one rule gates use to pick a language for a file, and an unrecognized file is
// reported, never defaulted to TypeScript. Source: ADR-017 (false-pass defect); beta test report 2026-09-30.
import { describe, it } from "node:test";
import { expect } from "expect";
import { languageForFile } from "./registry";
import { reVerifyDependents } from "../verify/impact";
import { runFullAudit, formatFullAuditLines } from "../security/full_audit";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, writeManifest } from "../manifest/store";
import { safeRmSync } from "../platform/fs_retry.js";

describe("languageForFile", () => {
  it("maps TypeScript, JavaScript and Python extensions, case-insensitively", () => {
    expect(languageForFile("src/a.ts")).toBe("typescript");
    expect(languageForFile("src/a.TSX")).toBe("typescript");
    expect(languageForFile("a.mjs")).toBe("typescript");
    expect(languageForFile("pkg/mod.py")).toBe("python");
  });

  it("returns undefined for files no registered language claims", () => {
    for (const f of ["main.go", "lib.rs", "app.rb", "tsconfig.json", "README.md", "Makefile", ".gitignore"]) {
      expect(languageForFile(f)).toBeUndefined();
    }
  });
});

describe("gates refuse an unrecognized language instead of passing it", () => {
  it("cascade re-verification fails a dependent whose files no language claims", () => {
    const results = reVerifyDependents([{ component_id: "go-thing", files: ["main.go"] }]);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("fail");
    expect(results[0]!.reason).toMatch(/no registered language/);
  });

  it("the full audit reports the idiom check as skipped, not clean, for an unrecognized language", async () => {
    const cwd = process.cwd();
    const tmp = mkdtempSync(join(tmpdir(), "purix-audit-lang-"));
    process.chdir(tmp);
    try {
      writeManifest({
        component_id: "go-thing", component_type: "tool", current_version: 1, schema_version: 4,
        parts: { tools: [], config: {} }, files: ["main.go"], depends_on: [], depended_on_by: [],
        version_history: [], verification_status: "pass", last_synced_hash: null,
      } as never);
      const result = await runFullAudit(tmp);
      expect(result.idiom?.ran).toBe(false);
      const text = formatFullAuditLines(result).join("\n");
      expect(text).toContain("no registered language for");
      expect(text).not.toContain("clean — no idiom findings");
    } finally {
      closeDb();
      process.chdir(cwd);
      safeRmSync(tmp);
    }
  });
});
