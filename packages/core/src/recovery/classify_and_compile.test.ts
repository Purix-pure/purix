// AI-11: one cheap re-ask when the first edits do not apply; escalation only after a second miss.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../manifest/store.js";
import { safeRmSync } from "../platform/fs_retry.js";
import { classifyAndCompile, isRetryableCompileReason } from "./classify_and_compile.js";
import type { ChangeVerdict } from "../llm/classify.js";
import type { CompileResult } from "../verify/compile.js";

const files = [{ path: "a.ts", content: "const x = 1;\n" }];
const verdict = (tag: string): ChangeVerdict => ({ reasoning: tag, operation: "update_prompt_text", contract_changing: false, confidence: 0.9, edits: [], suspicious_injected_instruction: false } as unknown as ChangeVerdict);
const ok: CompileResult = { ok: true, files: [{ path: "a.ts", new_content: "const x = 2;\n" }] };
const miss = (r = "a.ts: anchor text not found in a.ts. Nearest region: line 1"): CompileResult => ({ ok: false, reason: r });

// classifyAndCompile records a compile_retry event in the store under the working directory. Run in a throwaway folder so the
// test does not create .purix/manifest.db in the package folder it is started from.
let prevCwd: string, stateDir: string;
beforeEach(() => { prevCwd = process.cwd(); stateDir = mkdtempSync(join(tmpdir(), "purix-classify-compile-")); process.chdir(stateDir); });
afterEach(() => { closeDb(); process.chdir(prevCwd); safeRmSync(stateDir); });

describe("classifyAndCompile", () => {
  it("a bad anchor then a good reply gives a passing patch with exactly two classification calls", async () => {
    const seen: (string | undefined)[] = [];
    const r = await classifyAndCompile("c", "make it 2", files, {
      classify: async (_c, _i, _f, retry) => { seen.push(retry?.reason); return verdict(retry ? "second" : "first"); },
      compile: (v) => (v.reasoning === "first" ? miss() : ok),
    });
    assert.equal(r.compiled.ok, true);
    assert.equal(r.retried, true);
    assert.equal(r.recoveredByRetry, true);
    assert.equal(seen.length, 2);
    assert.equal(seen[0], undefined);
    assert.match(seen[1] ?? "", /anchor text not found/);
  });

  it("two bad replies end with the failure so the caller escalates exactly as before", async () => {
    let calls = 0;
    const r = await classifyAndCompile("c", "x", files, { classify: async () => { calls++; return verdict("v"); }, compile: () => miss() });
    assert.equal(calls, 2);
    assert.equal(r.compiled.ok, false);
    assert.equal(r.recoveredByRetry, false);
  });

  it("a good first reply makes one call and no retry", async () => {
    let calls = 0;
    const r = await classifyAndCompile("c", "x", files, { classify: async () => { calls++; return verdict("v"); }, compile: () => ok });
    assert.equal(calls, 1);
    assert.equal(r.retried, false);
  });

  it("an unwired operation, an empty edit list and a test-file lock are not retried", async () => {
    for (const reason of [
      'operation "unclassified" cannot be applied automatically yet, so nothing was changed',
      "classifier returned no edits to apply",
      "§E-TESTLOCK: this patch touches test file(s) a.test.ts",
    ]) {
      let calls = 0;
      const r = await classifyAndCompile("c", "x", files, { classify: async () => { calls++; return verdict("v"); }, compile: () => miss(reason) });
      assert.equal(calls, 1, reason);
      assert.equal(r.retried, false);
    }
  });

  it("a failing second call returns the first result instead of a new error", async () => {
    let calls = 0;
    const r = await classifyAndCompile("c", "x", files, {
      classify: async () => { calls++; if (calls === 2) throw new Error("provider down"); return verdict("first"); },
      compile: () => miss(),
    });
    assert.equal(r.retried, true);
    assert.equal(r.compiled.ok, false);
    assert.equal(r.verdict.reasoning, "first");
  });

  it("isRetryableCompileReason treats anchor, key and ambiguity failures as retryable", () => {
    assert.equal(isRetryableCompileReason("a.ts: anchor text not found"), true);
    assert.equal(isRetryableCompileReason('a.ts: key "x" not found in file'), true);
    assert.equal(isRetryableCompileReason("a.ts: anchor text matches 2 places"), true);
  });
});

import { compileRetryNotice } from "../llm/prompts/build.js";
describe("compileRetryNotice", () => {
  it("puts the failure in a tagged data block and cuts a very long one", () => {
    const n = compileRetryNotice({ reason: "x".repeat(5000) });
    assert.match(n, /<PURIX_FAILURE_[0-9A-F]{12}>/);
    assert.match(n, /\[cut here: 2000 more characters\]/);
    assert.match(n, /"unclassified" with empty edits/);
  });
});
