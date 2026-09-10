// src/verify/compile.test.ts
//
// Verifies review finding #4's fix: applyEdits used to hardcode
// operation: "update_prompt_text" on every call, so compilePatch's
// WIRED_UP_OPERATIONS check could never reject anything on the repair-loop
// path. It now derives the operation from each edit's real kind and
// rejects up front if any kind present has no wired transform.
import { describe, it } from "node:test";
import { expect } from "expect";
import { applyEdits } from "./compile";
import type { ChangeEdit } from "../llm/classify";

const FILES = [{ path: "a.ts", content: "hello world" }];

describe("applyEdits operation derivation", () => {
  it("still applies a normal, wired prompt_text edit", () => {
    const edits: ChangeEdit[] = [
      { path: "a.ts", kind: "prompt_text", old_text: "hello", new_text: "goodbye" },
    ];
    const result = applyEdits(edits, FILES);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files[0]?.new_content).toBe("goodbye world");
    }
  });

  it("rejects an edit kind that has no wired Patch Compiler transform", () => {
    // Simulates a future schema addition that hasn't landed a transform yet —
    // the exact scenario the hardcoded "update_prompt_text" string used to
    // let straight through unchecked on this call path.
    const edits = [
      { path: "a.ts", kind: "future_unwired_kind", old_text: "hello", new_text: "goodbye" },
    ] as unknown as ChangeEdit[];
    const result = applyEdits(edits, FILES);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/no deterministic Patch Compiler transform wired/);
    }
  });

  it("still enforces §E-TESTLOCK on wired edits targeting a test file", () => {
    const edits: ChangeEdit[] = [
      { path: "a.test.ts", kind: "prompt_text", old_text: "hello", new_text: "goodbye" },
    ];
    const result = applyEdits(edits, [{ path: "a.test.ts", content: "hello world" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/TESTLOCK/);
    }
  });
});