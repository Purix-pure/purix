// Repository Memory notes are scrubbed of secret-shaped values before they reach the log.
// Source: beta test report 2026-09-30 (problem 2); ADR-003 (one definition of a secret), ADR-036 (shared memory).
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubFreeText } from "../security/secrets";
import { recordMemory, GLOBAL_SCOPE } from "./memory";
import { safeRmSync } from "../platform/fs_retry.js";

describe("scrubFreeText", () => {
  it("redacts a known credential format and an assignment-style password", () => {
    const { text, scrubbedCount } = scrubFreeText("deploy key AKIAIOSFODNN7EXAMPLE and password=hunter2hunter2 for staging");
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(text).not.toContain("hunter2hunter2");
    expect(text).toContain("for staging");
    expect(scrubbedCount).toBe(2);
  });

  it("leaves an ordinary convention untouched", () => {
    const note = "Use pnpm, never npm. Money is stored as integer cents. Tokens in the lexer are immutable.";
    const { text, scrubbedCount } = scrubFreeText(note);
    expect(text).toBe(note);
    expect(scrubbedCount).toBe(0);
  });

  it("is idempotent: scrubbing already-scrubbed text changes nothing", () => {
    const once = scrubFreeText("api_key: abcdef123456").text;
    const twice = scrubFreeText(once);
    expect(twice.text).toBe(once);
    expect(twice.scrubbedCount).toBe(0);
  });
});

describe("recordMemory", () => {
  let cwd: string;
  let tmp: string;
  beforeEach(() => {
    cwd = process.cwd();
    tmp = mkdtempSync(join(tmpdir(), "purix-memory-scrub-"));
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(cwd);
    safeRmSync(tmp);
  });

  it("writes the scrubbed note to the log and reports how many values it redacted", () => {
    const { scrubbedCount } = recordMemory({
      component_id: GLOBAL_SCOPE,
      kind: "decision",
      summary: "creds AKIAIOSFODNN7EXAMPLE password=hunter2hunter2",
    });
    expect(scrubbedCount).toBe(2);
    const log = readFileSync(join(tmp, ".purix", "memory", "log.jsonl"), "utf-8");
    expect(log).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(log).not.toContain("hunter2hunter2");
    expect(log).toContain("[REDACTED");
  });
});
